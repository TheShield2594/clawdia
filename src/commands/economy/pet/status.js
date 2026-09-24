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
    heartBar,
    getPetDisplay,
    getEffectiveBonusPct,
    applyPetXp,
    applyHungerDecay,
    recordPetInteraction,
    REST_DURATION_MS,
} = require('../../../services/petService');
const { generatePetSprite } = require('../../../utils/cardGenerator');
const { hungerBar, buildNavComponents, renderPetStatus } = require('../../../services/petStatusView');
const { applyXpGain, announceLevelUp } = require('../../../services/levelingService');
const { isVersionError } = require('../../../utils/versionRetry');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { questRewardPayoutKey } = require('../../../utils/payoutKey');
const { ownedBy } = require('../../../utils/collectorOwner');
const { resolveUser, syncHungerAndRunaway, creditPetCare } = require('./shared');

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
    const ownerAvatarURL = interaction.user.displayAvatarURL();
    const guildId = interaction.guild.id;

    const reply = await interaction.editReply(
        await renderPetStatus(user.pets[currentIndex], currentIndex, user.pets.length, ownerAvatarURL, guildId, interaction.user.id)
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
            await btn.update(
                await renderPetStatus(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id)
            );

        } else if (action === 'pet_next') {
            currentIndex = Math.min(freshUser.pets.length - 1, idx + 1);
            await btn.update(
                await renderPetStatus(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id)
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
            await btn.reply({ content: `🎾 You played with **${name}**! They loved it.\n${xpLine}${levelNote}${petNote}`, flags: MessageFlags.Ephemeral });
            await interaction.editReply(
                await renderPetStatus(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id)
            ).catch(() => {});

        } else if (action === 'pet_rest') {
            const pet  = freshUser.pets[idx];
            const def  = PET_DEFINITIONS[pet.petId];
            const name = pet.name || def?.name || pet.petId;

            if (pet.restUntil && new Date(pet.restUntil).getTime() > Date.now()) {
                const remaining = Math.ceil((new Date(pet.restUntil).getTime() - Date.now()) / 60000);
                return btn.reply({ content: `🛏️ **${name}** is already resting! ${remaining}m remaining.`, flags: MessageFlags.Ephemeral });
            }

            // Settle the decay owed so far before replacing restUntil. Decay only
            // knows about the latest rest window, so overwriting it with decay
            // still pending charged any earlier, unsettled rest at full speed.
            const [settled] = applyHungerDecay([freshUser.pets[idx]]);
            if (settled !== freshUser.pets[idx]) {
                freshUser.pets[idx].hunger          = settled.hunger;
                freshUser.pets[idx].lastDecayAt     = settled.lastDecayAt;
                freshUser.pets[idx].starving        = settled.starving;
                freshUser.pets[idx].starvingStartAt = settled.starvingStartAt ?? null;
            }
            freshUser.pets[idx].restUntil = new Date(Date.now() + REST_DURATION_MS);
            recordPetInteraction(freshUser.pets[idx]);
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
                    jobName: 'restQuestReward',
                    guildId: interaction.guild.id,
                    // Keyed on the button interaction (#873, pass 11), like play:
                    // each rest click is a separate care event and credits once.
                    payoutKey: questRewardPayoutKey('pet', btn.id),
                });
            } catch (err) {
                if (isVersionError(err)) {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', flags: MessageFlags.Ephemeral });
                }
                console.error('[pet] rest save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', flags: MessageFlags.Ephemeral });
            }

            await btn.reply({ content: `🛏️ **${name}** is now resting! Hunger will decay at half speed for **2 hours**.`, flags: MessageFlags.Ephemeral });
            await interaction.editReply(
                await renderPetStatus(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL, guildId, interaction.user.id)
            ).catch(() => {});

        } else if (action === 'pet_showcase') {
            const pet      = freshUser.pets[idx];
            const def      = PET_DEFINITIONS[pet.petId];
            const name     = pet.name || def?.name || pet.petId;
            const bondDays = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
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
                .setTitle(`${def?.emoji ?? '🐾'} ${name}`)
                .setAuthor({ name: `Owned by ${interaction.user.username}`, iconURL: ownerAvatarURL })
                .setDescription(`*${getMoodLine(pet)}*${pet.potw ? '\n🌟 **Pet of the Week**' : ''}`)
                .addFields(
                    { name: '❤️ Bond',    value: `${heartBar(bondDays)} ${bondDays}d`,               inline: true },
                    { name: '🍖 Hunger', value: hungerBar(hunger),                                    inline: true },
                    { name: `${hunger >= STARVING_THRESHOLD ? '✅' : '❌'} Bonus`,
                      value: `+${getEffectiveBonusPct(pet)}% ${(def?.bonusType ?? '').replace(/_/g, ' ')}`, inline: false },
                )
                .setFooter({ text: `${def?.name ?? pet.petId} • Use /pet status to check on yours!` })
                .setTimestamp();

            // Try to attach a pet sprite
            let files = [];
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

            await btn.reply({ embeds: [showcaseEmbed], files });
        }
    });

    collector.on('end', async () => {
        try {
            const shownId  = user.pets[currentIndex]?._id;
            const disabled = buildNavComponents(interaction.user.id, currentIndex, user.pets.length, shownId != null ? String(shownId) : null)
                .map(row => ActionRowBuilder.from(row).setComponents(
                    row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
                ));
            await interaction.editReply({ components: disabled });
        } catch { /* non-critical */ }
    });
}

module.exports = { executeStatus };
