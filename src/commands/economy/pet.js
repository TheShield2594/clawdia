'use strict';

const {
    SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');
const User  = require('../../models/User');
const { attachGrind } = require('../../utils/grindProfile');
const Guild = require('../../models/Guild');
const {
    PET_DEFINITIONS,
    PERSONALITY_TRAITS,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    applyHungerDecay,
    checkRunaway,
    feedPet,
    getMoodLine,
    getMoodColor,
    heartBar,
    PET_MAX_LEVEL,
    XP_FEED_FAVORITE,
    XP_FEED_OTHER,
    XP_BATTLE_WIN,
    XP_BATTLE_LOSS,
    XP_WILD_WIN,
    XP_WILD_LOSS,
    xpForLevel,
    getPetDisplay,
    getEffectiveBonusPct,
    applyPetXp,
    getPetStats,
    simulateBattle,
    makeWildPet,
    assignPersonality,
} = require('../../services/petService');
const { generatePetSprite } = require('../../utils/cardGenerator');
const { applyXpGain, announceLevelUp } = require('../../utils/applyXpGain');
const { logTransaction } = require('../../utils/logTransaction');

const HUNGER_BAR_LENGTH = 10;
const BATTLE_COOLDOWN_MS  = 10 * 60 * 1000;    // per-pet battle cooldown
const BATTLE_MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000; // wagered battles only
const BATTLE_RAKE = 0.05;
const _delay = ms => new Promise(r => setTimeout(r, ms));

function hpBar(current, max, length = 10) {
    const filled = Math.max(0, Math.round((current / Math.max(1, max)) * length));
    return '🟩'.repeat(Math.min(filled, length)) + '⬛'.repeat(Math.max(0, length - filled));
}

// Compact battle log: highlight up to the last few exchanges of the fight.
function battleLogLines(rounds, nameA, nameB) {
    return rounds.slice(-6).map(rd => {
        const who = rd.attacker === 'a' ? nameA : nameB;
        const tgt = rd.attacker === 'a' ? nameB : nameA;
        const crit = rd.crit ? ' 💥' : '';
        return `• **${who}** hits **${tgt}** for **${rd.damage}**${crit}`;
    });
}

function hungerBar(hunger) {
    const filled = Math.round((hunger / 100) * HUNGER_BAR_LENGTH);
    const color  = hunger >= STARVING_THRESHOLD ? '🟩' : '🟥';
    return color.repeat(filled) + '⬛'.repeat(HUNGER_BAR_LENGTH - filled) + ` ${hunger}%`;
}

function getMaterialSource(user, materialId) {
    const huntMat = user.hunt?.materials?.[materialId]   ?? 0;
    const fishMat = user.fishing?.materials?.[materialId] ?? 0;
    const mineMat = user.mining?.materials?.[materialId]  ?? 0;
    return { huntMat, fishMat, mineMat, total: huntMat + fishMat + mineMat };
}

function decrementMaterial(user, materialId) {
    if ((user.hunt?.materials?.[materialId]    ?? 0) > 0) { user.hunt.materials[materialId]--;    user.markModified('hunt.materials');    return true; }
    if ((user.fishing?.materials?.[materialId] ?? 0) > 0) { user.fishing.materials[materialId]--; user.markModified('fishing.materials'); return true; }
    if ((user.mining?.materials?.[materialId]  ?? 0) > 0) { user.mining.materials[materialId]--;  user.markModified('mining.materials');  return true; }
    return false;
}

async function resolveUser(interaction) {
    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    // Feeding consumes hunt/fish/mine materials, which live on GrindProfile now
    return attachGrind(user);
}

async function syncHungerAndRunaway(user, interaction) {
    if (!user.pets || user.pets.length === 0) return;

    const decayed = applyHungerDecay(user.pets);
    const { keepPets, ranAwayPets } = checkRunaway(decayed);

    user.pets = keepPets;
    for (let i = 0; i < keepPets.length; i++) {
        const d = keepPets[i];
        user.pets[i].hunger         = d.hunger;
        user.pets[i].lastFed        = d.lastFed;
        user.pets[i].starving       = d.starving;
        if (d.starvingStartAt) user.pets[i].starvingStartAt = d.starvingStartAt;
    }
    user.markModified('pets');

    if (ranAwayPets.length > 0) {
        const names = ranAwayPets.map(p => {
            const def = PET_DEFINITIONS[p.petId];
            return `${def?.emoji ?? '🐾'} **${p.name || def?.name || p.petId}**`;
        });
        const deathMsg = ranAwayPets.length === 1
            ? `💀 **${interaction.user.username}**'s pet ${names[0]} passed away from starvation...`
            : `💀 **${interaction.user.username}**'s pets ${names.join(', ')} passed away from starvation...`;
        interaction.channel?.send({ content: deathMsg }).catch(() => {});
        await interaction.followUp({
            content: `💔 Your pet${ranAwayPets.length > 1 ? 's' : ''} died from starvation: ${names.join(', ')}\n*Use \`/pet adopt\` to get a new companion, or buy a Revive Scroll from the shop to bring them back.*`,
            ephemeral: true
        }).catch(() => {});
    }
}

// ── Pet status card helpers ───────────────────────────────────────────────────

function buildPetEmbed(pet, index, total, ownerAvatarURL) {
    const def         = PET_DEFINITIONS[pet.petId];
    const displayName = pet.name || def?.name || pet.petId;
    const bondDays    = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
    const moodLine    = getMoodLine(pet);
    const moodColor   = getMoodColor(pet.hunger);
    const bonusActive = pet.hunger >= STARVING_THRESHOLD;
    const bonusEmoji  = bonusActive ? '✅' : '❌';
    const effPct      = getEffectiveBonusPct(pet);
    const bonusLabel  = `+${effPct}% ${(def?.bonusType ?? '').replace(/_/g, ' ')}${bonusActive ? '' : ' *(inactive)*'}`;

    const lastFedMs  = pet.lastFed ? Date.now() - new Date(pet.lastFed).getTime() : 0;
    const lastFedH   = Math.floor(lastFedMs / 3600000);
    const lastFedStr = lastFedH < 1
        ? 'just now'
        : lastFedH < 24
        ? `${lastFedH}h ago`
        : `${Math.floor(lastFedH / 24)}d ago`;

    const isResting  = pet.restUntil && new Date(pet.restUntil).getTime() > Date.now();
    const potwLine   = pet.potw     ? '\n🌟 **Pet of the Week**'               : '';
    const restLine   = isResting    ? '\n🛏️ *Resting — hunger decays slower*' : '';

    const personalityDef = pet.personality ? PERSONALITY_TRAITS[pet.personality] : null;
    const personalityLine = personalityDef ? `\n${personalityDef.emoji} *${personalityDef.label}* — ${personalityDef.desc}` : '';

    const { emoji: dispEmoji } = getPetDisplay(pet);
    const level   = pet.level ?? 1;
    const stage   = pet.evolutionStage ?? 1;
    const stageStars = '⭐'.repeat(stage);
    const xpInLevel  = (pet.xp ?? 0) - xpForLevel(level);
    const xpToNext   = level >= PET_MAX_LEVEL ? 0 : xpForLevel(level + 1) - xpForLevel(level);
    const levelLine  = level >= PET_MAX_LEVEL
        ? `Lv. **${level}** (MAX) ${stageStars}`
        : `Lv. **${level}** ${stageStars} — ${xpInLevel}/${xpToNext} XP`;
    const record = `${pet.battleWins ?? 0}W / ${pet.battleLosses ?? 0}L`;

    return new EmbedBuilder()
        .setColor(moodColor)
        .setAuthor({ name: `${getPetDisplay(pet).titledName} • ${def?.name ?? pet.petId}`, iconURL: ownerAvatarURL })
        .setDescription(`${dispEmoji} *${moodLine}*${personalityLine}${potwLine}${restLine}`)
        .addFields(
            { name: '📈 Level',             value: levelLine,                            inline: false },
            { name: '❤️ Bond',              value: `${heartBar(bondDays)} ${bondDays}d`, inline: false },
            { name: '🍖 Hunger',            value: hungerBar(pet.hunger),                inline: false },
            { name: `${bonusEmoji} Bonus`,  value: bonusLabel,                           inline: true  },
            { name: '⚔️ Battle Record',     value: record,                               inline: true  },
        )
        .setFooter({ text: `Pet ${index + 1} of ${total} • Last fed ${lastFedStr}` })
        .setTimestamp();
}

function buildNavComponents(userId, index, total) {
    const rows = [];

    if (total > 1) {
        rows.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`pet_prev:${userId}:${index}`)
                    .setLabel('◀ Prev')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(index === 0),
                new ButtonBuilder()
                    .setCustomId(`pet_next:${userId}:${index}`)
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(index === total - 1),
            )
        );
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pet_play:${userId}:${index}`)     .setLabel('🎾 Play')     .setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`pet_rest:${userId}:${index}`)     .setLabel('🛏️ Rest')    .setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`pet_showcase:${userId}:${index}`) .setLabel('📷 Showcase') .setStyle(ButtonStyle.Secondary),
        )
    );

    return rows;
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function executeAdopt(interaction) {
    const petId = interaction.options.getString('type');
    const petName = interaction.options.getString('name')?.trim().slice(0, 32) ?? null;
    const def   = PET_DEFINITIONS[petId];

    if (!def) return interaction.reply({ content: 'Unknown pet type.', ephemeral: true });
    if (!def.purchasable) {
        return interaction.reply({
            content: `${def.emoji} **${def.name}** can only be obtained as a legendary drop — it's not sold in any shop!`,
            ephemeral: true
        });
    }

    const [user, guildSettings] = await Promise.all([resolveUser(interaction), Guild.findOne({ guildId: interaction.guild.id })]);

    if (guildSettings?.economy?.enabled === false) return interaction.reply({ content: 'The economy is disabled in this server.', ephemeral: true });
    if ((user.pets ?? []).some(p => p.petId === petId)) return interaction.reply({ content: `You already own a ${def.emoji} **${def.name}**!`, ephemeral: true });

    const currency = guildSettings?.economy?.currency ?? '💰';
    if (user.balance < def.cost) {
        return interaction.reply({
            content: `You need **${def.cost.toLocaleString()}** ${currency} to adopt this pet but only have **${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    const personality = assignPersonality();
    user.balance -= def.cost;
    user.pets.push({ petId, name: petName, hunger: 100, lastFed: new Date(), adoptedAt: new Date(), personality });
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — please try again.', ephemeral: true });
        throw err;
    }

    const personalityDef = PERSONALITY_TRAITS[personality];
    const displayName = petName || def.name;
    const embed = new EmbedBuilder()
        .setColor('#4caf50')
        .setTitle(`${def.emoji} New Pet Adopted!`)
        .setDescription(
            `Welcome **${displayName}** to your family! Take good care of them.\n\n` +
            `${personalityDef.emoji} **Personality: ${personalityDef.label}** — *${personalityDef.desc}*`
        )
        .addFields(
            { name: 'Passive Bonus',  value: `+${def.bonusPct}% ${def.bonusType.replace(/_/g, ' ')} (active when hunger ≥ 30%)`, inline: true },
            { name: 'Favorite Food',  value: `\`${def.favoriteMaterial}\` (restores 25 hunger)`,                                  inline: true },
            { name: 'Cost',           value: `${def.cost.toLocaleString()} ${currency}`,                                           inline: true },
        )
        .setFooter({ text: 'Use /pet status to see your pet\'s mood, or /pet feed to keep it happy!' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeStatus(interaction) {
    await interaction.deferReply();

    const [user, guildSettings] = await Promise.all([
        resolveUser(interaction),
        Guild.findOne({ guildId: interaction.guild.id }),
    ]);
    await syncHungerAndRunaway(user, interaction);

    if (!user.pets || user.pets.length === 0) {
        return interaction.editReply('You have no pets. Use `/pet adopt` to get one!');
    }

    await user.save().catch(() => {});

    let currentIndex = 0;
    const ownerAvatarURL = interaction.user.displayAvatarURL();

    const reply = await interaction.editReply({
        embeds:     [buildPetEmbed(user.pets[currentIndex], currentIndex, user.pets.length, ownerAvatarURL)],
        components: buildNavComponents(interaction.user.id, currentIndex, user.pets.length),
    });

    const collector = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time:   90_000,
    });

    collector.on('collect', async (btn) => {
        const parts  = btn.customId.split(':');
        const action = parts[0];
        const idx    = parseInt(parts[2], 10);

        // Re-fetch user so mutations from concurrent actions are reflected
        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!freshUser || !freshUser.pets[idx]) {
            return btn.reply({ content: 'Pet not found.', ephemeral: true });
        }

        if (action === 'pet_prev') {
            currentIndex = Math.max(0, idx - 1);
            await btn.update({
                embeds:     [buildPetEmbed(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, currentIndex, freshUser.pets.length),
            });

        } else if (action === 'pet_next') {
            currentIndex = Math.min(freshUser.pets.length - 1, idx + 1);
            await btn.update({
                embeds:     [buildPetEmbed(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, currentIndex, freshUser.pets.length),
            });

        } else if (action === 'pet_play') {
            const pet  = freshUser.pets[idx];
            const def  = PET_DEFINITIONS[pet.petId];
            const name = pet.name || def?.name || pet.petId;
            const now  = Date.now();
            const PLAY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

            if (pet.lastPlay && (now - new Date(pet.lastPlay).getTime()) < PLAY_COOLDOWN_MS) {
                const remaining = Math.ceil((PLAY_COOLDOWN_MS - (now - new Date(pet.lastPlay).getTime())) / 60000);
                return btn.reply({ content: `🎾 **${name}** is tired from playing! Try again in **${remaining}m**.`, ephemeral: true });
            }

            const xpGain = 15 + Math.floor(Math.random() * 11); // 15–25 XP
            const { leveled } = applyXpGain(freshUser, xpGain);
            const petXpResult = applyPetXp(freshUser.pets[idx], 10);
            freshUser.pets[idx].lastPlay           = new Date();
            freshUser.pets[idx].weeklyInteractions = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');

            try {
                await freshUser.save();
            } catch (err) {
                if (err.name === 'VersionError') {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', ephemeral: true });
                }
                console.error('[pet] play save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', ephemeral: true });
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
            await btn.reply({ content: `🎾 You played with **${name}**! They loved it.\n✨ **+${xpGain} XP** for you, **+${petXpResult.gained} XP** for ${name}!${levelNote}${petNote}`, ephemeral: true });
            await interaction.editReply({
                embeds:     [buildPetEmbed(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, idx, freshUser.pets.length),
            }).catch(() => {});

        } else if (action === 'pet_rest') {
            const pet  = freshUser.pets[idx];
            const def  = PET_DEFINITIONS[pet.petId];
            const name = pet.name || def?.name || pet.petId;

            if (pet.restUntil && new Date(pet.restUntil).getTime() > Date.now()) {
                const remaining = Math.ceil((new Date(pet.restUntil).getTime() - Date.now()) / 60000);
                return btn.reply({ content: `🛏️ **${name}** is already resting! ${remaining}m remaining.`, ephemeral: true });
            }

            freshUser.pets[idx].restUntil           = new Date(Date.now() + 2 * 60 * 60 * 1000);
            freshUser.pets[idx].weeklyInteractions  = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');

            try {
                await freshUser.save();
            } catch (err) {
                if (err.name === 'VersionError') {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', ephemeral: true });
                }
                console.error('[pet] rest save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', ephemeral: true });
            }

            await btn.reply({ content: `🛏️ **${name}** is now resting! Hunger will decay at half speed for **2 hours**.`, ephemeral: true });
            await interaction.editReply({
                embeds:     [buildPetEmbed(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, idx, freshUser.pets.length),
            }).catch(() => {});

        } else if (action === 'pet_showcase') {
            const pet      = freshUser.pets[idx];
            const def      = PET_DEFINITIONS[pet.petId];
            const name     = pet.name || def?.name || pet.petId;
            const bondDays = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);

            freshUser.pets[idx].weeklyInteractions = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');

            try {
                await freshUser.save();
            } catch (err) {
                if (err.name === 'VersionError') {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', ephemeral: true });
                }
                console.error('[pet] showcase save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', ephemeral: true });
            }

            const showcaseEmbed = new EmbedBuilder()
                .setColor(getMoodColor(pet.hunger))
                .setTitle(`${def?.emoji ?? '🐾'} ${name}`)
                .setAuthor({ name: `Owned by ${interaction.user.username}`, iconURL: ownerAvatarURL })
                .setDescription(`*${getMoodLine(pet)}*${pet.potw ? '\n🌟 **Pet of the Week**' : ''}`)
                .addFields(
                    { name: '❤️ Bond',    value: `${heartBar(bondDays)} ${bondDays}d`,               inline: true },
                    { name: '🍖 Hunger', value: hungerBar(pet.hunger),                                inline: true },
                    { name: `${pet.hunger >= STARVING_THRESHOLD ? '✅' : '❌'} Bonus`,
                      value: `+${def?.bonusPct ?? 0}% ${(def?.bonusType ?? '').replace(/_/g, ' ')}`, inline: false },
                )
                .setFooter({ text: `${def?.name ?? pet.petId} • Use /pet status to check on yours!` })
                .setTimestamp();

            // Try to attach a pet sprite
            let files = [];
            try {
                const spriteBuf = await generatePetSprite(pet.petId, 80);
                if (spriteBuf) {
                    showcaseEmbed.setThumbnail('attachment://pet_sprite.png');
                    files = [new AttachmentBuilder(spriteBuf, { name: 'pet_sprite.png' })];
                }
            } catch { /* non-critical */ }

            await btn.reply({ embeds: [showcaseEmbed], files });
        }
    });

    collector.on('end', async () => {
        try {
            const disabled = buildNavComponents(interaction.user.id, currentIndex, user.pets.length)
                .map(row => ActionRowBuilder.from(row).setComponents(
                    row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
                ));
            await interaction.editReply({ components: disabled });
        } catch { /* non-critical */ }
    });
}

async function executeFeed(interaction) {
    const materialId = interaction.options.getString('material');
    const petIndex   = interaction.options.getInteger('slot') ?? 0;

    await interaction.deferReply();

    const user = await resolveUser(interaction);
    await syncHungerAndRunaway(user, interaction);

    if (!user.pets || user.pets.length === 0) return interaction.editReply('You have no pets to feed!');
    if (petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.editReply(`Invalid pet slot. You have ${user.pets.length} pet(s) (slots 0–${user.pets.length - 1}).`);
    }

    const { total } = getMaterialSource(user, materialId);
    if (total < 1) return interaction.editReply(`You don't have any \`${materialId}\` to feed your pet with.`);

    const pet    = user.pets[petIndex];
    const def    = PET_DEFINITIONS[pet.petId];
    const result = feedPet(pet, materialId);
    if (!result) return interaction.editReply('Could not feed that pet.');

    decrementMaterial(user, materialId);
    user.pets[petIndex].hunger          = result.hunger;
    user.pets[petIndex].lastFed         = new Date();
    user.pets[petIndex].starving        = result.hunger < STARVING_THRESHOLD;
    user.pets[petIndex].weeklyInteractions = (user.pets[petIndex].weeklyInteractions || 0) + 1;
    if (result.hunger >= STARVING_THRESHOLD) user.pets[petIndex].starvingStartAt = null;
    const feedXp = applyPetXp(user.pets[petIndex], result.isFavorite ? XP_FEED_FAVORITE : XP_FEED_OTHER);
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.editReply('Edit conflict — please try again.');
        throw err;
    }

    const displayName  = pet.name || def?.name || pet.petId;
    const favoriteNote = result.isFavorite ? ' *(favorite food — +25 hunger!)*' : ' *(not favorite — +10 hunger)*';
    const progressNote = feedXp.evolved
        ? `\n🌟 **${displayName} evolved!** Now an **${getPetDisplay(user.pets[petIndex]).titledName}** (Stage ${feedXp.toStage})!`
        : feedXp.leveledUp
        ? `\n🎉 **${displayName} reached Level ${feedXp.toLevel}!**`
        : '';

    const embed = new EmbedBuilder()
        .setColor(result.hunger >= STARVING_THRESHOLD ? '#4caf50' : '#ff5722')
        .setTitle(`${getPetDisplay(user.pets[petIndex]).emoji} ${displayName} fed!`)
        .setDescription(`✨ **+${feedXp.gained} pet XP**${progressNote}`)
        .addFields(
            { name: 'Food',   value: `\`${materialId}\`${favoriteNote}`,   inline: true  },
            { name: 'Hunger', value: hungerBar(result.hunger),              inline: false },
            { name: 'Bonus',  value: result.hunger >= STARVING_THRESHOLD ? '✅ Active' : '❌ Still inactive (need ≥ 30%)', inline: true },
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function executeRelease(interaction) {
    const petIndex = interaction.options.getInteger('slot');
    const user     = await resolveUser(interaction);

    if (!user.pets || petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.reply({ content: 'Invalid pet slot.', ephemeral: true });
    }

    const pet  = user.pets[petIndex];
    const def  = PET_DEFINITIONS[pet.petId];
    const name = pet.name || def?.name || pet.petId;

    user.pets.splice(petIndex, 1);
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', ephemeral: true });
        throw err;
    }

    return interaction.reply({ content: `${def?.emoji ?? '🐾'} **${name}** has been released. Goodbye, friend!`, ephemeral: true });
}

async function executeRename(interaction) {
    const petIndex = interaction.options.getInteger('slot');
    const newName  = interaction.options.getString('name').trim().slice(0, 32);
    const user     = await resolveUser(interaction);

    if (!user.pets || petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.reply({ content: 'Invalid pet slot.', ephemeral: true });
    }

    user.pets[petIndex].name = newName;
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', ephemeral: true });
        throw err;
    }

    const def = PET_DEFINITIONS[user.pets[petIndex].petId];
    return interaction.reply({ content: `${def?.emoji ?? '🐾'} Pet renamed to **${newName}**!`, ephemeral: true });
}

