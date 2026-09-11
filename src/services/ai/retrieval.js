'use strict';

// Matching an English question against a list of things the bot knows about.
//
// Two of those lists exist — the command tree (commandHelp.js) and the game's
// own content tables (gameData.js) — and they had no business growing two
// stemmers, two stopword lists and two ideas of what counts as a match. What
// differs between them is which fields they have and what those fields are
// worth; everything from "how do I equip my rifle" down to a scored, ranked
// shortlist is the same problem twice.
//
// None of this is a search engine. It is a keyword scorer with a stemmer that
// fits on a page, and it is sized for the job: a few hundred short records, a
// question typed in a Discord channel, and a result that is put in front of a
// model which can tell a near miss from an answer. Being roughly right and
// cheap beats being precise on the critical path of a reply.

// Words that carry no signal about which thing is meant. Deliberately only
// grammar, and nothing that is a command name: `/use`, `/work`, `/mine`,
// `/shop` and `/help` all read as filler in an English sentence, and a stopword
// list that ate them would be a list that silently stopped answering the
// questions it exists for. tests/aiCommandHelp.test.js holds that to the
// command set, so a command named after a preposition fails the suite rather
// than quietly becoming unfindable.
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'you', 'your', 'yours', 'his', 'her', 'their', 'its',
    'how', 'what', 'where', 'when', 'why', 'who', 'which', 'whose',
    'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
    'does', 'did', 'done', 'doing', 'are', 'was', 'were', 'been', 'being',
    'have', 'has', 'had', 'having', 'about', 'this', 'that', 'these', 'those',
    'there', 'here', 'from', 'into', 'onto', 'than', 'then', 'them', 'they',
    'but', 'not', 'any', 'all', 'some', 'more', 'most', 'much', 'many',
    'please', 'thanks', 'tell', 'know', 'want', 'need', 'again',
    'just', 'like', 'now', 'one', 'two', 'out', 'own', 'way', 'got'
]);

// Everyday words for things the bot calls something else, so that a question
// does not have to be phrased in the bot's own vocabulary. Boosting only, and
// at half weight: nothing here is required for a match, and deleting the map
// would make retrieval worse, never wrong. Keep it to words a player would
// actually type.
const SYNONYMS = new Map([
    ['gun', ['rifle', 'weapon']],
    ['weapon', ['rifle', 'gun']],
    ['rifle', ['weapon']],
    ['money', ['coins', 'balance', 'wallet']],
    ['cash', ['coins', 'balance']],
    ['coins', ['balance', 'wallet']],
    ['broke', ['balance', 'daily']],
    ['gamble', ['casino', 'bet']],
    ['gambling', ['casino', 'bet']],
    ['pickaxe', ['mine', 'mining']],
    ['rod', ['fish', 'fishing']],
    ['bait', ['fish', 'fishing']],
    ['stats', ['profile', 'level']],
    ['level', ['rank', 'xp']],
    ['leveling', ['rank', 'xp']],
    ['rank', ['level', 'leaderboard']],
    ['inventory', ['inv', 'items']],
    ['items', ['inventory', 'inv']],
    ['gear', ['inv', 'equip', 'weapon']],
    ['sell', ['market', 'shop', 'sale']],
    ['buy', ['shop', 'market']],
    ['trade', ['market', 'gift']],
    ['job', ['work', 'jobs']],
    ['ore', ['mine', 'mining']],
    ['animal', ['hunt', 'hunting']],
    ['monster', ['animal', 'hunt']],
    ['loot', ['drop', 'reward']],
    ['recipe', ['craft', 'crafting']]
]);

const SYNONYM_WEIGHT = 0.5;

/** `text` with every regular-expression metacharacter escaped. */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word patterns for the short forms, kept because the same handful of
// them is tested against every record on every message, and the vocabulary a
// question can use is small and repeats. The keys come from what people type,
// so the cache is bounded and dropped whole when it fills rather than grown by
// anyone willing to send three-letter nonsense all day.
const WORD_PATTERN_CACHE_MAX = 512;
const wordPatterns = new Map();

/**
 * A cached whole-word matcher for `form`.
 *
 * @param {string} form one spelling of a question word
 * @returns {RegExp} anchored on word boundaries, so `inv` does not match
 *   "invest"
 */
function wordPattern(form) {
    let pattern = wordPatterns.get(form);
    if (!pattern) {
        if (wordPatterns.size >= WORD_PATTERN_CACHE_MAX) wordPatterns.clear();
        pattern = new RegExp(`\\b${escapeRegExp(form)}\\b`);
        wordPatterns.set(form, pattern);
    }
    return pattern;
}

/**
 * The spellings of one query word worth looking for.
 *
 * A crude stem, not a stemmer: drop a plural or a tense off the end so that
 * "equipping" still finds "Equip a weapon" and "rifles" still finds "Rifle".
 * It only ever adds forms, so over-stemming costs a wasted `includes` rather
 * than a wrong answer.
 */
