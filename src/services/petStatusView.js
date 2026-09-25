'use strict';

// The /pet status card — the embed one pet renders into, its nav buttons, and
// the portrait art (issue #1082) that rides with them. Split out of pet.js so
// the command file stays under its size cap and so the "view" (how a pet looks
// on screen) sits apart from the command flow (what each subcommand does).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const {
    PET_DEFINITIONS,
    PERSONALITY_TRAITS,
    PERSONALITY_COMBAT,
    STARVING_THRESHOLD,
    effectiveHunger,
    getMoodLine,
    getMoodAction,
    getMoodColor,
    getPetStats,
    heartBar,
    BOND_MAX,
    effectiveBond,
    bondTierFor,
    getBondTier,
    PET_MAX_LEVEL,
    getMoodBand,
    xpForLevel,
    getPetDisplay,
    getEffectiveBonusPct,
    formatPetBonus,
    petBonusParts,
    TRAIN_FOCUSES,
    TRAIN_MAX_SESSIONS,
    trainingSessions,
    trainingPct,
    getSpeciesMove,
    isOnVacation,
    isPetActive,
} = require('./petService');
const { MATERIAL_RARITY } = require('../data/materialRarity');
const { getItemImageAttachment } = require('../utils/itemImageHelper');
const { petItemId } = require('../data/activityItems');
const { createPetStatusCard } = require('../utils/petStatusCard');

const STAGE_NAMES = { 1: 'Stage 1', 2: 'Stage 2 - Seasoned', 3: 'Stage 3 - Apex' };

const HUNGER_BAR_LENGTH = 10;

// Hunger is stored at full precision (decay is continuous), so round for display —
// otherwise the bar reads "80.41666666666666%".
function hungerBar(hunger) {
    const pct    = Math.round(Math.min(100, Math.max(0, Number(hunger) || 0)));
    const filled = Math.round((pct / 100) * HUNGER_BAR_LENGTH);
    // Same bands as the mood and the card colour: green while comfortable,
    // orange once it is asking, red once the bonus is off.
    const band   = getMoodBand(pct);
    const color  = band === 'concerning' ? '🟥' : band === 'pleading' ? '🟧' : '🟩';
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
    const hunger      = effectiveHunger(pet);
    const moodLine    = getMoodLine(pet);
    const moodColor   = getMoodColor(hunger);
    // Off on vacation too, not only when hungry (#1181).
    const bonusActive = isPetActive(pet);
    const bonusEmoji  = bonusActive ? '✅' : '❌';
    const effPct      = getEffectiveBonusPct(pet);
    const bonusLabel  = `${formatPetBonus(def?.bonusType, effPct)}${bonusActive ? '' : ' *(inactive)*'}`;

    const lastFedMs  = pet.lastFed ? Date.now() - new Date(pet.lastFed).getTime() : 0;
    const lastFedH   = Math.floor(lastFedMs / 3600000);
    const lastFedStr = lastFedH < 1
        ? 'just now'
        : lastFedH < 24
        ? `${lastFedH}h ago`
        : `${Math.floor(lastFedH / 24)}d ago`;

    const away       = vacationLine(pet);
    const potwLine   = (pet.potw ? '\n🌟 **Pet of the Week**' : '') + (away ? `\n${away}` : '');
    const move       = getSpeciesMove(pet.petId);

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
        .setDescription(`${dispEmoji} *${moodLine}*${personalityLine}${potwLine}`)
        .addFields(
            { name: '📈 Level',             value: levelLine,                            inline: false },
            { name: '❤️ Bond',              value: bondText(pet),                        inline: false },
            { name: '🍖 Hunger',            value: hungerBar(hunger),                    inline: false },
            { name: `${bonusEmoji} Bonus`,  value: bonusLabel,                           inline: true  },
            { name: '⚔️ Battle Record',     value: record,                               inline: true  },
            { name: '🌀 Signature Move',    value: move ? `**${move.name}** — ${move.desc}` : '—', inline: false },
            { name: '🏋️ Training',          value: trainingText(pet),                    inline: false },
            { name: '🍗 Favourite Food',    value: favouriteLine,                        inline: false },
        )
        .setFooter({ text: `Pet ${index + 1} of ${total} • Last fed ${lastFedStr}` })
        .setTimestamp();
    if (thumbUrl) embed.setThumbnail(thumbUrl);
    return embed;
}

