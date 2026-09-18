'use strict';

// Command name/description localizations, applied to every command's builder at
// load time so Discord renders the command surface in each viewer's own client
// locale (#1014). `setNameLocalizations`/`setDescriptionLocalizations` appear in
// no command file — they are applied here, from data — so adding a language, or
// a translation, never touches a command's own source.
//
// ── How it fits together ────────────────────────────────────────────────────
//
// One JSON file per language under src/locales, shaped to mirror a command:
//
//   {
//     "help": {
//       "name": "ayuda",
//       "description": "…",
//       "options": {
//         "category": { "description": "…", "options": { … } }
//       }
//     }
//   }
//
// `applyLocalizations` is called from the command loader for every command, so
// the localizations are part of what `buildCommandPayload` serialises — which
// means `commandSetHash` changes when a translation is edited, and the boot-time
// deploy republishes on its own (the same "the catalogue changed" path a new
// command takes). `/help` reads the same localizations off the builder to render
// each command's name in the viewer's locale.
//
// ── The contract the coverage check enforces ────────────────────────────────
//
// tests/commandLocalizations.test.js fails the suite when a command or option is
// missing from any locale file, the way tests/envExampleDrift.test.js does for
// `.env.example` — so a command cannot ship untranslated by accident. The
// contract, spelled out in `missingLocalizations`:
//
//   - every command needs a localized `name` and `description`;
//   - every option (including subcommands and groups) needs a localized
//     `description`;
//   - a localized `name` is optional on options, because a localized command or
//     option *name* has to satisfy Discord's identifier rules — lowercase, ≤32,
//     and the name regex — and the viewer-facing surface /help renders is the
//     command names, which are covered by the first rule.
//
// Start with the languages the bot's operators actually run; the test makes
// adding another a data change — a new file under src/locales — rather than a
// code change here.

const fs = require('fs');
const path = require('path');
// Destructured defensively: several tests mock discord.js down to the two or
// three exports they use, so `Locale` can be absent. It is only needed by the
// coverage check (`missingLocalizations`), which runs against the real module.
const { Locale } = require('discord.js') || {};

const LOCALES_DIR = path.join(__dirname, '..', 'locales');

// Discord's own name rule, applied to localized names so a bad one is caught by
// the test here rather than by Discord rejecting the entire deploy payload.
const NAME_RE = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
const DESCRIPTION_MAX = 100;

// The set of locale codes Discord accepts, so a mistyped filename
// (`es_ES.json`, `pt.json`) is a failed test rather than a silently ignored
// file.
const VALID_LOCALES = new Set(Object.values(Locale || {}));

let cache = null;

/**
 * Load every `src/locales/<lang>.json`, cached for the life of the process.
 *
 * @returns {{locales: Object<string, object>, langs: string[]}}
 */
function loadLocales() {
    if (cache) return cache;

    const locales = {};
    let files;
    try {
        files = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
    } catch (error) {
        // A missing directory is a valid state — the bot runs in English only.
        // Any other read failure (a permissions problem, an I/O error) is not
        // "no locales", it is a broken deployment, and swallowing it here would
        // silently ship every server the English surface (#1013 review).
        if (error.code !== 'ENOENT') throw error;
        cache = { locales: {}, langs: [] };
        return cache;
    }

    for (const file of files) {
        const lang = path.basename(file, '.json');
        locales[lang] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
    }

    cache = { locales, langs: Object.keys(locales) };
    return cache;
}

/** Testing seam: drop the cache so a test can point the loader at fixtures. */
function _resetCache() {
    cache = null;
}

/**
 * Apply the loaded localizations to one command builder, in place.
 *
 * Walks the builder and its option tree, setting name and description
 * localizations from whichever locales carry an entry for each node. A node with
 * no entry in a given locale is left in the base language for that locale, which
 * is exactly how Discord falls back — so a partial file degrades to English
 * rather than breaking, and the coverage test is what stops it being partial.
 *
 * @param {object} builder a SlashCommandBuilder (or option/subcommand builder)
 * @param {object} [locales] injectable; defaults to the loaded set
 */
function applyLocalizations(builder, locales = loadLocales().locales) {
    const langs = Object.keys(locales);
    if (!langs.length) return builder;

    const rootEntries = {};
    for (const lang of langs) rootEntries[lang] = locales[lang]?.[builder.name];
    applyToNode(builder, rootEntries);
    return builder;
}