// ── Battle ──────────────────────────────────────────────────────────────────

function petUsable(pet) {
    if (!pet) return { ok: false, reason: 'no pet in that slot' };
    if (pet.hunger < STARVING_THRESHOLD) return { ok: false, reason: 'too hungry to fight (feed it first)' };
    return { ok: true };
}

function onBattleCooldown(pet) {
    return pet?.lastBattle && Date.now() - new Date(pet.lastBattle).getTime() < BATTLE_COOLDOWN_MS;
}

// Snapshot the combat-relevant fields so result rendering reflects PRE-battle
// state even after applyPetXp mutates the live pet (level/stage/xp).
function petSnapshot(pet) {
    return { petId: pet.petId, name: pet.name, personality: pet.personality, level: pet.level ?? 1, evolutionStage: pet.evolutionStage ?? 1 };
}

// petA/petB must be PRE-battle snapshots: result.finalHpA/B and the HP-bar
// denominators (max HP) are computed from pre-battle stats, so rendering from
// post-XP pets would mismatch the bars and show the wrong level.
function battleResultEmbed({ color, title, petA, petB, result, currency, payoutLine, xpLineA, xpLineB }) {
    const da = getPetDisplay(petA), db = getPetDisplay(petB);
    const sa = getPetStats(petA),   sb = getPetStats(petB);
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `${da.emoji} **${da.titledName}** (Lv.${petA.level ?? 1})  🆚  ${db.emoji} **${db.titledName}** (Lv.${petB.level ?? 1})\n\n` +
            `${da.emoji} ${hpBar(result.finalHpA, sa.hp)} ${Math.max(0, result.finalHpA)}/${sa.hp}\n` +
            `${db.emoji} ${hpBar(result.finalHpB, sb.hp)} ${Math.max(0, result.finalHpB)}/${sb.hp}\n\n` +
            battleLogLines(result.rounds, da.titledName, db.titledName).join('\n') +
            (payoutLine ? `\n\n${payoutLine}` : '') +
            (xpLineA ? `\n${xpLineA}` : '') +
            (xpLineB ? `\n${xpLineB}` : '')
        )
        .setTimestamp();
}

