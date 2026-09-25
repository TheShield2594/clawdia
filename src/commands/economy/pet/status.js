'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const User = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const {
    PET_DEFINITIONS,
    STARVING_THRESHOLD,
    effectiveHunger,
    getMoodLine,
    getMoodColor,
    getPetDisplay,
    getEffectiveBonusPct,
    formatPetBonus,
    applyPetXp,
    applyHungerDecay,
    recordPetInteraction,
    recordBondCare,
    TRAIN_FOCUSES,
    TRAIN_MAX_SESSIONS,
    TRAIN_HUNGER_COST,
    canTrain,
    trainPet,
} = require('../../../services/petService');
const { generatePetSprite } = require('../../../utils/cardGenerator');
const { hungerBar, buildNavComponents, renderPetStatus, renderPetCard, bondText } = require('../../../services/petStatusView');
const { applyXpGain, announceLevelUp } = require('../../../services/levelingService');
const { isVersionError } = require('../../../utils/versionRetry');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { questRewardPayoutKey } = require('../../../utils/payoutKey');
const { ownedBy } = require('../../../utils/collectorOwner');
const { resolveUser, syncHungerAndRunaway, creditPetCare } = require('./shared');
const { revealEvolution } = require('./evolution');

const PLAY_COOLDOWN_MS     = 60 * 60 * 1000; // 1 hour
// Showcase posts a public embed, so it is rate-limited per pet to keep a
// channel from being flooded by one player mashing the button.
const SHOWCASE_COOLDOWN_MS = 10 * 60 * 1000;

/** Minutes left on a per-pet cooldown stamped at `last`, or 0 when it has run out. */
function cooldownMinutesLeft(last, cooldownMs, now = Date.now()) {
    if (!last) return 0;
    const left = cooldownMs - (now - new Date(last).getTime());
    return left > 0 ? Math.ceil(left / 60000) : 0;
}