function wordForms(word) {
    const forms = new Set([word]);
    const add = form => { if (form.length >= 3 && form !== word) forms.add(form); };

    // Plurals, in both spellings: dropping -es is right for "matches" and
    // wrong for "horses", and carrying the wrong one costs a lookup.
    if (word.endsWith('s')) {
        add(word.slice(0, -1));
        if (word.endsWith('es')) add(word.slice(0, -2));
    }

    // Tenses, and the two things English does to a stem before adding one: the
    // doubled consonant ("equipping" → "equipp" → "equip") and the dropped
    // silent e ("mining" → "min" → "mine", which is the difference between
    // "how does mining work" finding /mine and finding /work). The bare short
    // stem is never added — "min" on its own would match anything — only the
    // spellings that put a real word back together.
    const tense = word.replace(/(ing|ed)$/, '');
    if (tense !== word && tense.length >= 3) {
        if (tense.length >= 4) {
            add(tense);
            if (/(.)\1$/.test(tense)) add(tense.slice(0, -1));
        }
        add(`${tense}e`);
    }

    // A stem can land on grammar: "whats" is not in the list above and "what"
    // is. Filtered here rather than before stemming, or "hey whats up"
    // retrieves everything whose description contains the word "what".
    return [...forms].filter(form => !STOPWORDS.has(form));
}

/** The question, lowercased and stripped to the characters matching looks at. */
function normalize(query) {
    return String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The words of a question that could name something, with their synonyms. */
function queryTerms(query) {
    const words = normalize(query).split(' ').filter(word => word.length > 2 && !STOPWORDS.has(word));

    const terms = [];
    const seen = new Set();

    for (const word of new Set(words)) {
        const forms = wordForms(word);
        if (!forms.length) continue;
        terms.push({ word, forms, weight: 1 });
        seen.add(word);
    }
    for (const word of [...seen]) {
        for (const synonym of SYNONYMS.get(word) || []) {
            if (seen.has(synonym)) continue;
            const forms = wordForms(synonym);
            seen.add(synonym);
            if (!forms.length) continue;
            terms.push({ word: synonym, forms, weight: SYNONYM_WEIGHT, synonym: true });
        }
    }

    return terms;
}

/**
 * Whether `form` appears in `text`.
 *
 * Substring for anything long enough that a substring means something, and a
 * whole word for the short ones: `inv` has to match "/hunt inv equip" without
 * also matching "invest" and "inventory" on every question that says "inv".
 */
function fieldHas(text, form) {
    if (!text) return false;
    if (form.length <= 3) return wordPattern(form).test(text);
    return text.includes(form);
}

/**
 * Score one record's lowercased fields against a question.
 *
 * @param {object} fields       field name → lowercased text
 * @param {object[]} terms      from queryTerms
 * @param {object} weights      field name → what a hit there is worth
 * @param {string|string[]} strong  the field, or fields, a single word may
 *   qualify on alone
 * @returns {{score: number, named: boolean, matched: number}} `named` is a hit
 *   in one of the strong fields; `matched` counts the distinct question words
 *   (not their synonyms) that landed anywhere.
 */
function scoreFields(fields, terms, weights, strong) {
    const strongFields = new Set(Array.isArray(strong) ? strong : [strong]);
    let score = 0;
    let named = false;
    const matched = new Set();

    for (const term of terms) {
        for (const [field, weight] of Object.entries(weights)) {
            const text = fields[field];
            if (!term.forms.some(form => fieldHas(text, form))) continue;
            score += weight * term.weight;
            if (!term.synonym) matched.add(term.word);
            if (strongFields.has(field)) named = true;
        }
    }

    return { score, named, matched: matched.size };
}

/**
 * The best matches, with a cap on how many may come from one group.
 *
 * Without the cap a question about fishing spends every slot on /fish, and
 * "where do I sell my fish" never reaches /market — every fishing record scores
 * on the word "fish" whether or not it has anything to do with selling. Slots
 * nobody took still go to the best remaining matches, so a question that really
 * is about one group is not padded out with worse answers.
 *
 * @param {Array<{value: *, score: number, group: string, tiebreak: string}>} matches
 * @param {{limit: number, perGroup: number}} options
 * @returns {Array<*>} the `value` of each winner, best first within each tier
 */
function rankMatches(matches, { limit, perGroup }) {
    const ranked = [...matches].sort((a, b) => b.score - a.score || a.tiebreak.localeCompare(b.tiebreak));

    const taken = new Map();
    const picked = [];
    const overflow = [];

    for (const match of ranked) {
        const used = taken.get(match.group) || 0;
        if (used < perGroup && picked.length < limit) {
            taken.set(match.group, used + 1);
            picked.push(match.value);
        } else {
            overflow.push(match.value);
        }
    }

    return picked.concat(overflow.slice(0, Math.max(0, limit - picked.length)));
}

module.exports = {
    queryTerms,
    scoreFields,
    rankMatches,
    fieldHas,
    normalize,
    wordForms,
    STOPWORDS
};
