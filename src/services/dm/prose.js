'use strict';

/**
 * Reading HP changes back out of the model's prose — the old mechanism, kept as
 * the fallback for the turn where the new one produced nothing (#837).
 *
 * The structured `EFFECTS:` block in `./effects.js` is how the campaign learns
 * what happened now, and it is better in every way that matters: it covers the
 * whole party rather than the acting character, it carries items, and it does
 * not depend on the model happening to phrase a wound the way a regex expects.
 *
 * This stays because "the model ignored the format" is a real outcome, not a
 * hypothetical one. A small self-hosted model — which is exactly who the Ollama
 * provider is for — will narrate a perfectly good scene and forget the trailing
 * line, and a campaign that silently stops tracking HP for such a guild would
 * be a worse bot than the one this replaced. So a turn with no block at all
 * falls back to reading the sentence, and a turn with a block trusts the block
 * completely — including a block that deliberately says nothing happened.
 *
 * Its known limits are why it is not the mechanism any more: only the acting
 * character can be hurt by it, and only in the phrasings below.
 */

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Another creature entering the sentence. Two kinds: an article and the word
// after it ("the goblin", "a skeleton"), and — because a party member is named
// rather than introduced — the other characters in this session by name. Without
// the second kind, "Aric swings wide and Lyra takes 30 damage" charged Aric for
// Lyra's wound, since the only subject the sentence marked was his.
const ARTICLE_SUBJECT = '\\b(?:the|a|an|another|each|every)\\s+\\S+';

function otherSubjectPattern(otherNames = []) {
    const named = otherNames
        .filter(name => typeof name === 'string' && name.trim())
        .map(name => escapeRegex(name.trim()));
    return new RegExp([ARTICLE_SUBJECT, ...named].join('|'), 'gi');
}

/** The last index at which `pattern` matches before `limit`, or -1. */
function lastMatchBefore(pattern, text, limit) {
    let last = -1;
    for (const match of text.matchAll(pattern)) {
        if (match.index >= limit) break;
        last = match.index;
    }
    return last;
}

/**
 * A number the narration attributes to this character, or null.
 *
 * The scoping is what stops "your blow lands and the goblin takes 12 damage"
 * taking twelve HP off the player who swung: an unscoped regex reads any
 * "takes N damage" as theirs, and a scope that only asks whether the player is
 * mentioned somewhere earlier in the sentence reads that one as theirs too,
 * which is the same bug with more steps.
 *
 * So the subject nearest the verb wins. Whichever of "this character" and "some
 * other creature" appears last before "takes 12 damage" is who it happened to —
 * which is how the sentence reads to a person, and it holds for both orders
 * ("the goblin lunges and Aric takes 15 damage" is still Aric's).
 *
 * @param {string} narrative the model's prose
 * @param {string} namePattern the character's name, already regex-escaped
 * @param {string} verbs alternation of the verbs to look for, e.g. `takes?`
 * @param {string} unit what is being counted, e.g. `damage`
 * @param {string[]} [otherNames] the other characters in the session, who are
 *        subjects in their own right — what happens to them is not this
 *        character's, however early in the sentence this character is named
 */
function amountFor(narrative, namePattern, verbs, unit, otherNames = []) {
    const clause = new RegExp(`\\b(?:${verbs})\\s+(\\d+)\\s+${unit}\\b`, 'gi');
    // "you"/"your" as well as the name: the model writes to the acting player in
    // the second person about as often as it uses their character's name.
    const scope = new RegExp(`${namePattern}|\\byour?\\b`, 'gi');

    const others = otherSubjectPattern(otherNames);

    for (const match of narrative.matchAll(clause)) {
        const mine = lastMatchBefore(scope, narrative, match.index);
        if (mine === -1) continue;
        if (mine > lastMatchBefore(others, narrative, match.index)) {
            return parseInt(match[1], 10);
        }
    }
    return null;
}

/**
 * What the prose says happened to the acting character, as effects.
 *
 * Answering in the same vocabulary as the structured block means there is one
 * application path rather than two: whatever this returns goes through
 * `applyEffects` exactly as a model-authored block would, and the clamping,
 * the class HP ceiling and the fallen-character log are the same code.
 *
 * @param {string} narrative the model's prose, block already stripped
 * @param {object} player the acting character
 * @param {object[]} party every character in the session
 * @returns {object[]} zero, one or two effects, always targeting `player`
 */
function proseEffects(narrative, player, party = []) {
    const text = typeof narrative === 'string' ? narrative : '';
    const namePattern = escapeRegex(String(player?.name ?? ''));
    const otherNames = party
        .filter(p => p.userId !== player?.userId)
        .map(p => p.name);

    const effects = [];
    const damage = amountFor(text, namePattern, 'takes?|suffers?', 'damage', otherNames);
    if (damage !== null) effects.push({ type: 'damage', target: player.name, amount: damage });

    const healed = amountFor(text, namePattern, 'heals?|recovers?|regains?', 'hp', otherNames);
    if (healed !== null) effects.push({ type: 'heal', target: player.name, amount: healed });

    return effects;
}

module.exports = { proseEffects, amountFor, escapeRegex };
