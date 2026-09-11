'use strict';

const path = require('path');
const { queryTerms, scoreFields, rankMatches, normalize } = require('./retrieval');

// The game's own content, retrieved per question and put in front of the model.
//
// commandHelp.js answers "how do I equip my rifle" — the command tree knows
// that `/hunt inv equip` exists. It does not know what a Cobalt Rifle costs,
// which zone opossums live in, what a Luck Charm does, or what the Whisperwood
// Charm is, because none of that is in a SlashCommandBuilder. It is in
// src/data/, in tables the commands read at runtime, and a model that cannot
// see them answers questions about this server's economy by making numbers up.
//
// So the same treatment: derive an index from the tables themselves, score it
// against the question, inject what matched. A price change in huntData.js is
// in the bot's answers on the next restart with nothing else to edit, which is
// the whole reason this reads the tables instead of a written-up copy of them.
//
// What is hand-written here is the registry below — which exports are player-
// facing content, what to call them, and which command they belong to. That is
// three things a walker cannot infer, and all three are held to the code by
// tests/aiGameData.test.js: a new table in src/data/ fails the suite until
// somebody classifies it, and a `command` that stops resolving against the real
// command tree fails it too.

// ─── WHAT COUNTS AS CONTENT ───────────────────────────────────────────────────

/**
 * The tables worth answering from.
 *
 * `kind` is what one record *is*, in the words somebody would ask with — it is
 * searchable, so "what ores are there" finds the ore table through it. `system`
 * groups a table with its siblings for the per-group cap and is searchable for
 * the same reason. `command` is where the thing is used, and is checked against
 * the real command tree by the suite rather than trusted.
 */
