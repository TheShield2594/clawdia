'use strict';

/**
 * What the Dungeon Master's narration actually did, as data (#837).
 *
 * The campaign used to learn its own state by reading the model's prose with a
 * regex: find "takes 15 damage" near enough to the acting player's name and
 * subtract fifteen. That worked for the one sentence it was written for and
 * failed everywhere else.
 *
 *   - Phrasing decided whether anything happened at all. "Aric takes 15 damage"
 *     landed; "Aric loses 15 hit points", "the blow costs Aric 15", "Aric is
 *     down to 40" did not, silently, and the party went on fighting with HP the
 *     story no longer agreed with.
 *   - Only the *acting* player could be hurt. Every clause the regex scoped to
 *     somebody else was discarded rather than applied to them, so a dragon's
 *     breath weapon hit exactly one character and a party wipe — the one ending
 *     the game is built around — essentially could not happen.
 *   - Items were never read at all. `add_item` had no equivalent, so the sword
 *     the story handed you stayed in the story.
 *
 * So the model is asked to say what happened, in a block, and this parses it.
 * The prose is still the prose; the mechanical effects ride underneath it and
 * are the only thing the database believes. Same shape as the in-channel
 * ACTION protocol in services/ai/actions.js — a trailing marker line holding
 * JSON — for the same reason it exists there: it is the one channel that works
 * on every provider and every route, including the ones where the bot never
 * sees a tool call.
 *
 * Everything here is total and defensive. A model will eventually send
 * `{"type":"damage","target":"the goblin","amount":"a lot"}`, and the answer to
 * that is to drop the effect, not to throw inside somebody's turn.
 */

// A caller-supplied maximum, because a character's ceiling is their class's.
const DEFAULT_MAX_HP = 100;

// Bounds on one effect. A model that has decided the trap does nine thousand
// damage is not describing a trap, and a 400-character item name is not an
// item — both are clamped rather than refused, so a plausible scene with one
// silly number in it still resolves.
const MAX_AMOUNT = 500;
const MAX_ITEM_LENGTH = 60;
const MAX_SCENE_LENGTH = 300;

// Per turn. Enough for a breath weapon across a full party plus loot; short
// enough that a runaway block cannot rewrite the whole session.
const MAX_EFFECTS = 16;

// Per character. An inventory is a list somebody reads in an embed field.
const MAX_INVENTORY = 12;

// Words that mean "everyone", so an area effect does not need one entry per
// character — which is exactly the shape a model gets wrong.
const PARTY_TARGETS = new Set(['party', 'all', 'everyone', 'everybody', 'the party', 'all players']);

const EFFECT_TYPES = new Set(['damage', 'heal', 'add_item', 'remove_item', 'set_scene']);

/**
 * Pull the trailing `EFFECTS:[…]` block off the model's reply.
 *
 * Returns the prose with the block removed and the effects it carried. A block
 * that is absent, malformed, or not an array yields no effects and the text
 * untouched — the caller decides what "the model said nothing mechanical"
 * means, and for the DM it means falling back to reading the prose.
 *
 * @param {string} text the model's reply
 * @returns {{cleanText: string, effects: object[], hadBlock: boolean}}
 */
function extractEffects(text) {
    const source = typeof text === 'string' ? text : '';

    // Anchored to the end, like `extractAction`: the block is the last thing in
    // the reply.
    const match = source.match(/\nEFFECTS:(\[.*\])\s*$/s);
    if (match) {
        const cleanText = source.slice(0, source.lastIndexOf('\nEFFECTS:')).trimEnd();
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed)) {
                return { cleanText, effects: parsed.slice(0, MAX_EFFECTS), hadBlock: true };
            }
        } catch {
            // Falls through to the salvage below, which cuts the same text and
            // answers "no block" — so a turn whose JSON is unreadable is a turn
            // the prose reader gets to look at, rather than one where nothing
            // happened at all.
        }
    }

    // Whatever is left of a block that did not parse. The common cause is the
    // model running out of `maxTokens` mid-array, and the important thing about
    // it is that `{"type":"damage","targ` must not be shown to the party as part
    // of the scene. Recognised by the opening bracket rather than by position,
    // because a truncated block has no closing one to anchor on.
    const at = source.lastIndexOf('\nEFFECTS:');
    if (at !== -1 && source.slice(at + '\nEFFECTS:'.length).trimStart().startsWith('[')) {
        return { cleanText: source.slice(0, at).trimEnd(), effects: [], hadBlock: false };
    }

    return { cleanText: source, effects: [], hadBlock: false };
}

function clampAmount(value) {
    const amount = Math.floor(Number(value));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return Math.min(MAX_AMOUNT, amount);
}

function cleanItem(value) {
    if (typeof value !== 'string') return null;
    const item = value.trim().replace(/\s+/g, ' ');
    if (!item) return null;
    return item.slice(0, MAX_ITEM_LENGTH);
}

/**
 * Which characters an effect's `target` names.
 *
 * Matched on the character name the player chose at `/dm join`, case- and
 * space-insensitively, because the model will write "aric" and "Aric " and mean
 * the same person. An unrecognised target matches nobody and the effect is
 * dropped — the alternative, guessing, is how "the goblin takes 12 damage"
 * became the player's problem in the first place.
 */
function resolveTargets(target, players) {
    const raw = typeof target === 'string' ? target.trim() : '';
    if (!raw) return [];

    const key = raw.toLowerCase();
    if (PARTY_TARGETS.has(key)) return players.filter(p => p.hp > 0);

    return players.filter(p => String(p.name || '').trim().toLowerCase() === key);
}