function petXpLine(name, res) {
    if (res.evolved)   return `🌟 **${name}** evolved to Stage ${res.toStage}! (+${res.gained} XP)`;
    if (res.leveledUp) return `📈 **${name}** reached Level ${res.toLevel}! (+${res.gained} XP)`;
    return `✨ **${name}** +${res.gained} XP`;
}

async function executeBattle(interaction) {
    const opponent = interaction.options.getUser('opponent');
    const slot     = interaction.options.getInteger('slot') ?? 0;
    const bet      = interaction.options.getInteger('bet') ?? 0;

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled in this server.', ephemeral: true });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await resolveUser(interaction);
    await syncHungerAndRunaway(user, interaction);
    await user.save().catch(() => {});

    const myPet = user.pets?.[slot];
    const usable = petUsable(myPet);
    if (!usable.ok) {
        return interaction.reply({ content: `Your pet in slot ${slot} is ${usable.reason}.`, ephemeral: true });
    }

    // Per-pet cooldown
    if (myPet.lastBattle && Date.now() - new Date(myPet.lastBattle).getTime() < BATTLE_COOLDOWN_MS) {
        const mins = Math.ceil((BATTLE_COOLDOWN_MS - (Date.now() - new Date(myPet.lastBattle).getTime())) / 60000);
        return interaction.reply({ content: `${getPetDisplay(myPet).emoji} **${getPetDisplay(myPet).titledName}** is recovering — ready to battle again in **${mins}m**.`, ephemeral: true });
    }

    if (!opponent) {
        if (bet > 0) {
            return interaction.reply({ content: "You can't wager against a wild pet — challenge a member instead.", ephemeral: true });
        }
        return wildBattle(interaction, user, slot, currency, guildSettings);
    }

    // ── PvP setup ──
    if (bet > 0) {
        if (opponent.id === interaction.user.id) return interaction.reply({ content: "You can't wager against yourself.", ephemeral: true });
        if (opponent.bot) return interaction.reply({ content: "Bots don't keep pets.", ephemeral: true });
        const maxBet = guildSettings?.economy?.duelMaxBet ?? 10_000;
        if (bet > maxBet) return interaction.reply({ content: `The maximum battle wager here is **${maxBet.toLocaleString()}** coins.`, ephemeral: true });
        if (Date.now() - interaction.user.createdTimestamp < BATTLE_MIN_ACCOUNT_AGE_MS
            || Date.now() - opponent.createdTimestamp < BATTLE_MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({ content: 'Both accounts must be at least 7 days old for wagered battles.', ephemeral: true });
        }
    } else if (opponent.id === interaction.user.id || opponent.bot) {
        return interaction.reply({ content: 'Pick another member to battle.', ephemeral: true });
    }

    const oppUser = await User.findOne({ userId: opponent.id, guildId: interaction.guild.id });
    const oppPet  = oppUser?.pets?.find(p => p.hunger >= STARVING_THRESHOLD);
    if (!oppPet) {
        return interaction.reply({ content: `${opponent.username} has no battle-ready pet (they need a fed pet).`, ephemeral: true });
    }

    return pvpBattle(interaction, { user, myPet, slot, opponent, oppUser, oppPet, bet, currency, guildSettings });
}