async function executeStatus(interaction) {
    await interaction.deferReply();

    const [user, guildSettings] = await Promise.all([
        resolveUser(interaction),
        getGuildSettings(interaction.guild.id),
    ]);
    const sync = await syncHungerAndRunaway(user, interaction);
    if (sync?.saveError) {
        console.error('[pet] status save error:', sync.saveError);
        return interaction.editReply('Something went wrong updating your pets. Please try again.');
    }

    if (!user.pets || user.pets.length === 0) {
        return interaction.editReply('You have no pets. Use `/pet adopt` to get one!');
    }

    try {
        await user.save();
    } catch (err) {
        // Swallowing this meant a runaway could be announced, fail to persist, and
        // then be announced again on the next /pet status.
        console.error('[pet] status save error:', err);
        return interaction.editReply('Something went wrong updating your pets. Please try again.');
    }

    let currentIndex = 0;
    // The pet and roster size last drawn, so the disabled buttons left when the
    // window closes keep the Train counts the player last saw.
    let lastShown = user.pets[0];
    let lastTotal = user.pets.length;
    const ownerAvatarURL = interaction.user.displayAvatarURL();
    const ownerName      = interaction.member?.displayName ?? interaction.user.username;
    const guildId = interaction.guild.id;

    const reply = await interaction.editReply(
        await renderPetStatus(user.pets[currentIndex], currentIndex, user.pets.length, ownerAvatarURL, guildId, interaction.user.id, ownerName)
    );

    const collector = reply.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, "This isn't your pet."),
        time:   90_000,
    });

    collector.on('collect', async (btn) => {
        const parts  = btn.customId.split(':');
        const action = parts[0];
        const petRef = parts[3] ?? null;

        // Re-fetch user so mutations from concurrent actions are reflected
        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        // Action buttons name their pet by _id, so a roster that changed while
        // the card was open cannot redirect the click onto another pet; the
        // nav buttons only carry the index they were rendered at.
        const idx = petRef != null
            ? (freshUser?.pets ?? []).findIndex(p => String(p._id) === petRef)
            : parseInt(parts[2], 10);
        if (!freshUser || !freshUser.pets[idx]) {
            return btn.reply({ content: 'Pet not found.', flags: MessageFlags.Ephemeral });
        }

        if (action === 'pet_prev') {
            currentIndex = Math.max(0, idx - 1);
            lastShown = freshUser.pets[currentIndex];
            lastTotal = freshUser.pets.length;
            await btn.update(
                await renderPetStatus(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id, ownerName)
            );

        } else if (action === 'pet_next') {
            currentIndex = Math.min(freshUser.pets.length - 1, idx + 1);
            lastShown = freshUser.pets[currentIndex];
            lastTotal = freshUser.pets.length;
            await btn.update(
                await renderPetStatus(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id, ownerName)
            );

        } else if (action === 'pet_play') {
            const pet  = freshUser.pets[idx];
            const def  = PET_DEFINITIONS[pet.petId];
            const name = pet.name || def?.name || pet.petId;
            const playLeft = cooldownMinutesLeft(pet.lastPlay, PLAY_COOLDOWN_MS);
            if (playLeft > 0) {
                return btn.reply({ content: `🎾 **${name}** is tired from playing! Try again in **${playLeft}m**.`, flags: MessageFlags.Ephemeral });
            }

            // Player XP from Play is once an hour per player, not per pet: the
            // per-pet cooldown alone let a ten-pet roster pay ten times as much.
            // The pet still gets its own XP from every play.
            const ownerPlayedRecently = freshUser.pets.some((other, i) =>
                i !== idx && cooldownMinutesLeft(other.lastPlay, PLAY_COOLDOWN_MS) > 0);
            const rolledXp = ownerPlayedRecently ? 0 : 15 + Math.floor(Math.random() * 11); // 15–25 XP
            const { leveled, gained: xpGain } = rolledXp > 0
                ? applyXpGain(freshUser, rolledXp)
                : { leveled: false, gained: 0 };
            const petXpResult = applyPetXp(freshUser.pets[idx], 10);
            freshUser.pets[idx].lastPlay = new Date();
            recordPetInteraction(freshUser.pets[idx]);
            const bondGained = recordBondCare(freshUser.pets[idx], 'play');
            freshUser.markModified('pets');
            // A completed pet-care quest pays coins. `save()` writes `balance` as an
            // absolute `$set`, so the credit is folded out of the save and applied as
            // its own `$inc` — otherwise this write erases anything the player spent
            // between loading the document and here.
            const balanceBeforeCare = freshUser.balance ?? 0;
            await creditPetCare(interaction, freshUser, guildSettings);

            try {
                await saveWithBalanceDelta(User, freshUser, balanceBeforeCare, {
                    service: 'pet',
                    jobName: 'playQuestReward',
                    guildId: interaction.guild.id,
                    // Keyed (#873, pass 11), on the *button* interaction, not the
                    // opening command: play is a button the player can click many
                    // times, and each click is its own care event that must credit
                    // once rather than being dropped as a duplicate of the first.
                    payoutKey: questRewardPayoutKey('pet', btn.id),
                });
            } catch (err) {
                if (isVersionError(err)) {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', flags: MessageFlags.Ephemeral });
                }
                console.error('[pet] play save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', flags: MessageFlags.Ephemeral });
            }

            if (leveled) {
                announceLevelUp(freshUser, guildSettings, btn.member, btn.guild, interaction.channel).catch(() => {});
            }

            const levelNote = leveled ? `\n🎉 **Level up! You're now level ${freshUser.level}!**` : '';
            const petNote = petXpResult.evolved
                ? `\n🌟 **${name} evolved to ${getPetDisplay(freshUser.pets[idx]).titledName}!**`
                : petXpResult.leveledUp
                ? `\n📈 **${name} reached pet Level ${petXpResult.toLevel}!**`
                : '';
            const xpLine = xpGain > 0
                ? `✨ **+${xpGain} XP** for you, **+${petXpResult.gained} XP** for ${name}!`
                : `✨ **+${petXpResult.gained} XP** for ${name}! *(You've had your play XP for this hour.)*`;
            const bondNote = bondGained > 0 ? ` ❤️ **+${bondGained} bond**` : '';
            await btn.reply({ content: `🎾 You played with **${name}**! They loved it.\n${xpLine}${bondNote}${levelNote}${petNote}`, flags: MessageFlags.Ephemeral });
            await revealEvolution(btn, freshUser.pets[idx], petXpResult, { ownerId: interaction.user.id, ownerName });
            lastShown = freshUser.pets[idx];
            lastTotal = freshUser.pets.length;
            await interaction.editReply(
                await renderPetStatus(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id, ownerName)
            ).catch(() => {});

        } else if (action.startsWith('pet_train_')) {
            // Train replaced Rest (#1182): a focus, a small permanent stat
            // edge, paid for in hunger and gated by a per-pet cooldown.
            const focus = action.slice('pet_train_'.length);
            const pet   = freshUser.pets[idx];
            const def   = PET_DEFINITIONS[pet.petId];
            const name  = pet.name || def?.name || pet.petId;
            const f     = TRAIN_FOCUSES[focus];

            const check = canTrain(pet, focus);
            if (!check.ok) {
                const why = {
                    focus:    'That training focus no longer exists.',
                    maxed:    `${f?.emoji ?? '🏋️'} **${name}** has mastered ${f?.label ?? 'that'} training (${TRAIN_MAX_SESSIONS}/${TRAIN_MAX_SESSIONS}). Pick another focus.`,
                    cooldown: `🏋️ **${name}** is still sore from the last session! Train again in **${check.minutes >= 60 ? `${Math.floor(check.minutes / 60)}h ${check.minutes % 60}m` : `${check.minutes}m`}**.`,
                    vacation: `🏖️ **${name}** is on vacation. End it with \`/pet vacation off\` to train.`,
                    hungry:   `🍖 **${name}** is too hungry to train. Feed it above **${STARVING_THRESHOLD}%** first.`,
                }[check.reason];
                return btn.reply({ content: why, flags: MessageFlags.Ephemeral });
            }

            // Settle the decay owed so far, so the session spends current hunger.
            const [settled] = applyHungerDecay([freshUser.pets[idx]]);
            if (settled !== freshUser.pets[idx]) {
                freshUser.pets[idx].hunger          = settled.hunger;
                freshUser.pets[idx].lastDecayAt     = settled.lastDecayAt;
                freshUser.pets[idx].starving        = settled.starving;
                freshUser.pets[idx].starvingStartAt = settled.starvingStartAt ?? null;
                freshUser.pets[idx].bond            = settled.bond;
            }
            const trained    = trainPet(freshUser.pets[idx], focus);
            recordPetInteraction(freshUser.pets[idx]);
            const bondGained = recordBondCare(freshUser.pets[idx], 'train');
            freshUser.markModified('pets');
            // A completed pet-care quest pays coins. `save()` writes `balance` as an
            // absolute `$set`, so the credit is folded out of the save and applied as
            // its own `$inc` — otherwise this write erases anything the player spent
            // between loading the document and here.
            const balanceBeforeCare = freshUser.balance ?? 0;
            await creditPetCare(interaction, freshUser, guildSettings);

            try {
                await saveWithBalanceDelta(User, freshUser, balanceBeforeCare, {
                    service: 'pet',
                    jobName: 'trainQuestReward',
                    guildId: interaction.guild.id,
                    // Keyed on the button interaction (#873, pass 11), like play:
                    // each training click is a separate care event and credits once.
                    payoutKey: questRewardPayoutKey('pet', btn.id),
                });
            } catch (err) {
                if (isVersionError(err)) {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', flags: MessageFlags.Ephemeral });
                }
                console.error('[pet] train save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', flags: MessageFlags.Ephemeral });
            }

            const stat     = f.stat.toUpperCase();
            const critNote = f.critPerSession ? ` and **+${Math.round(trained.sessions * f.critPerSession * 1000) / 10} pts** crit` : '';
            const bondNote = bondGained > 0 ? ` ❤️ **+${bondGained} bond**` : '';
            const offNote  = trained.passiveOff
                ? `\n⚠️ That took **${name}** below ${STARVING_THRESHOLD}% hunger, so its passive is off until you feed it.`
                : '';
            await btn.reply({
                content: `${f.emoji} **${name}** trained ${f.label}! Now **+${trained.pct}% ${stat}**${critNote} `
                       + `(${trained.sessions}/${TRAIN_MAX_SESSIONS}). 🍖 −${TRAIN_HUNGER_COST} hunger → **${Math.round(trained.hunger)}%**.${bondNote}${offNote}`,
                flags: MessageFlags.Ephemeral,
            });
            lastShown = freshUser.pets[idx];
            lastTotal = freshUser.pets.length;
            await interaction.editReply(
                await renderPetStatus(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id, ownerName)
            ).catch(() => {});

        } else if (action === 'pet_showcase') {
            const pet      = freshUser.pets[idx];
            const def      = PET_DEFINITIONS[pet.petId];
            const name     = pet.name || def?.name || pet.petId;
            const hunger   = effectiveHunger(pet);

            const showLeft = cooldownMinutesLeft(pet.lastShowcase, SHOWCASE_COOLDOWN_MS);
            if (showLeft > 0) {
                return btn.reply({ content: `📷 **${name}** was just shown off! Showcase again in **${showLeft}m**.`, flags: MessageFlags.Ephemeral });
            }

            freshUser.pets[idx].lastShowcase = new Date();
            recordPetInteraction(freshUser.pets[idx]);
            freshUser.markModified('pets');

            try {
                await freshUser.save();
            } catch (err) {
                if (isVersionError(err)) {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', flags: MessageFlags.Ephemeral });
                }
                console.error('[pet] showcase save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', flags: MessageFlags.Ephemeral });
            }

            const showcaseEmbed = new EmbedBuilder()
                .setColor(getMoodColor(hunger))
                .setTitle(`${getPetDisplay(pet).emoji} ${name}`)
                .setAuthor({ name: `Owned by ${interaction.user.username}`, iconURL: ownerAvatarURL })
                .setDescription(`*${getMoodLine(pet)}*${pet.potw ? '\n🌟 **Pet of the Week**' : ''}`)
                .addFields(
                    { name: '❤️ Bond',    value: bondText(pet),                                      inline: true },
                    { name: '🍖 Hunger', value: hungerBar(hunger),                                    inline: true },
                    { name: `${hunger >= STARVING_THRESHOLD ? '✅' : '❌'} Bonus`,
                      value: formatPetBonus(def?.bonusType, getEffectiveBonusPct(pet)), inline: false },
                )
                .setFooter({ text: `${def?.name ?? pet.petId} • Use /pet status to check on yours!` })
                .setTimestamp();

            // The companion card leads the showcase, as it does /pet status. The
            // old emoji-on-a-circle sprite is only the fallback now, for when
            // the card cannot be drawn.
            let files = [];
            const card = await renderPetCard(pet, {
                kicker:      `Showcased by ${ownerName}`,
                footerLeft:  'Showcase',
                footerRight: 'Check on yours with /pet status',
            }, 'pet-showcase.png');
            if (card) {
                showcaseEmbed.setImage(`attachment://${card.name}`);
                files = [card];
            } else {
                try {
                    const spriteBuf = await generatePetSprite(pet.petId, 80, pet.evolutionStage ?? 1);
                    if (spriteBuf) {
                        showcaseEmbed.setThumbnail('attachment://pet_sprite.png');
                        files = [new AttachmentBuilder(spriteBuf, {
                            name: 'pet_sprite.png',
                            description: `Pixel-art sprite of ${name}.`,
                        })];
                    }
                } catch { /* non-critical */ }
            }

            await btn.reply({ embeds: [showcaseEmbed], files });
        }
    });

    collector.on('end', async () => {
        try {
            const shownId  = lastShown?._id;
            const disabled = buildNavComponents(interaction.user.id, currentIndex, lastTotal, shownId != null ? String(shownId) : null, lastShown)
                .map(row => ActionRowBuilder.from(row).setComponents(
                    row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
                ));
            await interaction.editReply({ components: disabled });
        } catch { /* non-critical */ }
    });
}

module.exports = { executeStatus };