const COLLECTIONS = [
    // Hunting
    { module: 'huntData', export: 'WEAPON_TIERS',    kind: 'hunting rifle',          system: 'hunting', command: '/hunt shop weapon' },
    { module: 'huntData', export: 'WEAPON_UPGRADES', kind: 'rifle upgrade module',   system: 'hunting', command: '/hunt shop upgrade' },
    { module: 'huntData', export: 'AMMO_PACKS',      kind: 'ammunition pack',        system: 'hunting', command: '/hunt shop buy' },
    { module: 'huntData', export: 'CONSUMABLES',     kind: 'hunting consumable',     system: 'hunting', command: '/hunt shop buy' },
    { module: 'huntData', export: 'ZONE_LIST',       kind: 'hunting zone',           system: 'hunting', command: '/hunt zone set' },
    { module: 'huntData', export: 'ANIMALS',         kind: 'huntable animal',        system: 'hunting', command: '/hunt start' },
    { module: 'huntData', export: 'ANIMAL_TRAITS',   kind: 'animal trait',           system: 'hunting', command: '/hunt start' },
    { module: 'huntData', export: 'APEX_TYPES',      kind: 'apex predator encounter', system: 'hunting', command: '/hunt start' },
    { module: 'huntData', export: 'FIELD_TROPHIES',  kind: 'field trophy',           system: 'hunting', command: '/hunt profile' },
    { module: 'huntData', export: 'TROPHY_QUALITIES', kind: 'trophy quality grade',  system: 'hunting', command: '/hunt profile' },
    { module: 'huntData', export: 'CRAFT_RECIPES',   kind: 'crafting recipe',        system: 'crafting', command: '/craft make' },
    { module: 'huntData', export: 'HUNT_QUEST_TEMPLATES', kind: 'hunting quest',     system: 'hunting', command: '/hunt quests view' },

    // Fishing
    { module: 'fishData', export: 'ROD_TIERS',       kind: 'fishing rod',            system: 'fishing', command: '/fish shop rod' },
    { module: 'fishData', export: 'ROD_UPGRADES',    kind: 'fishing rod upgrade',    system: 'fishing', command: '/fish shop upgrade' },
    { module: 'fishData', export: 'BAIT_PACKS',      kind: 'bait pack',              system: 'fishing', command: '/fish shop buy' },
    { module: 'fishData', export: 'CONSUMABLES',     kind: 'fishing consumable',     system: 'fishing', command: '/fish shop buy' },
    { module: 'fishData', export: 'LOCATION_LIST',   kind: 'fishing location',       system: 'fishing', command: '/fish location set' },
    { module: 'fishData', export: 'FISH',            kind: 'catchable fish',         system: 'fishing', command: '/fish cast' },
    { module: 'fishData', export: 'JUNK_ITEMS',      kind: 'fishing junk catch',     system: 'fishing', command: '/fish cast' },
    { module: 'fishData', export: 'TREASURE_ITEMS',  kind: 'fishing treasure catch', system: 'fishing', command: '/fish cast' },
    { module: 'fishData', export: 'BOSS_TYPES',      kind: 'boss fish encounter',    system: 'fishing', command: '/fish cast' },
    { module: 'fishData', export: 'WEATHER_LIST',    kind: 'fishing weather',        system: 'fishing', command: '/fish cast' },
    { module: 'fishData', export: 'SIZE_TIERS',      kind: 'fish size grade',        system: 'fishing', command: '/fish records' },
    { module: 'fishData', export: 'FAILURE_SEVERITIES', kind: 'failed cast outcome', system: 'fishing', command: '/fish cast' },
    { module: 'fishData', export: 'FISH_CRAFT_RECIPES', kind: 'crafting recipe',     system: 'crafting', command: '/craft make' },
    { module: 'fishData', export: 'FISH_QUEST_TEMPLATES', kind: 'fishing quest',     system: 'fishing', command: '/fish quests view' },

    // Mining
    { module: 'mineData', export: 'PICKAXE_TIERS',   kind: 'pickaxe',                system: 'mining', command: '/mine shop pickaxe' },
    { module: 'mineData', export: 'PICKAXE_UPGRADES', kind: 'pickaxe upgrade',       system: 'mining', command: '/mine shop upgrade' },
    { module: 'mineData', export: 'BLAST_PACKS',     kind: 'blasting charge pack',   system: 'mining', command: '/mine shop buy' },
    { module: 'mineData', export: 'CONSUMABLES',     kind: 'mining consumable',      system: 'mining', command: '/mine shop buy' },
    { module: 'mineData', export: 'DEPTH_LIST',      kind: 'mining depth',           system: 'mining', command: '/mine dig' },
    { module: 'mineData', export: 'ORES',            kind: 'ore',                    system: 'mining', command: '/mine dig' },
    { module: 'mineData', export: 'INTENSITY_LEVELS', kind: 'mining intensity',      system: 'mining', command: '/mine dig' },
    { module: 'mineData', export: 'CRAFT_RECIPES',   kind: 'crafting recipe',        system: 'crafting', command: '/craft make' },
    { module: 'mineData', export: 'MINE_QUEST_TEMPLATES', kind: 'mining quest',      system: 'mining', command: '/mine quests view' },

    // Exploring
    { module: 'exploreData', export: 'REGION_LIST',  kind: 'explorable region',      system: 'exploring', command: '/explore travel' },
    { module: 'exploreData', export: 'RELIC_LIST',   kind: 'collectible relic',      system: 'exploring', command: '/explore relics' },

    // Across the three grinds
    { module: 'crossSystemData', export: 'CROSS_CONSUMABLES', kind: 'cross-activity consumable', system: 'crafting', command: '/craft make' },
    { module: 'crossSystemData', export: 'CROSS_CRAFT_RECIPES', kind: 'crafting recipe',  system: 'crafting', command: '/craft make' },
    { module: 'crossSystemData', export: 'SYNERGY_LIST', kind: 'cross-activity synergy', system: 'synergies', command: '/synergies' },
    { module: 'materialRarity', export: 'MATERIAL_RARITY', kind: 'crafting material', system: 'crafting', command: '/craft list' },

    // The rest of the economy
    { module: 'defaultShopItems', export: 'DEFAULT_SHOP_ITEMS', kind: 'shop item',   system: 'shop', command: '/shop buy' },
    { module: 'achievements', export: 'ACHIEVEMENTS', kind: 'achievement',           system: 'achievements', command: '/achievement' },
    { module: 'defaultJobs',                         kind: 'job',                    system: 'jobs', command: '/jobs' },
    { module: 'defaultTiers',                        kind: 'work tier',              system: 'jobs', command: '/work' },
    { module: 'heistData', export: 'ROLES',          kind: 'heist role',             system: 'heists', command: '/heist start' },
    { module: 'heistData', export: 'TARGETS',        kind: 'heist target',           system: 'heists', command: '/heist start' },
    { module: 'dailyDropTable', export: 'DROP_TABLE', kind: 'daily reward drop',     system: 'daily', command: '/daily' },
    { module: 'dailyDropTable', export: 'RARE_DROP_TABLE', kind: 'rare daily reward drop', system: 'daily', command: '/daily' },
    { module: 'seasonalEvents', export: 'SEASONAL_EVENTS', kind: 'seasonal event',   system: 'events', command: '/event status' }
];