async function wildBattle(interaction, user, slot, currency, guildSettings) {
    await interaction.deferReply();
    const myPet  = user.pets[slot];
    const wild   = makeWildPet(myPet.level ?? 1);
    const mySnap = petSnapshot(myPet); // pre-XP snapshot for consistent result rendering
    const result = simulateBattle(myPet, wild);
    const won    = result.winner === 'a';

    const da = getPetDisplay(mySnap), db = getPetDisplay(wild);
    const intro = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle('⚔️ A wild challenger appears!')
        .setDescription(`${da.emoji} **${da.titledName}** squares off against ${db.emoji} **${db.name}** (Lv.${wild.level})…`);
    await interaction.editReply({ embeds: [intro] });
    await _delay(1500);

    const xpRes = applyPetXp(myPet, won ? XP_WILD_WIN : XP_WILD_LOSS);
    myPet.lastBattle  = new Date();
    if (won) myPet.battleWins   = (myPet.battleWins ?? 0) + 1;
    else     myPet.battleLosses = (myPet.battleLosses ?? 0) + 1;
    user.markModified('pets');
    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.editReply({ content: 'Edit conflict — please try again.', embeds: [] });
        throw err;
    }

    return interaction.editReply({
        embeds: [battleResultEmbed({
            color: won ? '#2ecc71' : '#e74c3c',
            title: won ? `🏆 ${da.titledName} won the wild battle!` : `💀 ${da.titledName} was beaten back…`,
            petA: mySnap, petB: wild, result, currency,
            payoutLine: null,
            xpLineA: petXpLine(da.titledName, xpRes),
        })],
    });
}

