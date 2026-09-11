'use strict';

// What the bot itself can do, retrieved per question and put in front of the
// model.
//
// Ask the chat "how do I equip my rifle" and it had nothing to answer from. The
// knowledge base is guild-curated — somebody has to have written `/hunt inv
// equip` down by hand — and a model with no entry to read does not say "I don't
// know", it invents a command that sounds right. That is worse than silence:
// the user types it, Discord tells them the command does not exist, and the bot
// was wrong in a way nobody in the channel can correct.
//
// The answer was already in the process. Every command registers a
// SlashCommandBuilder carrying its own name, its subcommands, its option
// descriptions and its choice lists — the same tree Discord renders in the
// command picker. So the reference is derived from `client.commands` the way
// /help's catalog is (utils/helpCatalog), scored against the question, and
// injected as a prompt section beside the knowledge base. A new command file is
// answerable the moment it loads, and there is no second list to drift.
//
// Retrieval rather than the whole tree because the whole tree does not fit:
// ~100 commands with their subcommands and options is a large fraction of a
// small model's context, spent on every "hey" as well as every "how do I".

// Discord's application-command option types. The two structural ones drive the
// walk below; the rest are only ever rendered, in the word a player would use
// rather than the API's.
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

const OPTION_TYPE_LABELS = {
    3: 'text',
    4: 'whole number',
    5: 'yes/no',
    6: 'user',
    7: 'channel',
    8: 'role',
    9: 'user or role',
    10: 'number',
    11: 'attachment'
};

// How many commands one question may pull in. Five is what the knowledge base
// retrieves, and for the same reason: enough for "the one they meant plus the
// neighbours they might have meant", short of a listing the model starts
// summarising instead of answering from.
const COMMAND_LIMIT = 5;

// Per entry, in the rendered block. Both are real sizes — a command can carry
// Discord's full 25 choices on an option, and several here do — and reprinting
// all of one to answer "how do I equip my rifle" is tokens spent on a list
// nobody asked to read.
const MAX_OPTIONS_SHOWN = 6;
const MAX_CHOICES_SHOWN = 6;

// How many leaves of the same top-level command may take slots before the rest
// get one. Without it a question about fishing spends all five on /fish, and
// "where do I sell my fish" never reaches /market — every /fish subcommand
// scores on the word "fish" whether or not it has anything to do with selling.
// Leftover slots still go to the best remaining entries, so a question that
// really is about one command is not padded out with worse answers.
const PER_COMMAND_LIMIT = 2;

// Where a query word hit, and what that is worth. A word in the command path
// itself is the strongest signal there is — "hunt" in `/hunt inv equip` is the
// user naming the feature — and the surrounding descriptions of the parent
// command and group are the weakest, because every subcommand of /hunt shares
// them and they cannot tell two of them apart.
const FIELD_WEIGHTS = { usage: 5, description: 3, options: 2, choices: 2, context: 1 };

// The field a single word may qualify an entry on by itself. Only the command
// path: a word there is the user naming the thing they want, and "balance?" on
// its own has to reach `/balance`. Every other field matches too freely to
// stand alone — "today" appears in a dozen descriptions in the real tree, and
// "hey there, how are you today" is not a question about any of them. Anything
// else needs a second question word landing somewhere in the same entry.
const PATH_FIELD = 'usage';

// Words that carry no signal about which command is meant. Deliberately only
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

// Everyday words for things the command tree calls something else, so that the
// question does not have to be phrased in the bot's own vocabulary. Boosting
// only, and at half weight: nothing here is required for a match, and removing
// the map entirely would make retrieval worse, never wrong. Keep it to words a
// player would actually type.
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
    ['job', ['work', 'jobs']]
]);

const SYNONYM_WEIGHT = 0.5;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word patterns for the short forms, kept because the same handful of
// them is tested against every entry in the index on every message, and the
// vocabulary a question can use is small and repeats. The keys come from what
// people type, so the cache is bounded and dropped whole when it fills rather
// than grown by anyone willing to send three-letter nonsense all day.
const WORD_PATTERN_CACHE_MAX = 512;
const wordPatterns = new Map();

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
    // retrieves every command whose description contains the word "what".
    return [...forms].filter(form => !STOPWORDS.has(form));
}

