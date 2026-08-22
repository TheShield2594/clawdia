'use strict';

// The command catalog /help renders.
//
// This used to be a hand-maintained literal inside help.js, and it had drifted:
// 37 of 98 commands were missing from it, and it advertised four casino games
// that had been removed a release earlier (#665). Nothing kept the two in step,
// and nothing could — a parallel list of every command is a list that is wrong
// the moment someone adds a file.
//
// So the catalog is derived instead, from the collection the process is running:
// the name and description come from each command's own SlashCommandBuilder, and
// the category from the folder it was loaded out of (stamped by commandLoader).
// A new command file is in /help as soon as it is in `client.commands`, with no
// second place to update.

// How each category is presented, and the order the categories appear in. This
// is the only hand-written part, and it is presentation only: a folder missing
// from here still shows up, under a generated label. Adding an entry changes how
// a category looks, never which commands are in it.
const CATEGORY_META = new Map([
    ['economy',    { emoji: '📦',  label: 'Economy' }],
    ['moderation', { emoji: '🛡️', label: 'Moderation' }],
    ['leveling',   { emoji: '⭐',  label: 'Leveling' }],
    ['fun',        { emoji: '🎮',  label: 'Fun' }],
    ['utility',    { emoji: '🔧',  label: 'Utility' }],
    ['ai',         { emoji: '🤖',  label: 'AI' }],
    ['community',  { emoji: '👥',  label: 'Community' }],
    ['admin',      { emoji: '⚙️',  label: 'Admin' }],
]);

const FALLBACK_META = { emoji: '📁' };

// Things a reader can use that are not slash commands, so they have no command
// file to be discovered from. Only added to a category that already has
// commands, so removing the AI commands does not leave a category behind.
const EXTRA_ENTRIES = new Map([
    ['ai', [{ name: '@Clawdia', description: 'Mention or ping the bot to start an AI conversation', mention: true }]],
]);

// Commands named in the category preview line before it is elided.
const PREVIEW_COMMANDS = 4;

// Discord rejects a select option whose description runs past this.
const SELECT_DESCRIPTION_LIMIT = 100;

function labelFor(id) {
    return id.charAt(0).toUpperCase() + id.slice(1);
}

function truncate(text, limit) {
    return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Build the category list /help renders.
 *
 * @param {Iterable<object>} commands loaded command modules — `client.commands.values()`
 *   at runtime. Each needs a `data.name`; `data.description` and `category` are
 *   used when present.
 * @returns {Array<{id: string, emoji: string, label: string, preview: string,
 *   summary: string, commands: Array<{name: string, description: string, mention?: boolean}>}>}
 *   Categories in CATEGORY_META order, then any unrecognised folder alphabetically.
 *   Empty when nothing was loaded — callers have to cope, because a select menu
 *   with no options is a Discord error rather than an empty menu.
 */
function buildCategories(commands) {
    const byCategory = new Map();

    for (const command of commands || []) {
        const name = command?.data?.name;
        if (!name) continue;
        const id = command.category || 'other';
        if (!byCategory.has(id)) byCategory.set(id, []);
        byCategory.get(id).push({
            name,
            description: command.data.description || 'No description provided',
        });
    }

    for (const [id, extras] of EXTRA_ENTRIES) {
        if (byCategory.has(id)) byCategory.get(id).push(...extras.map(entry => ({ ...entry })));
    }

    const known = [...CATEGORY_META.keys()].filter(id => byCategory.has(id));
    const unknown = [...byCategory.keys()].filter(id => !CATEGORY_META.has(id)).sort();

    return [...known, ...unknown].map(id => {
        const meta = CATEGORY_META.get(id) || { ...FALLBACK_META, label: labelFor(id) };
        const entries = byCategory.get(id).sort((a, b) => a.name.localeCompare(b.name));
        const names = entries.map(entry => entry.name);
        const preview = names.length > PREVIEW_COMMANDS
            ? `${names.slice(0, PREVIEW_COMMANDS).join(', ')}, …`
            : names.join(', ');

        return {
            id,
            emoji: meta.emoji,
            label: meta.label,
            preview,
            summary: truncate(`${entries.length} commands: ${preview}`, SELECT_DESCRIPTION_LIMIT),
            commands: entries,
        };
    });
}

module.exports = { buildCategories, CATEGORY_META, SELECT_DESCRIPTION_LIMIT };