/**
 * Tables that are deliberately not answerable, and why.
 *
 * The reasons matter more than the list. `quizFallback` is the question bank
 * `/quiz` draws from: indexing it would let anybody ask the bot for the answer
 * to the question it just asked them, which is not a feature, it is the end of
 * the feature. `profanityList` is the automod word list, and reciting it in a
 * channel is the thing automod exists to stop. The rest are internal tables
 * with nothing in them a player would ask about in words.
 */
const NOT_CONTENT = new Map([
    ['quizFallback', 'the /quiz question bank — the bot must not hand out the answers to its own quiz'],
    ['profanityList', 'the automod word list — reciting it in a channel is the thing automod prevents'],
    ['activityItems', 'an id list with no descriptions, already covered by the shop and consumable tables'],
    ['soulboundItems', 'an id list marking items as untradeable, with nothing to describe'],
    ['seasonPass', 'generated tier rewards, described by /season view against a live season'],
    ['seasonMissions', 'mission templates filled in per day, described by /season missions'],
    ['featuredRotation', 'the pools today\'s /featured rotation is drawn from, not content of its own']
]);

// ─── ONE RECORD ───────────────────────────────────────────────────────────────

// Where a record's display name comes from, first present wins. `itemId` is
// last because it is an id everywhere except in the relic table, where it is
// the relic's actual name.
const NAME_KEYS = ['name', 'label', 'displayName', 'itemId'];

// And its prose, first present wins: several tables call the same field by a
// different word, and the relic table's `lore` is the only description it has.
const DESCRIPTION_KEYS = ['description', 'desc', 'flavor', 'lore', 'tagline'];

/**
 * Keys that never become facts.
 *
 * Three groups. The name and description keys are already rendered above the
 * facts. `id`, `slug`, `emoji`, `color` and `weight` are plumbing — an internal
 * id in an answer is a string the user cannot do anything with.
 *
 * The third group is the one worth being deliberate about: `secrets`, `relics`,
 * `landmarks`, `encounters`, `traps` and the narrative lines are the things
 * /explore hides until somebody finds them. They are nested inside the region
 * records, so a generic walk would happily tell a player the reward and the
 * reveal text of every secret in a region they have never visited. The length
 * caps below would drop most of it as a side effect; this drops all of it on
 * purpose, because "the bot spoiled the content" should not depend on how long
 * the spoiler happened to be.
 */
const SKIPPED_KEYS = new Set([
    ...NAME_KEYS, ...DESCRIPTION_KEYS,
    'id', 'slug', 'emoji', 'color', 'weight',
    'tierWeights', 'eventWeights', 'zoneMaterials',
    'intros', 'landmarks', 'encounters', 'traps', 'secrets', 'relics',
    'treasureLines', 'quietLines', 'footerLines', 'injuryLines',
    'winLine', 'loseLine', 'safeLine', 'reveal', 'line'
]);

// Caps, in characters. A weapon's facts are ~150; a region's would be several
// thousand without these, and it is the same budget every knowledge entry and
// every fetched document is competing for.
const MAX_VALUE_CHARS = 120;
const MAX_FACTS_CHARS = 320;
const MAX_DESCRIPTION_CHARS = 300;

function truncate(text, limit) {
    return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** A number, string or boolean as the model should read it, or null. */
function scalar(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && Math.abs(value) >= 1000 ? value.toLocaleString('en-US') : String(value);
    }
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'string') return value.trim() || null;
    return null;
}

/**
 * A flat object as `label/key value/key value`, or null when it has nothing.
 *
 * A nested object keeps its own name where the record it sits in does not: the
 * record's name is rendered above its facts, so repeating it inside them is
 * noise, but nothing is rendered above `specialDrop`, and skipping the name
 * there turned "Opossum Pelt, 3% of the time" into `specialDrop: chance 0.03`.
 * The label leads and is not printed with its key, because `name Opossum Pelt`
 * reads worse than the thing itself.
 */