/**
 * Apply a turn's effects to a party, without touching the database.
 *
 * Pure on purpose: the caller holds the turn lock and writes the result in one
 * update, and a function that only maps a party and a list of effects to a new
 * party is a function the tests can ask about a dragon killing four people.
 *
 * @param {object[]} players the session's characters
 * @param {object[]} effects what `extractEffects` returned
 * @param {object} [options]
 * @param {(player: object) => number} [options.maxHpFor] a character's ceiling;
 *        defaults to 100, which is only right for a party of one class
 * @returns {{players: object[], changes: string[], scene: ?string, changed: boolean}}
 *   `players` is a new array (entries are copies where they changed), `changes`
 *   is the human-readable log printed under the scene, and `scene` is the new
 *   location when the turn set one
 */
function applyEffects(players, effects, { maxHpFor = () => DEFAULT_MAX_HP } = {}) {
    // Copied up front so a partially-applied turn cannot leave the caller's
    // array half-written, and so `changed` can be decided by comparison.
    //
    // `toObject` first, because a party read out of Mongo without `.lean()` is
    // an array of Mongoose subdocuments, and spreading one of those yields
    // `{ __parentArray, $__, _doc }` — every field silently gone, and a turn
    // that applies its damage to an object with no `hp` on it.
    const next = (Array.isArray(players) ? players : []).map(player => {
        const plain = typeof player?.toObject === 'function' ? player.toObject() : player;
        return { ...plain, inventory: [...(plain?.inventory || [])] };
    });
    const changes = [];
    let scene = null;

    for (const effect of Array.isArray(effects) ? effects.slice(0, MAX_EFFECTS) : []) {
        const type = effect?.type;
        if (!EFFECT_TYPES.has(type)) continue;

        if (type === 'set_scene') {
            const value = typeof effect.scene === 'string' ? effect.scene.trim() : '';
            if (value) scene = value.slice(0, MAX_SCENE_LENGTH);
            continue;
        }

        const targets = resolveTargets(effect.target, next);
        if (!targets.length) continue;

        if (type === 'damage' || type === 'heal') {
            const amount = clampAmount(effect.amount);
            if (amount === null) continue;

            for (const target of targets) {
                const before = target.hp;
                target.hp = type === 'damage'
                    ? Math.max(0, before - amount)
                    // Healing is capped at the class ceiling, so a generous
                    // cleric cannot inflate the party past what the HP bar
                    // in the stat card can draw.
                    : Math.min(maxHpFor(target), before + amount);

                const delta = target.hp - before;
                if (delta === 0) continue;
                changes.push(delta < 0
                    ? `💥 **${target.name}** −${-delta} HP (${target.hp})`
                    : `💚 **${target.name}** +${delta} HP (${target.hp})`);
                if (target.hp === 0) changes.push(`☠️ **${target.name}** has fallen.`);
            }
            continue;
        }

        const item = cleanItem(effect.item);
        if (!item) continue;

        for (const target of targets) {
            if (type === 'add_item') {
                if (target.inventory.length >= MAX_INVENTORY) {
                    changes.push(`🎒 **${target.name}** cannot carry ${item} — their pack is full.`);
                    continue;
                }
                target.inventory.push(item);
                changes.push(`🎒 **${target.name}** gained *${item}*`);
                continue;
            }

            // remove_item. Matched case-insensitively for the same reason
            // targets are: the model wrote the item into the inventory in its
            // own casing a dozen scenes ago.
            const at = target.inventory.findIndex(
                held => held.toLowerCase() === item.toLowerCase()
            );
            if (at === -1) continue;
            const [removed] = target.inventory.splice(at, 1);
            changes.push(`🎒 **${target.name}** lost *${removed}*`);
        }
    }

    return { players: next, changes, scene, changed: changes.length > 0 || scene !== null };
}

/**
 * The part of the DM system prompt that teaches the block.
 *
 * Kept next to the parser rather than in the prompt builder, because the two
 * have to agree about the vocabulary and a format documented in one file and
 * read in another drifts.
 */
function effectsInstruction(players) {
    const names = players.map(p => p.name).filter(Boolean);
    const roster = names.length ? names.join('", "') : 'the character';

    return `
After your narration, and only if something mechanical actually happened, append one final line:

EFFECTS:[{"type":"damage","target":"${names[0] || 'Name'}","amount":15}]

It must be the very last line, with nothing after it. The array may hold up to ${MAX_EFFECTS} of:
- {"type":"damage","target":"Name","amount":N} — N is at most ${MAX_AMOUNT}
- {"type":"heal","target":"Name","amount":N}
- {"type":"add_item","target":"Name","item":"Rusty Key"}
- {"type":"remove_item","target":"Name","item":"Healing Potion"}
- {"type":"set_scene","scene":"The flooded lower vault"}

Rules for the block:
- "target" must be exactly one of the party's character names — "${roster}" — or "party" for something that hits everyone at once. Never name a monster or an NPC: only the party has hit points here.
- Anything that happens to a character other than the one acting still goes in the block. A trap, a breath weapon or a collapsing floor hits whoever it hits, and if that kills the party, so be it.
- Write the numbers into your prose as well, so the scene reads naturally, but the block is what actually takes effect.
- If nothing mechanical happened — a conversation, a look around the room — omit the line entirely.`;
}

module.exports = {
    extractEffects,
    applyEffects,
    effectsInstruction,
    resolveTargets,
    MAX_AMOUNT,
    MAX_EFFECTS,
    MAX_INVENTORY,
    MAX_ITEM_LENGTH,
    MAX_SCENE_LENGTH
};