/** The words of a question that could name a command, with their synonyms. */
function queryTerms(query) {
    const words = String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 2 && !STOPWORDS.has(word));

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

function optionEntry(option) {
    return {
        name: option.name,
        label: OPTION_TYPE_LABELS[option.type] || 'value',
        required: Boolean(option.required),
        description: option.description || '',
        choices: (option.choices || []).map(choice => String(choice.name))
    };
}

function indexEntry({ path, description, options, category, root, group }) {
    const entryOptions = (options || [])
        .filter(option => option.type !== SUBCOMMAND && option.type !== SUBCOMMAND_GROUP)
        .map(optionEntry);

    // The parent command's and group's own descriptions. Real context — "/hunt
    // … all in one place" says the subcommand below it is part of hunting — but
    // shared by every sibling, so it is scored at the bottom of the weights.
    const context = path.length > 1
        ? [root?.description, group?.description].filter(Boolean).join(' ')
        : '';

    return {
        usage: `/${path.join(' ')}`,
        command: path[0],
        category,
        description: description || '',
        context,
        options: entryOptions,
        fields: {
            usage: path.join(' ').toLowerCase(),
            description: (description || '').toLowerCase(),
            options: entryOptions.map(o => `${o.name} ${o.description}`).join(' ').toLowerCase(),
            choices: entryOptions.flatMap(o => o.choices).join(' ').toLowerCase(),
            context: `${context} ${category}`.toLowerCase()
        }
    };
}

/**
 * One command module as the leaves a user can actually type.
 *
 * `/hunt` is not a thing anybody runs — `/hunt inv equip` is — so a command with
 * subcommands contributes one entry per leaf and none for the root, and a
 * command without them contributes itself. A module whose builder throws is
 * skipped rather than allowed to take the whole index down: this runs on the
 * path to a reply, and a reply that knows fewer commands beats no reply.
 */
function flattenCommand(command) {
    let json;
    try {
        json = command?.data?.toJSON?.();
    } catch {
        return [];
    }
    if (!json?.name) return [];

    const category = command.category || 'other';
    const root = { name: json.name, description: json.description || '' };
    const options = json.options || [];
    const subcommands = options.filter(option => option.type === SUBCOMMAND);
    const groups = options.filter(option => option.type === SUBCOMMAND_GROUP);

    if (!subcommands.length && !groups.length) {
        return [indexEntry({ path: [json.name], description: root.description, options, category, root })];
    }

    const entries = subcommands.map(sub => indexEntry({
        path: [json.name, sub.name], description: sub.description, options: sub.options, category, root
    }));

    for (const group of groups) {
        for (const sub of (group.options || []).filter(option => option.type === SUBCOMMAND)) {
            entries.push(indexEntry({
                path: [json.name, group.name, sub.name],
                description: sub.description,
                options: sub.options,
                category,
                root,
                group
            }));
        }
    }

    return entries;
}

// Built once per command collection rather than per message: the tree only
// changes when the process reloads its commands, and this runs on the critical
// path of every mention. Keyed on the collection itself and invalidated by its
// size, so a test that swaps in a different set gets a different index.
const indexCache = new WeakMap();

function commandModules(commands) {
    if (!commands) return [];
    if (typeof commands.values === 'function') return [...commands.values()];
    if (typeof commands[Symbol.iterator] === 'function') return [...commands];
    return [];
}

/**
 * Every command leaf, as searchable entries.
 *
 * @param {object} commands `client.commands` — or any iterable of loaded
 *   command modules, which is what tests and scripts have.
 * @returns {Array<object>}
 */
function buildCommandIndex(commands) {
    const modules = commandModules(commands);
    const cacheable = commands !== null && typeof commands === 'object';
    const cached = cacheable ? indexCache.get(commands) : null;
    if (cached && cached.size === modules.length) return cached.index;

    const index = modules.flatMap(flattenCommand);
    if (cacheable) indexCache.set(commands, { size: modules.length, index });
    return index;
}

function scoreEntry(entry, terms) {
    let score = 0;
    let named = false;
    const matched = new Set();

    for (const term of terms) {
        for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
            const text = entry.fields[field];
            if (!term.forms.some(form => fieldHas(text, form))) continue;
            score += weight * term.weight;
            if (!term.synonym) matched.add(term.word);
            if (field === PATH_FIELD) named = true;
        }
    }

    return { score, named, matched: matched.size };
}