function flatten(value) {
    if (!value || typeof value !== 'object') return null;

    const label = firstOf(value, NAME_KEYS);
    const parts = label ? [label] : [];

    for (const [key, inner] of Object.entries(value)) {
        if (SKIPPED_KEYS.has(key)) continue;
        const rendered = scalar(inner);
        if (rendered !== null) parts.push(`${key} ${rendered}`);
    }
    return parts.length ? parts.join('/') : null;
}

/**
 * One field's value, or null when there is nothing useful in it.
 *
 * Arrays of objects are where a table's bulk lives — a region's encounters, its
 * traps, its secrets — so they are rendered only when the result is short
 * enough to plausibly be a list of ingredients rather than a chapter. Combined
 * with the skip list above, that is what keeps a crafting recipe legible and a
 * region's narrative out of the prompt.
 */
function fieldValue(value) {
    const direct = scalar(value);
    if (direct !== null) return truncate(direct, MAX_VALUE_CHARS);

    if (Array.isArray(value)) {
        const parts = value.map(item => scalar(item) ?? flatten(item)).filter(Boolean);
        if (!parts.length) return null;
        const joined = parts.join(', ');
        return joined.length > MAX_VALUE_CHARS ? null : joined;
    }

    const flat = flatten(value);
    return flat === null ? null : truncate(flat, MAX_VALUE_CHARS);
}

/** Everything about a record that is not its name or its prose. */
function factsOf(record) {
    const parts = [];
    let used = 0;

    for (const [key, value] of Object.entries(record)) {
        if (SKIPPED_KEYS.has(key)) continue;
        const rendered = fieldValue(value);
        if (rendered === null) continue;
        const part = `${key}: ${rendered}`;
        if (used + part.length > MAX_FACTS_CHARS) continue;
        used += part.length + 3;
        parts.push(part);
    }

    return parts.join(' · ');
}