async function pvpBattle(interaction, ctx) {
    const { myPet, slot, opponent, bet, currency, guildSettings } = ctx;
    const guildId = interaction.guild.id;
    const da = getPetDisplay(myPet);

    const acceptId  = `petb_accept_${interaction.id}`;
    const declineId = `petb_decline_${interaction.id}`;
    const challengeEmbed = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle('⚔️ Pet Battle Challenge!')
        .setDescription(
            `${da.emoji} **${interaction.member?.displayName ?? interaction.user.username}'s ${da.titledName}** (Lv.${myPet.level ?? 1}) ` +
            `challenges ${opponent} to a battle!` +
            (bet > 0 ? `\n\n💰 Wager: **${currency}${bet.toLocaleString()}** each — winner takes the pot.` : '\n\n*Friendly match — pet XP only.*')
        )
        .setFooter({ text: 'Accept within 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('⚔️ Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('🏳️ Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ content: `${opponent}`, embeds: [challengeEmbed], components: [row] });
    const msg = await interaction.fetchReply();

    const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === opponent.id && [acceptId, declineId].includes(i.customId),
        max: 1, time: 60_000,
    });

    collector.on('collect', async i => {
        if (i.customId === declineId) {
            return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#95a5a6').setDescription(`${opponent.username} declined the battle.`)], components: [] }).catch(() => {});
        }

        // Escrow wagers atomically (challenger then opponent), refund on shortfall
        if (bet > 0) {
            const ch = await User.findOneAndUpdate({ userId: interaction.user.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } });
            if (!ch) return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${interaction.user.username} can no longer cover the wager.`)], components: [] }).catch(() => {});
            const op = await User.findOneAndUpdate({ userId: opponent.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } });
            if (!op) {
                await User.updateOne({ userId: interaction.user.id, guildId }, { $inc: { balance: bet } });
                return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${opponent.username} can't cover the wager.`)], components: [] }).catch(() => {});
            }
        }

        await i.deferUpdate().catch(() => {});

        // Re-fetch both fighters fresh so concurrent feeds/battles are reflected
        const [chUser, opUser] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId }),
            User.findOne({ userId: opponent.id, guildId }),
        ]);
        const aPet = chUser?.pets?.[slot];
        const bPet = opUser?.pets?.find(p => p.hunger >= STARVING_THRESHOLD);

        // If a fighter is gone, no longer battle-ready, or went on cooldown
        // between the challenge and acceptance, refund and abort.
        const refundAndCancel = (reason) => {
            if (bet > 0) {
                User.updateOne({ userId: interaction.user.id, guildId }, { $inc: { balance: bet } }).catch(() => {});
                User.updateOne({ userId: opponent.id, guildId }, { $inc: { balance: bet } }).catch(() => {});
            }
            return interaction.editReply({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${reason} — the battle was cancelled${bet > 0 ? ' and any wagers refunded' : ''}.`)], components: [] }).catch(() => {});
        };
        if (!aPet || !bPet) return refundAndCancel('A pet is no longer available');
        if (!petUsable(aPet).ok || !petUsable(bPet).ok) return refundAndCancel('A pet is no longer battle-ready');
        if (onBattleCooldown(aPet) || onBattleCooldown(bPet)) return refundAndCancel('A pet is now recovering from a recent battle');

        // Pre-battle snapshots for consistent result rendering (applyPetXp below mutates levels)
        const aSnap = petSnapshot(aPet), bSnap = petSnapshot(bPet);
        const result = simulateBattle(aPet, bPet);
        const aWon   = result.winner === 'a';

        const intro = new EmbedBuilder()
            .setColor('#9b59b6').setTitle('⚔️ Battle commencing…')
            .setDescription(`${getPetDisplay(aPet).emoji} **${getPetDisplay(aPet).titledName}**  🆚  ${getPetDisplay(bPet).emoji} **${getPetDisplay(bPet).titledName}**`);
        await interaction.editReply({ content: null, embeds: [intro], components: [] }).catch(() => {});
        await _delay(1800);

        // XP + records
        const aXp = applyPetXp(aPet, aWon ? XP_BATTLE_WIN : XP_BATTLE_LOSS);
        const bXp = applyPetXp(bPet, aWon ? XP_BATTLE_LOSS : XP_BATTLE_WIN);
        if (aWon) { aPet.battleWins = (aPet.battleWins ?? 0) + 1; bPet.battleLosses = (bPet.battleLosses ?? 0) + 1; }
        else      { bPet.battleWins = (bPet.battleWins ?? 0) + 1; aPet.battleLosses = (aPet.battleLosses ?? 0) + 1; }
        aPet.lastBattle = new Date(); bPet.lastBattle = new Date();
        chUser.markModified('pets'); opUser.markModified('pets');

        // Payout
        let payoutLine = null;
        if (bet > 0) {
            const pot      = bet * 2;
            const houseCut = guildSettings?.economy?.duelHouseCut ?? BATTLE_RAKE;
            const payout   = pot - Math.floor(pot * houseCut);
            const winnerId = aWon ? interaction.user.id : opponent.id;
            const loserId  = aWon ? opponent.id : interaction.user.id;
            // chUser/opUser balances are post-escrow; loser keeps theirs, winner gains the pot.
            const loserBalance  = (aWon ? opUser : chUser).balance ?? 0;
            const winnerBalance = ((aWon ? chUser : opUser).balance ?? 0) + payout;
            await User.updateOne({ userId: winnerId, guildId }, { $inc: { balance: payout } });
            logTransaction({ userId: winnerId, guildId, type: 'pet_battle', amount: payout - bet, balance: winnerBalance, relatedUserId: loserId, note: 'Pet battle win' });
            logTransaction({ userId: loserId,  guildId, type: 'pet_battle', amount: -bet, balance: loserBalance, relatedUserId: winnerId, note: 'Pet battle loss' });
            const winnerName = aWon ? interaction.user.username : opponent.username;
            payoutLine = `🏆 **${winnerName}** takes the pot: **+${currency}${(payout - bet).toLocaleString()}**` +
                (houseCut > 0 ? `  *(house kept ${Math.round(houseCut * 100)}%)*` : '');
        }

        try {
            await Promise.all([chUser.save(), opUser.save()]);
        } catch (err) {
            console.error('[pet battle] save error:', err);
        }

        const da2 = getPetDisplay(aSnap), db2 = getPetDisplay(bSnap);
        const winnerDisp = aWon ? da2 : db2;
        return interaction.editReply({
            content: null,
            embeds: [battleResultEmbed({
                color: '#f1c40f',
                title: `🏆 ${winnerDisp.titledName} wins the battle!`,
                petA: aSnap, petB: bSnap, result, currency,
                payoutLine,
                xpLineA: petXpLine(da2.titledName, aXp),
                xpLineB: petXpLine(db2.titledName, bXp),
            })],
            components: [],
        }).catch(() => {});
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            interaction.editReply({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#95a5a6').setDescription(`${opponent.username} didn't respond in time.`)], components: [] }).catch(() => {});
        }
    });
}

