#!/usr/bin/env node
'use strict';

// Renders README's "Shape of the codebase" table from the command tree itself.
//
// The table was hand-written, and it had drifted the way every hand-written
// count does (#916): it claimed 43 economy commands against 42 on disk, 22,572
// economy lines against 25,319, 332 AI lines against 935, and a `/fish` that
// was "3,190 lines" as a single file months after #721 split it into a folder.
// The front page was the one doc block in this repo without a drift test, next
// to docs/COMMANDS.md, docs/API_REFERENCE.md, docs/FEATURES.md and
// .env.example, which all have one.
//
// The counts come from the same walk the loader, the deployer and the command
// cap use (utils/commandLoader), so "commands" here means exactly what it means
// everywhere else: `<category>/<name>.js`, or `<category>/<name>/index.js` for
// one that has outgrown a file. Lines are every `.js` under the category
// folder, siblings of a split command included — `/fish` is nine modules and
// counting it as one file is how the old figure went wrong.
//
//   npm run docs:shape              rewrite the block in README.md
//   npm run docs:shape -- --check   exit 1 if the block is out of date
//
// `--check` is what tests/shapeDocs.test.js runs on, so adding a command or a
// few hundred lines turns `npm test` red until the block is regenerated.

const fs = require('fs');
const path = require('path');

const { listCommandFiles } = require('../src/utils/commandLoader');

const DOC_PATH = path.join(__dirname, '..', 'README.md');
const COMMANDS_ROOT = path.join(__dirname, '..', 'src', 'commands');
const BEGIN = '<!-- BEGIN GENERATED SHAPE — npm run docs:shape -->';
const END = '<!-- END GENERATED SHAPE -->';

// How each category is named in the table, and nothing else. A folder missing
// from here is still counted, under its capitalised folder name — the same
// arrangement utils/helpCatalog uses, and for the same reason: presentation is
// the only part of this worth hand-maintaining.
const AREA_LABELS = new Map([
    ['economy', 'Economy / RPG'],
    ['ai', 'AI'],
]);

// The command whose size is the point of the sentence under the table.
const HEADLINE_COMMAND = { category: 'economy', name: 'fish' };

function labelFor(id) {
    return AREA_LABELS.get(id) || id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Lines in a file, counted the way `wc -l` counts them — newlines, so a file
 * is not credited with a line for its trailing one.
 *
 * @param {string} file
 * @returns {number}
 */
function lineCount(file) {
    const text = fs.readFileSync(file, 'utf8');
    let lines = 0;
    for (let at = 0; at < text.length; at++) {
        if (text[at] === '\n') lines++;
    }
    return lines;
}

/**
 * Every `.js` file under a directory, at any depth. `/fish` keeps its shop
 * handlers in a subfolder, so a single-level read would miss them.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function jsFilesUnder(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...jsFilesUnder(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
    }
    return found;
}

/**
 * One row per category folder, largest first.
 *
 * @param {string} [root] command tree to measure; defaults to src/commands
 * @returns {Array<{id: string, label: string, commands: number, lines: number}>}
 */
function measureAreas(root = COMMANDS_ROOT) {
    const commandsPerCategory = new Map();
    for (const { dir } of listCommandFiles(root)) {
        commandsPerCategory.set(dir, (commandsPerCategory.get(dir) || 0) + 1);
    }

    const areas = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => ({
            id: entry.name,
            label: labelFor(entry.name),
            commands: commandsPerCategory.get(entry.name) || 0,
            lines: jsFilesUnder(path.join(root, entry.name)).reduce((sum, f) => sum + lineCount(f), 0),
        }));

    // A sweep that derives its own input reports the same output for "the tree
    // is empty" as for "the tree could not be read".
    if (!areas.length) throw new Error(`no command categories found under ${root}`);

    return areas.sort((a, b) => b.lines - a.lines || a.label.localeCompare(b.label));
}

/**
 * The categories that together still come to less than `lines`, smallest
 * first. What the sentence under the table compares `/fish` against — computed,
 * because "more than the moderation, leveling, AI, and admin command sets put
 * together" is a claim that goes stale as quietly as any number.
 *
 * @param {Array<{label: string, lines: number}>} areas
 * @param {number} lines
 * @param {string} excludeId category the headline command is in
 * @returns {{areas: Array<{label: string, lines: number}>, total: number}}
 *   `areas` largest first, in the order the sentence reads them
 */