function applyToNode(node, entriesByLang) {
    const nameMap = {};
    const descMap = {};

    for (const [lang, entry] of Object.entries(entriesByLang)) {
        if (!entry) continue;
        if (entry.name && typeof node.setNameLocalizations === 'function') nameMap[lang] = entry.name;
        if (entry.description && typeof node.setDescriptionLocalizations === 'function') descMap[lang] = entry.description;
    }

    if (Object.keys(nameMap).length) node.setNameLocalizations(nameMap);
    if (Object.keys(descMap).length) node.setDescriptionLocalizations(descMap);

    // `.options` holds the child builders on both the command and every
    // subcommand/group; a leaf option has none. Recurse by name so the locale
    // tree is matched to the builder tree rather than to positions that can move.
    for (const child of node.options || []) {
        const childEntries = {};
        for (const [lang, entry] of Object.entries(entriesByLang)) {
            childEntries[lang] = entry?.options?.[child.name];
        }
        applyToNode(child, childEntries);
    }
}

/**
 * The command name, localized for a locale when a localization exists.
 *
 * Used by /help so a viewer sees each command under the name Discord shows them.
 * Reads the localizations already applied to the builder, so there is no second
 * source to keep in step.
 */
function localizedName(commandData, locale) {
    return commandData?.name_localizations?.[locale] || commandData?.name;
}

/** As localizedName, for the description. */
function localizedDescription(commandData, locale) {
    return commandData?.description_localizations?.[locale] || commandData?.description;
}

/**
 * The coverage gaps and malformed entries across every locale file, as a flat
 * list of human-readable strings. Empty means every command and option is
 * translated in every locale and every localized name is one Discord will
 * accept.
 *
 * @param {Array<object>} commandDatas the built command JSON bodies
 *   (`command.data.toJSON()`), which carry the full name/option tree.
 * @param {object} [locales]
 * @returns {string[]}
 */
function missingLocalizations(commandDatas, locales = loadLocales().locales) {
    const problems = [];
    const langs = Object.keys(locales);

    for (const [lang, data] of Object.entries(locales)) {
        if (!VALID_LOCALES.has(lang)) {
            problems.push(`locale "${lang}" is not a Discord locale code`);
        }
        // A key in a locale file that names no command is a translation nobody
        // will ever see — usually a command that was renamed or removed.
        const commandNames = new Set(commandDatas.map(c => c.name));
        for (const key of Object.keys(data)) {
            if (!commandNames.has(key)) problems.push(`${lang}: \`${key}\` matches no command`);
        }
    }

    for (const command of commandDatas) {
        for (const lang of langs) {
            checkNode(command, locales[lang]?.[command.name], `${lang}:${command.name}`, true, problems);
        }
    }

    // Discord requires command names to be unique within a locale, exactly as
    // the base names are — a collision is rejected for the whole payload, so it
    // is caught here rather than at deploy.
    for (const lang of langs) {
        const seen = new Map();
        for (const command of commandDatas) {
            const localized = locales[lang]?.[command.name]?.name;
            if (!localized) continue;
            if (seen.has(localized)) {
                problems.push(`${lang}: localized name "${localized}" is used by both ${seen.get(localized)} and ${command.name}`);
            } else {
                seen.set(localized, command.name);
            }
        }
    }

    return problems;
}

function checkNode(node, entry, label, isCommand, problems) {
    if (!entry) {
        problems.push(`${label} — no localization entry`);
        return;
    }

    // Every node owes a description; only commands owe a name (see the header).
    if (!entry.description) {
        problems.push(`${label} — missing description`);
    } else if (entry.description.length > DESCRIPTION_MAX) {
        problems.push(`${label} — description is ${entry.description.length} chars (max ${DESCRIPTION_MAX})`);
    }

    if (isCommand && !entry.name) {
        problems.push(`${label} — missing name`);
    }

    // A localized name, wherever one is given, must be one Discord will accept —
    // a bad one is rejected as part of the whole payload, taking every command
    // down with it.
    if (entry.name) {
        if (entry.name !== entry.name.toLowerCase() || !NAME_RE.test(entry.name)) {
            problems.push(`${label} — localized name "${entry.name}" is not a valid Discord command name`);
        }
    }

    for (const option of node.options || []) {
        checkNode(option, entry.options?.[option.name], `${label}.${option.name}`, false, problems);
    }
}

module.exports = {
    LOCALES_DIR,
    loadLocales,
    applyLocalizations,
    localizedName,
    localizedDescription,
    missingLocalizations,
    VALID_LOCALES,
    _resetCache,
};