/**
 * The button rows under a status card: a prev/next nav row (only when the owner
 * has more than one pet), the play/showcase row and the three training focuses
 * (#1182, which replaced Rest). `userId` is baked into every custom id so the
 * collector can reject other users' clicks. Given the pet, each training button
 * shows its sessions and is disabled once that focus is maxed.
 *
 * The action buttons also carry the pet's stable `_id`: the card stays open for
 * 90s, and a release or a starvation death in that window shifts every later
 * index, which used to land a Play/Train/Showcase click on a different pet.
 */
function buildNavComponents(userId, index, total, petId = null, pet = null) {
    const ref = petId != null ? `${index}:${petId}` : `${index}`;
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
            new ButtonBuilder().setCustomId(`pet_play:${userId}:${ref}`)     .setLabel('🎾 Play')     .setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`pet_showcase:${userId}:${ref}`) .setLabel('📷 Showcase') .setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            Object.values(TRAIN_FOCUSES).map((f) => {
                const done = pet ? trainingSessions(pet, f.focus) : null;
                return new ButtonBuilder()
                    .setCustomId(`pet_train_${f.focus}:${userId}:${ref}`)
                    .setLabel(`${f.emoji} Train ${f.label}${done != null ? ` ${done}/${TRAIN_MAX_SESSIONS}` : ''}`)
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(done != null && done >= TRAIN_MAX_SESSIONS);
            }),
        ),
    );

    return rows;
}

/**
 * A pet's training as one line, e.g. "💪 Power +2% ATK (5/10) · 🛡️ Guard — ·
 * 💨 Agility +9% SPD, +1.5 pts crit (3/10)", or a prompt when it has none.
 */
function trainingText(pet) {
    const parts = Object.values(TRAIN_FOCUSES).map((f) => {
        const n = trainingSessions(pet, f.focus);
        if (n === 0) return `${f.emoji} ${f.label} —`;
        const crit = f.critPerSession ? `, +${Math.round(n * f.critPerSession * 1000) / 10} pts crit` : '';
        return `${f.emoji} ${f.label} +${trainingPct(n, f.focus)}% ${f.stat.toUpperCase()}${crit} (${n}/${TRAIN_MAX_SESSIONS})`;
    });
    return parts.every(p => p.endsWith('—'))
        ? 'Untrained — use the Train buttons below'
        : parts.join(' · ');
}

// ─── The companion card ──────────────────────────────────────────────────────

/**
 * A pet's bond as one line: hearts, the tier's title and the number, e.g.
 * "❤️❤️❤️❤️❤️🖤🖤🖤 **Devoted** · 62/100". Bond is earned by care, not age (#1186).
 */
function bondText(pet, now = Date.now()) {
    const bond = effectiveBond(pet, now);
    return `${heartBar(bond)} **${bondTierFor(bond).title}** · ${Math.floor(bond)}/${BOND_MAX}`;
}

/** "🏖️ On vacation until …" while a pet's hunger is paused (#1181), else null. */
function vacationLine(pet, now = Date.now()) {
    if (!isOnVacation(pet, now)) return null;
    const until = Math.floor(new Date(pet.vacationUntil).getTime() / 1000);
    return `🏖️ **On vacation** until <t:${until}:f> — hunger paused, passive and battles off`;
}