function firstOf(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/** One record as a searchable, renderable entry, or null when it has no name. */
function indexRecord(record, source) {
    if (!record || typeof record !== 'object') return null;
    const name = firstOf(record, NAME_KEYS);
    if (!name) return null;

    const description = truncate(firstOf(record, DESCRIPTION_KEYS), MAX_DESCRIPTION_CHARS);
    const facts = factsOf(record);

    return {
        name,
        kind: source.kind,
        system: source.system,
        command: source.command,
        description,
        facts,
        // Matched against a question that has been through the same normalizer,
        // so a name carrying punctuation is still findable: "Premium Magnet
        // (Lucky Charm)" matches somebody typing lucky charm, and "Luck
        // Charm ×1" is not made unreachable by its ×.
        fields: {
            name: normalize(name),
            kind: normalize(`${source.kind} ${source.system}`),
            description: normalize(description),
            facts: normalize(facts)
        }
    };
}

// ─── THE INDEX ────────────────────────────────────────────────────────────────

const DATA_ROOT = path.join(__dirname, '..', '..', 'data');

/** The records of one registry row, or [] when the export has gone. */
function recordsOf(source) {
    let table;
    try {
        const module = require(path.join(DATA_ROOT, source.module));
        table = source.export ? module[source.export] : module;
    } catch {
        return [];
    }
    if (!table || typeof table !== 'object') return [];
    return Array.isArray(table) ? table : Object.values(table);
}

let cachedIndex = null;

/**
 * Every player-facing record in src/data/, as searchable entries.
 *
 * Built once: these tables are literals in required modules, so they cannot
 * change while the process runs, and this is on the path to a reply.
 */
function buildGameIndex() {
    if (cachedIndex) return cachedIndex;

    const index = [];
    // The same record reaches this twice wherever a table is exported in two
    // shapes — WEAPON_TIERS and WEAPON_BY_SLUG hold the same twelve objects —
    // so identity, not name, is what keeps one thing to one entry.
    const seen = new Set();

    for (const source of COLLECTIONS) {
        for (const record of recordsOf(source)) {
            if (seen.has(record)) continue;
            seen.add(record);
            const entry = indexRecord(record, source);
            if (entry) index.push(entry);
        }
    }

    cachedIndex = index;
    return index;
}

// ─── RETRIEVAL ────────────────────────────────────────────────────────────────

const GAME_DATA_LIMIT = 5;
const PER_SYSTEM_LIMIT = 3;

// A word in the name is the user naming the thing. `kind` is worth less but is
// how a question about a category ("what ores are there") finds a table whose
// records are all named something else, and the facts are worth least: matching
// "steel" in an ammo type is a weaker signal than matching it in a name.
const FIELD_WEIGHTS = { name: 5, kind: 2, description: 2, facts: 1 };

// The field a single question word may qualify a record on by itself, and it is
// `kind` rather than `name` — the opposite of the command reference, where the
// path is the strong field and works on one word.
//
// A kind is a category label written here on purpose ("ore", "hunting rifle",
// "achievement"), so a word hitting one is somebody asking about that category.
// A name is whatever the content author called something, and four hundred of
// them contain an ordinary English word: "first" is in First Blood, First
// Catch and First Outing, which is how "who was the first president" retrieved
// five achievements before this was split apart. A name qualifies on one word
// only when the word *is* the name — see `namesExactly`.
const KIND_FIELD = 'kind';

// Shortest name allowed to be matched as a phrase inside the question. Below
// this a name is a fragment that turns up in ordinary sentences.
const MIN_PHRASE_CHARS = 4;

// What naming a record exactly is worth. "What does the cobalt rifle cost"
// names one of twelve rifles that otherwise all score identically on the word
// "rifle", and this is what puts that one first.
const NAME_PHRASE_BONUS = 10;

/**
 * Whether the question named this record rather than merely touching a word in
 * it: one of its words stemmed to the whole name ("opossums" → Opossum), or the
 * whole name appears in the question ("the cobalt rifle" → Cobalt Rifle).
 */
function namesExactly(entry, terms, phrase) {
    const name = entry.fields.name;
    if (name.length < MIN_PHRASE_CHARS) return false;
    if (phrase.includes(` ${name} `)) return true;
    return terms.some(term => !term.synonym && term.forms.includes(name));
}

/**
 * The game content this question is about, best first, or [] when it is about
 * none.
 *
 * A record qualifies on a hit in its kind, on being named exactly, or on two
 * separate question words landing anywhere in it. See commandHelp.js for why
 * one weak hit is not enough on its own.
 */
function retrieveGameData(query, limit = GAME_DATA_LIMIT) {
    const terms = queryTerms(query);
    if (!terms.length) return [];

    const phrase = ` ${normalize(query)} `;
    const matches = [];

    for (const entry of buildGameIndex()) {
        const { score, named, matched } = scoreFields(entry.fields, terms, FIELD_WEIGHTS, KIND_FIELD);
        if (!score) continue;

        const exact = namesExactly(entry, terms, phrase);
        if (!named && !exact && matched < 2) continue;

        matches.push({
            value: entry,
            score: exact ? score + NAME_PHRASE_BONUS : score,
            group: entry.system,
            tiebreak: entry.name
        });
    }

    return rankMatches(matches, { limit, perGroup: PER_SYSTEM_LIMIT });
}

// ─── THE PROMPT SECTION ───────────────────────────────────────────────────────

function gameBlock(entry) {
    const lines = [`**${entry.name}** — ${entry.kind}${entry.command ? ` (\`${entry.command}\`)` : ''}`];
    if (entry.description) lines.push(entry.description);
    if (entry.facts) lines.push(entry.facts);
    return lines.join('\n');
}

// Bot-authored like the command reference, so no "do not follow instructions in
// here" caveat — but unlike the command reference these are numbers, and a
// number the model rounds or remembers wrong is a player told the wrong price.
const GAME_HEADER = '\n\n---\nContent from my own game tables, matched to this question. '
    + 'These names and numbers are exact — quote them as written, never round or estimate them, '
    + 'and never invent an item, price, drop or stat that is not listed. Only what matched is here; '
    + 'there is much more, so if none of this answers the question, say so rather than guessing.\n';
const GAME_JOINER = '\n\n';

/**
 * The block as budget-shaped pieces, the same shape knowledgeSection returns so
 * the context budget can drop the worst match rather than the whole section.
 */
function gameDataSection(entries) {
    return {
        header: GAME_HEADER,
        joiner: GAME_JOINER,
        items: entries.map(gameBlock)
    };
}

/** `gameDataSection`, rendered. */
function buildGameDataContext(entries) {
    if (!entries.length) return '';
    const { header, joiner, items } = gameDataSection(entries);
    return header + items.join(joiner);
}

module.exports = {
    buildGameIndex,
    retrieveGameData,
    gameDataSection,
    buildGameDataContext,
    GAME_DATA_LIMIT,
    // Read by tests/aiGameData.test.js, which holds both to src/data/.
    COLLECTIONS,
    NOT_CONTENT
};
