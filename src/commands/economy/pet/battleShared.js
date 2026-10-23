'use strict';

// What the wild and the member battle share: the readiness checks, the
// pre-battle snapshot and the pieces of the result embed. The two flows live
// in battle.js and pvp.js.

const { EmbedBuilder } = require('discord.js');
const {
    isPetActive, isOnVacation, getPetDisplay, getPetStats, getSpeciesMove,
} = require('../../../services/petService');

const BATTLE_COOLDOWN_MS = 10 * 60 * 1000; // per-pet battle cooldown

function hpBar(current, max, length = 10) {
    const filled = Math.max(0, Math.round((current / Math.max(1, max)) * length));
    return '🟩'.repeat(Math.min(filled, length)) + '⬛'.repeat(Math.max(0, length - filled));
}

// Lines kept in the battle log, and how many of the last exchanges always show.
const BATTLE_LOG_MAX  = 8;
const BATTLE_LOG_TAIL = 4;

/** One exchange as a log line, with the signature moves that fired in it. */
function exchangeLine(rd, nameOf) {
    const who = nameOf(rd.attacker);
    const tgt = nameOf(rd.attacker === 'a' ? 'b' : 'a');
    const hit = rd.missed
        ? `• **${who}** misses **${tgt}**`
        : `• **${who}** hits **${tgt}** for **${rd.damage}**${rd.crit ? ' 💥' : ''}`;
    // One mention per move per round, e.g. Crystal Ward soaking a double hit.
    const moves = [...new Map((rd.moves ?? []).map(m => [`${m.side}:${m.name}`, m])).values()]
        .map(m => ` · 🌀 ${nameOf(m.side)}'s *${m.name}*`);
    return hit + moves.join('');
}

/**
 * Compact battle log, at most BATTLE_LOG_MAX lines: the last few exchanges of
 * the fight, plus earlier rounds where a signature move fired (#1183), so a
 * Pack Howl on round two is not cut off by the rounds after it. In a long
 * fight with many moves, the earliest move rounds are the ones dropped.
 */
function battleLogLines(rounds, nameA, nameB) {
    const nameOf = side => (side === 'a' ? nameA : nameB);
    return rounds
        .map((rd, i) => ({ rd, i }))
        .filter(({ rd, i }) => i >= rounds.length - BATTLE_LOG_TAIL || rd.moves?.length)
        .slice(-BATTLE_LOG_MAX)
        .map(({ rd }) => exchangeLine(rd, nameOf));
}

function petUsable(pet) {
    if (!pet) return { ok: false, reason: 'no pet in that slot' };
    if (isOnVacation(pet)) return { ok: false, reason: 'on vacation — end it with `/pet vacation off` to battle' };
    if (!isPetActive(pet)) return { ok: false, reason: 'too hungry to fight (feed it first)' };
    return { ok: true };
}

function onBattleCooldown(pet) {
    return pet?.lastBattle && Date.now() - new Date(pet.lastBattle).getTime() < BATTLE_COOLDOWN_MS;
}

// Snapshot the combat-relevant fields so result rendering reflects PRE-battle
// state even after applyPetXp mutates the live pet (level/stage/xp).
function petSnapshot(pet) {
    const training = pet.training ? { ...(pet.training.toObject ? pet.training.toObject() : pet.training) } : undefined;
    return { petId: pet.petId, name: pet.name, personality: pet.personality, level: pet.level ?? 1, evolutionStage: pet.evolutionStage ?? 1, training };
}

/** "Pack Howl" in italics after a name, for the intro lines, or ''. */
function moveTag(petId) {
    const move = getSpeciesMove(petId);
    return move ? ` · 🌀 *${move.name}*` : '';
}

/** "**player**'s " before a pet's name, or '' when there is no owner to name. */
function ownerPrefix(name) {
    return name ? `**${name}**'s ` : '';
}

/** Both fighters' HP bars, from the stats they fought with. */
function hpLines(petA, petB, hpA, hpB) {
    const da = getPetDisplay(petA), db = getPetDisplay(petB);
    const sa = getPetStats(petA),   sb = getPetStats(petB);
    return `${da.emoji} ${hpBar(hpA, sa.hp)} ${Math.max(0, hpA)}/${sa.hp}\n`
         + `${db.emoji} ${hpBar(hpB, sb.hp)} ${Math.max(0, hpB)}/${sb.hp}`;
}

/** "player's 🐶 **Rex** (Lv.5)  🆚  rival's 🐱 **Tom** (Lv.5)". */
function matchupLine(petA, petB, ownerA, ownerB) {
    const da = getPetDisplay(petA), db = getPetDisplay(petB);
    return `${ownerPrefix(ownerA)}${da.emoji} **${da.titledName}** (Lv.${petA.level ?? 1})  🆚  `
         + `${ownerPrefix(ownerB)}${db.emoji} **${db.titledName}** (Lv.${petB.level ?? 1})`;
}

// petA/petB must be PRE-battle snapshots: result.finalHpA/B and the HP-bar
// denominators (max HP) are computed from pre-battle stats, so rendering from
// post-XP pets would mismatch the bars and show the wrong level. `ownerA` and
// `ownerB` name both owners in a member battle (#1184).
function battleResultEmbed({ color, title, petA, petB, result, ownerA, ownerB, extraLines = [], payoutLine, xpLineA, xpLineB }) {
    const da = getPetDisplay(petA), db = getPetDisplay(petB);
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `${matchupLine(petA, petB, ownerA, ownerB)}\n\n` +
            `${hpLines(petA, petB, result.finalHpA, result.finalHpB)}\n\n` +
            battleLogLines(result.rounds, da.titledName, db.titledName).join('\n') +
            extraLines.filter(Boolean).map(l => `\n${l}`).join('') +
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

module.exports = {
    BATTLE_COOLDOWN_MS,
    hpBar,
    exchangeLine,
    battleLogLines,
    petUsable,
    onBattleCooldown,
    petSnapshot,
    moveTag,
    ownerPrefix,
    hpLines,
    matchupLine,
    battleResultEmbed,
    petXpLine,
};
