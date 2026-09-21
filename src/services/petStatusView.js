'use strict';

// The /pet status card — the embed one pet renders into, its nav buttons, and
// the portrait art (issue #1082) that rides with them. Split out of pet.js so
// the command file stays under its size cap and so the "view" (how a pet looks
// on screen) sits apart from the command flow (what each subcommand does).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    PET_DEFINITIONS,
    PERSONALITY_TRAITS,
    STARVING_THRESHOLD,
    effectiveHunger,
    getMoodLine,
    getMoodColor,
    heartBar,
    PET_MAX_LEVEL,
    xpForLevel,
    getPetDisplay,
    getEffectiveBonusPct,
} = require('./petService');
const { MATERIAL_RARITY } = require('../data/materialRarity');
const { getItemImageAttachment } = require('../utils/itemImageHelper');
const { petItemId } = require('../data/activityItems');

const HUNGER_BAR_LENGTH = 10;

// Hunger is stored at full precision (decay is continuous), so round for display —
// otherwise the bar reads "80.41666666666666%".
function hungerBar(hunger) {
    const pct    = Math.round(Math.min(100, Math.max(0, Number(hunger) || 0)));
    const filled = Math.round((pct / 100) * HUNGER_BAR_LENGTH);
    const color  = pct >= STARVING_THRESHOLD ? '🟩' : '🟥';
    return color.repeat(filled) + '⬛'.repeat(HUNGER_BAR_LENGTH - filled) + ` ${pct}%`;
}

/**
 * The bundled portrait for a pet species as a Discord attachment, or null when
 * none ships for it. `getItemImageAttachment` serves the baked default set
 * first (issue #1082), so this returns the catalogue art wherever it exists and
 * null otherwise — every caller falls back to the species emoji already in the
 * embed, so a species with no baked art degrades gracefully.
 */
function petArt(petId, guildId, label) {
    return getItemImageAttachment(petItemId(petId), guildId, { label }).catch(() => null);
}

/**
 * The status-card embed for one pet — mood, level, bond, hunger, bonus, battle
 * record and favourite food — coloured by its mood. `thumbUrl`, when given, sets
 * the portrait thumbnail (an `attachment://` url); the species emoji in the
 * description is the fallback when none ships.
 */
function buildPetEmbed(pet, index, total, ownerAvatarURL, thumbUrl = null) {
    const def         = PET_DEFINITIONS[pet.petId];
    const bondDays    = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
    const hunger      = effectiveHunger(pet);
    const moodLine    = getMoodLine(pet);
    const moodColor   = getMoodColor(hunger);
    const bonusActive = hunger >= STARVING_THRESHOLD;
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

    // Where to actually get the +25 food — previously only /pet list mentioned it.
    const favMeta      = def ? MATERIAL_RARITY[def.favoriteMaterial] : null;
    const favouriteLine = def
        ? `${favMeta?.emoji ?? '🍖'} \`${def.favoriteMaterial}\` — from **/${def.materialSource}** *(+25 hunger, bonus XP)*`
        : '—';

    const embed = new EmbedBuilder()
        .setColor(moodColor)
        .setAuthor({ name: `${getPetDisplay(pet).titledName} • ${def?.name ?? pet.petId}`, iconURL: ownerAvatarURL })
        .setDescription(`${dispEmoji} *${moodLine}*${personalityLine}${potwLine}${restLine}`)
        .addFields(
            { name: '📈 Level',             value: levelLine,                            inline: false },
            { name: '❤️ Bond',              value: `${heartBar(bondDays)} ${bondDays}d`, inline: false },
            { name: '🍖 Hunger',            value: hungerBar(hunger),                    inline: false },
            { name: `${bonusEmoji} Bonus`,  value: bonusLabel,                           inline: true  },
            { name: '⚔️ Battle Record',     value: record,                               inline: true  },
            { name: '🍗 Favourite Food',    value: favouriteLine,                        inline: false },
        )
        .setFooter({ text: `Pet ${index + 1} of ${total} • Last fed ${lastFedStr}` })
        .setTimestamp();
    if (thumbUrl) embed.setThumbnail(thumbUrl);
    return embed;
}

/**
 * The button rows under a status card: a prev/next nav row (only when the owner
 * has more than one pet) and the play/rest/showcase action row. `userId` is
 * baked into every custom id so the collector can reject other users' clicks.
 */
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

/**
 * The full status-card payload for one pet, art included. Returns the shape both
 * the first render and every button re-render pass to editReply/update, with
 * `attachments: []` so a re-render swapping to a different pet's portrait drops
 * the previous attachment rather than leaving it dangling below the embed.
 */
async function renderPetStatus(pet, index, total, ownerAvatarURL, guildId, userId) {
    const def   = PET_DEFINITIONS[pet.petId];
    const label = pet.name || def?.name || pet.petId;
    const art   = await petArt(pet.petId, guildId, label);
    return {
        embeds:      [buildPetEmbed(pet, index, total, ownerAvatarURL, art?.url ?? null)],
        components:  buildNavComponents(userId, index, total),
        files:       art ? [art.attachment] : [],
        attachments: [],
    };
}

module.exports = { HUNGER_BAR_LENGTH, hungerBar, petArt, buildPetEmbed, buildNavComponents, renderPetStatus };