function lastFedText(pet, now = Date.now()) {
    const h = Math.floor((pet.lastFed ? now - new Date(pet.lastFed).getTime() : 0) / 3600000);
    return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/**
 * Everything the companion card draws for one pet, read off the document the
 * same way the embed text is, so the two cannot disagree.
 *
 * @param {object} pet
 * @param {object} ctx
 * @param {string} ctx.kicker        the line over the name
 * @param {?string} [ctx.footerLeft]
 * @param {?string} [ctx.footerRight]
 */
function petCardOptions(pet, { kicker, footerLeft = null, footerRight = null }, now = Date.now()) {
    const def     = PET_DEFINITIONS[pet.petId];
    const display = getPetDisplay(pet);
    const hunger  = effectiveHunger(pet, now);
    const level   = pet.level ?? 1;
    const maxed   = level >= PET_MAX_LEVEL;
    const stage   = pet.evolutionStage ?? 1;
    const boosted = Object.entries(PERSONALITY_COMBAT[pet.personality] ?? {})
        .filter(([, v]) => v > 0).map(([k]) => k);
    // Training shows on the stat tile it raises (#1182), as "+4%" in the
    // corner; Agility also raises crit, so its crit tile says so too.
    const trained = {};
    for (const f of Object.values(TRAIN_FOCUSES)) {
        const n = trainingSessions(pet, f.focus);
        if (n === 0) continue;
        trained[f.stat] = `+${trainingPct(n, f.focus)}%`;
        if (f.critPerSession) trained.crit = `+${Math.round(n * f.critPerSession * 1000) / 10} pts`;
    }
    const move = getSpeciesMove(pet.petId);
    // Clamped: stored XP that ran past its level (older data, a manual edit)
    // would otherwise print "1,340 / 380 XP".
    const xpToNext  = maxed ? 0 : xpForLevel(level + 1) - xpForLevel(level);
    const xpInLevel = maxed ? 0 : Math.min(xpToNext, Math.max(0, (pet.xp ?? 0) - xpForLevel(level)));
    return {
        petId:       pet.petId,
        iconId:      petItemId(pet.petId),
        kicker,
        titledName:  display.titledName,
        species:     def?.name ?? pet.petId,
        personality: PERSONALITY_TRAITS[pet.personality]?.label ?? null,
        rare:        def ? !def.purchasable : false,
        potw:        !!pet.potw,
        ladderTitle: pet.ladderTitle ?? null,
        stage,
        stageName:   STAGE_NAMES[stage] ?? `Stage ${stage}`,
        level,
        maxed,
        xpInLevel,
        xpToNext,
        hunger,
        threshold:   STARVING_THRESHOLD,
        moodColor:   getMoodColor(hunger),
        bond:        Math.floor(effectiveBond(pet, now)),
        bondMax:     BOND_MAX,
        bondTitle:   getBondTier(pet, now).title,
        bondFrame:   getBondTier(pet, now).frame,
        bonus:       def ? {
            pct:    getEffectiveBonusPct(pet, now),
            ...petBonusParts(def.bonusType),
            active: isPetActive(pet, now),
        } : null,
        stats:       getPetStats(pet),
        boosted,
        trained,
        move:        move ? move.name : null,
        record: {
            wins:      pet.battleWins   ?? 0,
            losses:    pet.battleLosses ?? 0,
            pvpWins:   pet.pvpWins      ?? 0,
            pvpLosses: pet.pvpLosses    ?? 0,
        },
        action:      getMoodAction(pet, now),
        quote:       getMoodLine(pet, now),
        footerLeft,
        footerRight,
    };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The card's alt text: what it shows, in words, for anyone who cannot see it. */
function cardAltText(o) {
    const bonus = o.bonus ? `, passive +${o.bonus.pct}${o.bonus.unit ?? '%'} ${o.bonus.label} ${o.bonus.active ? 'active' : 'inactive'}` : '';
    const move  = o.move ? `, signature move ${o.move}` : '';
    return `Companion card for ${o.titledName}, a level ${o.level} ${o.personality ? `${o.personality.toLowerCase()} ` : ''}`
        + `${o.species}${o.potw ? ', Pet of the Week' : ''}${o.ladderTitle ? `, ${o.ladderTitle}` : ''}: hunger ${Math.round(o.hunger)}%, bond ${o.bondTitle ? `${o.bondTitle.toLowerCase()} ` : ''}${o.bond}/${o.bondMax ?? 100}${bonus}${move}, `
        + `record ${plural(o.record.wins, 'win')} and ${plural(o.record.losses, 'loss', 'losses')}.`;
}

/**
 * Renders the companion card as an attachment, or null when drawing fails —
 * the caller then shows the text-only card, so a canvas problem never takes
 * /pet status down with it.
 */
async function renderPetCard(pet, ctx, fileName = 'pet-card.png') {
    const opts = petCardOptions(pet, ctx);
    try {
        const buffer = await createPetStatusCard(opts);
        return new AttachmentBuilder(buffer, { name: fileName, description: cardAltText(opts).slice(0, 1024) });
    } catch (err) {
        console.error('[pet] companion card render failed:', err);
        return null;
    }
}

/**
 * The embed that goes under the companion card. The card carries the layout;
 * this keeps every number in text as well (the card-family contract) in two
 * short lines, plus the one thing the card leaves out — where the favourite
 * food comes from.
 */
function buildPetCardEmbed(pet, index, total, ownerAvatarURL, cardName, now = Date.now()) {
    const def     = PET_DEFINITIONS[pet.petId];
    const display = getPetDisplay(pet);
    const hunger  = effectiveHunger(pet, now);
    const level   = pet.level ?? 1;
    const action  = getMoodAction(pet, now);
    const bonusOn = isPetActive(pet, now);
    // On vacation the passive is off whatever the hunger, so "feed above 30%" would mislead.
    const bonusHint = bonusOn || isOnVacation(pet, now) ? '' : ` *(feed above ${STARVING_THRESHOLD}%)*`;
    const xpNote  = level >= PET_MAX_LEVEL
        ? 'MAX'
        : `${(pet.xp ?? 0) - xpForLevel(level)}/${xpForLevel(level + 1) - xpForLevel(level)} XP`;
    const personalityDef = pet.personality ? PERSONALITY_TRAITS[pet.personality] : null;
    const move = getSpeciesMove(pet.petId);

    const lines = [
        `${display.emoji} ${action ? `*${action}* — ` : ''}${getMoodLine(pet, now)}`,
        personalityDef ? `${personalityDef.emoji} **${personalityDef.label}** — ${personalityDef.desc}` : null,
        pet.potw ? '🌟 **Pet of the Week**' : null,
        pet.ladderTitle ? `🏅 **${pet.ladderTitle}**` : null,
        vacationLine(pet, now),
        '',
        `📈 Lv **${level}** (${xpNote}) · 🍖 **${Math.round(hunger)}%** · ❤️ **${getBondTier(pet, now).title}** ${Math.floor(effectiveBond(pet, now))}/${BOND_MAX} · `
            + `${bonusOn ? '✅' : '❌'} ${formatPetBonus(def?.bonusType, getEffectiveBonusPct(pet, now))}`
            + bonusHint,
        `⚔️ ${pet.battleWins ?? 0}W / ${pet.battleLosses ?? 0}L · PvP ${pet.pvpWins ?? 0}-${pet.pvpLosses ?? 0}`
            + `${move ? ` · 🌀 **${move.name}** — ${move.desc}` : ''}`,
        `🏋️ ${trainingText(pet)}`,
    ];
    if (def) {
        const favMeta = MATERIAL_RARITY[def.favoriteMaterial];
        lines.push(`${favMeta?.emoji ?? '🍗'} Favourite food \`${def.favoriteMaterial}\` — from **/${def.materialSource}** *(+25 hunger, bonus XP)*`);
    }

    return new EmbedBuilder()
        .setColor(getMoodColor(hunger))
        .setAuthor({ name: `${display.titledName} • ${def?.name ?? pet.petId}`, iconURL: ownerAvatarURL })
        .setDescription(lines.filter(l => l !== null).join('\n'))
        .setImage(`attachment://${cardName}`)
        .setFooter({ text: `Pet ${index + 1} of ${total} • Last fed ${lastFedText(pet, now)}` })
        .setTimestamp();
}

/**
 * The full status payload for one pet. Leads with the companion card; when the
 * card cannot be drawn it falls back to the text card with the portrait as its
 * thumbnail. Returns the shape both the first render and every button
 * re-render pass to editReply/update, with `attachments: []` so a re-render
 * swapping to a different pet drops the previous file rather than leaving it
 * dangling below the embed.
 */
async function renderPetStatus(pet, index, total, ownerAvatarURL, guildId, userId, ownerName = null) {
    const components = buildNavComponents(userId, index, total, pet._id != null ? String(pet._id) : null, pet);
    const card = await renderPetCard(pet, {
        kicker:      ownerName ? `${ownerName}'s companion` : 'Companion',
        footerLeft:  `Pet ${index + 1} of ${total}`,
        footerRight: `Last fed ${lastFedText(pet)}`,
    });
    if (card) {
        return {
            embeds:      [buildPetCardEmbed(pet, index, total, ownerAvatarURL, card.name)],
            components,
            files:       [card],
            attachments: [],
        };
    }

    const def   = PET_DEFINITIONS[pet.petId];
    const label = pet.name || def?.name || pet.petId;
    const art   = await petArt(pet.petId, guildId, label);
    return {
        embeds:      [buildPetEmbed(pet, index, total, ownerAvatarURL, art?.url ?? null)],
        components,
        files:       art ? [art.attachment] : [],
        attachments: [],
    };
}

module.exports = {
    HUNGER_BAR_LENGTH, hungerBar, petArt, buildPetEmbed, buildNavComponents, renderPetStatus,
    petCardOptions, renderPetCard, buildPetCardEmbed, cardAltText, bondText, trainingText,
};