function areasOutweighedBy(areas, lines, excludeId) {
    const smallestFirst = areas.filter(a => a.id !== excludeId).sort((a, b) => a.lines - b.lines);
    const taken = [];
    let total = 0;
    for (const area of smallestFirst) {
        if (total + area.lines >= lines) break;
        taken.push(area);
        total += area.lines;
    }
    return { areas: taken.reverse(), total };
}

const thousands = n => n.toLocaleString('en-US');

/**
 * A sentence naming the areas the headline command outweighs, or null when it
 * outweighs none of them — in which case the claim should not be made at all.
 *
 * @param {Array<object>} areas
 * @param {number} lines size of the headline command
 * @param {number} modules files the headline command is split across
 * @returns {string}
 */
function headlineSentence(areas, lines, modules) {
    const { areas: outweighed, total } = areasOutweighedBy(areas, lines, HEADLINE_COMMAND.category);
    const size = `\`/${HEADLINE_COMMAND.name}\` alone is ${thousands(lines)} lines`;
    // Naming one area is not worth the sentence, and naming none would leave
    // "more than the  command sets put together".
    if (outweighed.length < 2) return `${size}, across ${modules} modules.`;

    const names = outweighed.map(a => a.label);
    const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${size} — more than the ${list} command sets put together (${thousands(total)}).`;
}

/**
 * The markdown between the two markers, marker lines excluded.
 *
 * @param {Array<object>} areas as returned by measureAreas
 * @param {number} headlineLines size of the headline command
 * @param {number} headlineModules files it is split across
 * @returns {string}
 */
function renderShape(areas, headlineLines, headlineModules) {
    const rows = areas.map(a => `| ${a.label} | ${thousands(a.commands)} | ${thousands(a.lines)} |`);
    const commands = areas.reduce((sum, a) => sum + a.commands, 0);
    const lines = areas.reduce((sum, a) => sum + a.lines, 0);

    return [
        '_Generated by `npm run docs:shape` from the command tree. Edit the commands, not this table._',
        [
            '| Area | Commands | Lines |',
            '|---|---:|---:|',
            ...rows,
            `| **Total** | **${thousands(commands)}** | **${thousands(lines)}** |`,
        ].join('\n'),
        headlineSentence(areas, headlineLines, headlineModules),
    ].join('\n\n');
}

/**
 * @param {string} doc current file contents
 * @param {string} body rendered markdown
 * @returns {string} the file with the block replaced
 */
function replaceBlock(doc, body) {
    const start = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`README.md is missing the ${BEGIN} / ${END} markers`);
    }
    return `${doc.slice(0, start)}${BEGIN}\n\n${body}\n\n${doc.slice(end)}`;
}

function buildDoc() {
    const areas = measureAreas();
    const headlineDir = path.join(COMMANDS_ROOT, HEADLINE_COMMAND.category, HEADLINE_COMMAND.name);
    // The headline command is a folder because it outgrew a file. If it is ever
    // folded back into one, say so rather than quietly measuring nothing.
    if (!fs.existsSync(headlineDir)) {
        throw new Error(`/${HEADLINE_COMMAND.name} is no longer a folder — update HEADLINE_COMMAND`);
    }
    const headlineFiles = jsFilesUnder(headlineDir);
    const headlineLines = headlineFiles.reduce((sum, f) => sum + lineCount(f), 0);

    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    const body = renderShape(areas, headlineLines, headlineFiles.length);
    return { current: doc, next: replaceBlock(doc, body) };
}

function main(argv) {
    const check = argv.includes('--check');
    const { current, next } = buildDoc();

    if (current === next) {
        console.log('README.md is up to date.');
        return 0;
    }

    if (check) {
        console.error('README.md is out of date. Run `npm run docs:shape`.');
        return 1;
    }

    fs.writeFileSync(DOC_PATH, next);
    console.log('README.md regenerated.');
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    measureAreas,
    areasOutweighedBy,
    headlineSentence,
    renderShape,
    replaceBlock,
    buildDoc,
    lineCount,
    jsFilesUnder,
    BEGIN,
    END,
    DOC_PATH,
};