async function executeList(interaction) {
    const lines = Object.values(PET_DEFINITIONS)
        .filter(d => d.purchasable)
        .map(d => `${d.emoji} **${d.name}** — ${d.cost.toLocaleString()} coins\nBonus: +${d.bonusPct}% ${d.bonusType.replace(/_/g, ' ')}  |  Fave food: \`${d.favoriteMaterial}\``);

    const embed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🐾 Pet Shop')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Rare pets (Eagle, Shark, Crystal Fox) drop from legendary hunt/fish/mine' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeLeaderboard(interaction) {
    await interaction.deferReply();

    const top = await User.aggregate([
        { $match: { guildId: interaction.guild.id, 'pets.0': { $exists: true } } },
        { $unwind: '$pets' },
        { $addFields: {
            bondDays: { $toInt: { $divide: [{ $subtract: [new Date(), '$pets.adoptedAt'] }, 86400000] } }
        }},
        { $sort: { bondDays: -1 } },
        { $limit: 10 },
        { $project: { _id: 0, userId: 1, pet: '$pets', bondDays: 1 } },
    ]);

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = top.map((e, i) => {
        const def  = PET_DEFINITIONS[e.pet.petId];
        const name = e.pet.name || def?.name || e.pet.petId;
        const rank = medals[i] ?? `${i + 1}.`;
        const potw = e.pet.potw ? ' 🌟' : '';
        return `${rank} ${def?.emoji ?? '🐾'} **${name}**${potw} — ${heartBar(e.bondDays)} ${e.bondDays}d — <@${e.userId}>`;
    });

    const embed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🐾 Pet Leaderboard — Most Bonded Pets')
        .setDescription(lines.length > 0 ? lines.join('\n') : '*No pets in this server yet!*')
        .setFooter({ text: 'Pet of the Week is chosen weekly by most interactions • 🌟 = current POTW' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('pet')
        .setDescription('Manage your pets.')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('adopt')
                .setDescription('Adopt a pet from the shop.')
                .addStringOption(opt =>
                    opt.setName('type').setDescription('Pet type to adopt').setRequired(true)
                        .addChoices(
                            { name: '🐶 Dog (2,000)',    value: 'dog'  },
                            { name: '🐱 Cat (2,000)',    value: 'cat'  },
                            { name: '🐦 Bird (3,000)',   value: 'bird' },
                            { name: '🐠 Fish (3,000)',   value: 'fish' },
                            { name: '🦊 Fox (5,000)',    value: 'fox'  },
                            { name: '🐺 Wolf (8,000)',   value: 'wolf' },
                        )
                )
                .addStringOption(opt =>
                    opt.setName('name').setDescription('Give your pet a name right away (optional, max 32 chars)').setRequired(false).setMaxLength(32)
                )
        )
        .addSubcommand(sub => sub.setName('status').setDescription('View your pets and their mood.'))
        .addSubcommand(sub =>
            sub.setName('feed')
                .setDescription('Feed a pet using a hunt/fish/mine material.')
                .addStringOption(opt =>
                    opt.setName('material').setDescription('Material to feed (e.g. rabbits_foot, fish_scale)').setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt.setName('slot').setDescription('Pet slot number (0 = first pet, default 0)').setRequired(false).setMinValue(0).setMaxValue(9)
                )
        )
        .addSubcommand(sub =>
            sub.setName('release')
                .setDescription('Release a pet permanently.')
                .addIntegerOption(opt =>
                    opt.setName('slot').setDescription('Pet slot number (0 = first pet)').setRequired(true).setMinValue(0).setMaxValue(9)
                )
        )
        .addSubcommand(sub =>
            sub.setName('rename')
                .setDescription('Give your pet a custom name.')
                .addIntegerOption(opt =>
                    opt.setName('slot').setDescription('Pet slot number (0 = first pet)').setRequired(true).setMinValue(0).setMaxValue(9)
                )
                .addStringOption(opt =>
                    opt.setName('name').setDescription('New name (max 32 chars)').setRequired(true).setMaxLength(32)
                )
        )
        .addSubcommand(sub => sub.setName('list').setDescription('View all available pets in the shop.'))
        .addSubcommand(sub => sub.setName('leaderboard').setDescription('View the top bonded pets in this server.'))
        .addSubcommand(sub =>
            sub.setName('battle')
                .setDescription('Battle a wild pet for XP, or challenge another member (optionally for coins).')
                .addUserOption(opt =>
                    opt.setName('opponent').setDescription('Member to challenge (leave empty to fight a wild pet)').setRequired(false))
                .addIntegerOption(opt =>
                    opt.setName('slot').setDescription('Which of your pets fights (0 = first, default 0)').setRequired(false).setMinValue(0).setMaxValue(9))
                .addIntegerOption(opt =>
                    opt.setName('bet').setDescription('Coins to wager (requires an opponent)').setRequired(false).setMinValue(1))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'adopt')       return await executeAdopt(interaction);
            if (sub === 'status')      return await executeStatus(interaction);
            if (sub === 'feed')        return await executeFeed(interaction);
            if (sub === 'release')     return await executeRelease(interaction);
            if (sub === 'rename')      return await executeRename(interaction);
            if (sub === 'list')        return await executeList(interaction);
            if (sub === 'leaderboard') return await executeLeaderboard(interaction);
            if (sub === 'battle')      return await executeBattle(interaction);
        } catch (err) {
            console.error('[pet] error:', err);
            const msg = { content: 'Something went wrong with the pet command.', ephemeral: true };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