/**
 * The commands this question is about, best first, or [] when it is about none.
 *
 * An entry qualifies on a hit in the command path itself, or on two separate
 * question words landing anywhere in it. Both halves matter: the first is how
 * "balance?" reaches `/balance` on one word, and together they are what keeps
 * "hey there, how are you today" from retrieving every command whose
 * description mentions today.
 *
 * @param {object} commands `client.commands`, or any iterable of command modules
 * @param {string} query    what the user actually asked
 * @param {number} [limit]
 */
function retrieveCommands(commands, query, limit = COMMAND_LIMIT) {
    const terms = queryTerms(query);
    if (!terms.length) return [];

    const scored = [];
    for (const entry of buildCommandIndex(commands)) {
        const { score, named, matched } = scoreEntry(entry, terms);
        if (!score) continue;
        if (!named && matched < 2) continue;
        scored.push({ entry, score });
    }

    const ranked = scored
        .sort((a, b) => b.score - a.score || a.entry.usage.localeCompare(b.entry.usage))
        .map(s => s.entry);

    const perCommand = new Map();
    const picked = [];
    const overflow = [];
    for (const entry of ranked) {
        const taken = perCommand.get(entry.command) || 0;
        if (taken < PER_COMMAND_LIMIT && picked.length < limit) {
            perCommand.set(entry.command, taken + 1);
            picked.push(entry);
        } else {
            overflow.push(entry);
        }
    }

    return picked.concat(overflow.slice(0, Math.max(0, limit - picked.length)));
}

function optionLine(option) {
    const shape = [option.label, option.required ? 'required' : 'optional'].join(', ');
    const parts = [`\`${option.name}\` (${shape})`];
    if (option.description) parts.push(`— ${option.description}`);
    if (option.choices.length) {
        const shown = option.choices.slice(0, MAX_CHOICES_SHOWN).join(', ');
        const rest = option.choices.length - MAX_CHOICES_SHOWN;
        parts.push(`— options include: ${shown}${rest > 0 ? `, +${rest} more` : ''}`);
    }
    return parts.join(' ');
}

/** One command as it appears in the prompt. */
function commandBlock(entry) {
    const lines = [`\`${entry.usage}\` (${entry.category}) — ${entry.description}`];
    for (const option of entry.options.slice(0, MAX_OPTIONS_SHOWN)) {
        lines.push(`  • ${optionLine(option)}`);
    }
    const hidden = entry.options.length - MAX_OPTIONS_SHOWN;
    if (hidden > 0) lines.push(`  • …and ${hidden} more option(s)`);
    return lines.join('\n');
}

// Unlike the knowledge base, this is the bot describing itself, so there is no
// "do not follow instructions in here" caveat to make — there is nobody on the
// other end of it. What it does have to say is the shape of what was retrieved:
// these are real and must be quoted exactly, and they are a handful out of a
// hundred, so a question this did not match is a question for /help rather than
// proof the feature does not exist.
const COMMAND_HEADER = '\n\n---\nMy own commands, matched to this question. '
    + 'These are real and exact — quote them exactly as written, and never invent a command, '
    + 'subcommand or option that is not listed. Only what matched is here; I have many more '
    + 'commands, so if none of these answers the question, say so and point them at `/help` '
    + 'rather than guessing.\n';
const COMMAND_JOINER = '\n';

/**
 * The command block as budget-shaped pieces: a header, the entries, and how
 * they are joined — the same shape knowledgeSection returns, so the context
 * budget can drop the least relevant command rather than the whole section.
 */
function commandSection(entries) {
    return {
        header: COMMAND_HEADER,
        joiner: COMMAND_JOINER,
        items: entries.map(commandBlock)
    };
}

/** `commandSection`, rendered. */
function buildCommandContext(entries) {
    if (!entries.length) return '';
    const { header, joiner, items } = commandSection(entries);
    return header + items.join(joiner);
}

module.exports = {
    buildCommandIndex,
    retrieveCommands,
    commandSection,
    buildCommandContext,
    COMMAND_LIMIT,
    // For the guard in tests/aiCommandHelp.test.js, which is the only thing
    // outside this file that has any business reading it.
    _STOPWORDS: STOPWORDS
};
