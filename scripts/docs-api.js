#!/usr/bin/env node
'use strict';

// Renders API_REFERENCE.md's endpoint tables from the routers that serve them.
//
// The file used to be a cookbook of generic Express and Discord.js snippets
// whose only endpoint example was a `/api/custom/:guildId` that has never
// existed, while the 46 real endpoints under src/dashboard/routes/api/ were
// documented nowhere (#711). A hand-written list of that many routes drifts the
// same week it is written, so this generates it instead.
//
//   npm run docs:api             rewrite the block in API_REFERENCE.md
//   npm run docs:api -- --check  exit 1 if the block is out of date
//
// `--check` is what tests/apiDocs.test.js runs, so adding, moving or renaming a
// route turns `npm test` red until the block is regenerated.
//
// ── The one thing an author has to write ────────────────────────────────────
//
// Everything but the summary is read off the route: the method, the path, and
// the middleware chain that says who may call it. The summary is the `//`
// comment block immediately above `router.<method>(`, up to the end of its
// first sentence, so it lives with the code it describes and is read by anyone
// editing the handler. A route with no comment above it fails the build rather
// than being rendered blank.
//
// A route that also needs a long design note keeps the note as a separate
// paragraph — a blank line ends the block this reads.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'src', 'dashboard', 'routes', 'api');
const API_INDEX = path.join(ROOT, 'src', 'dashboard', 'routes', 'api.js');
const DOC_PATH = path.join(ROOT, 'API_REFERENCE.md');

const BEGIN = '<!-- BEGIN GENERATED ENDPOINTS — npm run docs:api -->';
const END = '<!-- END GENERATED ENDPOINTS -->';

// Where the whole router is mounted in server.js. Paths inside the sub-routers
// are absolute below this and are rendered with it prefixed, because that is
// what a caller types.
const MOUNT = '/api';

const SUMMARY_MAX = 200;

// How each middleware reads in the "Requires" column. A route's chain is
// rendered in this order, not the order it happens to be written in, so the
// column is scannable down the page.
const MIDDLEWARE_LABELS = [
    ['checkAuth', 'session'],
    ['checkGuildAccess', 'guild admin'],
    ['checkWriteRateLimit', 'write limit'],
    ['uploadImage', 'multipart'],
];

const ROUTE_RE = /^router\.(get|post|put|patch|delete|all)\(\s*'([^']+)'\s*,([^)]*)/;
// Anything else that looks like a route definition. Matching one of these means
// this parser has gone blind to a real endpoint, which is the failure mode a
// generated list exists to prevent, so it is an error rather than a skip.
const SUSPECT_RE = /router\.(get|post|put|patch|delete|all|route|use)\s*\(/;

/** Sub-router filenames in the order routes/api.js mounts them. */
function mountOrder() {
    const source = fs.readFileSync(API_INDEX, 'utf8');
    return [...source.matchAll(/require\('\.\/api\/(\w+)'\)/g)].map(m => m[1]);
}

/**
 * The `//` comment block directly above `lineIndex`, as one line, cut at the
 * end of its first sentence.
 *
 * @param {string[]} lines file split on newlines
 * @param {number} lineIndex index of the `router.<method>(` line
 * @returns {string} may be empty, which the caller treats as an error
 */
function summaryAbove(lines, lineIndex) {
    const block = [];
    for (let i = lineIndex - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith('//')) break;
        block.unshift(line.replace(/^\/\/\s?/, ''));
    }

    const text = block.join(' ').replace(/\s+/g, ' ').trim();
    const sentence = /^(.*?[.!?])(\s|$)/.exec(text);
    return (sentence ? sentence[1] : text).replace(/\.$/, '');
}

/** The middleware names on a route definition line, in MIDDLEWARE_LABELS order. */
function requirements(argsText) {
    const named = new Set(
        argsText.split(',').map(part => part.trim()).filter(part => /^[A-Za-z_$][\w$]*$/.test(part))
    );
    const labels = MIDDLEWARE_LABELS.filter(([name]) => named.has(name)).map(([, label]) => label);
    return labels.length ? labels : ['public'];
}

/**
 * Every route in one sub-router file.
 *
 * @param {string} file basename without extension
 * @returns {{file: string, routes: Array<{method: string, path: string, requires: string[], summary: string}>}}
 */
function parseRouter(file) {
    const source = fs.readFileSync(path.join(API_DIR, `${file}.js`), 'utf8');
    const lines = source.split('\n');
    const routes = [];

    lines.forEach((line, index) => {
        const match = ROUTE_RE.exec(line);
        if (!match) {
            // `router.use` is middleware, not an endpoint, and only api.js has any.
            if (SUSPECT_RE.test(line) && !/^\s*router\.use\(/.test(line)) {
                throw new Error(`${file}.js:${index + 1} defines a route this generator cannot read:\n    ${line.trim()}`);
            }
            return;
        }

        const [, method, routePath, argsText] = match;
        const summary = summaryAbove(lines, index);
        if (!summary) {
            throw new Error(
                `${file}.js:${index + 1} — ${method.toUpperCase()} ${routePath} has no comment above it.\n` +
                '    Add a one-sentence // comment directly above the route; it becomes the summary in API_REFERENCE.md.'
            );
        }
        if (summary.length > SUMMARY_MAX) {
            throw new Error(
                `${file}.js:${index + 1} — ${method.toUpperCase()} ${routePath} summary is ${summary.length} characters, over ${SUMMARY_MAX}.\n` +
                '    The first sentence of the comment goes in a table cell; keep it to one line and put the detail in a paragraph below it.'
            );
        }

        routes.push({
            method: method.toUpperCase(),
            path: MOUNT + routePath,
            requires: requirements(argsText),
            summary,
        });
    });

    if (!routes.length) throw new Error(`${file}.js mounts no routes — is it still an API router?`);
    return { file, routes };
}

/** Every sub-router, in mount order. */
function parseAll() {
    const mounted = mountOrder();
    const onDisk = fs.readdirSync(API_DIR).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));

    const unmounted = onDisk.filter(f => !mounted.includes(f));
    if (unmounted.length) {
        throw new Error(`routes/api.js never mounts: ${unmounted.join(', ')}`);
    }

    return mounted.map(parseRouter);
}

function escapeCell(text) {
    return text.replace(/\|/g, '\\|');
}

/** The markdown between the two markers, marker lines excluded. */
function renderEndpoints(routers) {
    const total = routers.reduce((sum, r) => sum + r.routes.length, 0);

    const sections = routers.map(({ file, routes }) => {
        const rows = routes.map(route => {
            const path = `\`${route.path}\``;
            return `| \`${route.method}\` | ${escapeCell(path)} | ${route.requires.join(', ')} | ${escapeCell(route.summary)} |`;
        });
        return [
            `### \`${file}.js\``,
            '',
            '| Method | Path | Requires | Summary |',
            '| --- | --- | --- | --- |',
            ...rows,
        ].join('\n');
    });

    return [
        `_Generated by \`npm run docs:api\` from \`src/dashboard/routes/api/\` — ${total} endpoints. ` +
        'Edit the routes and their comments, not this table._',
        ...sections,
    ].join('\n\n');
}

/** @returns {string} the file with the block replaced */
function replaceBlock(doc, body) {
    const start = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`API_REFERENCE.md is missing the ${BEGIN} / ${END} markers`);
    }
    return `${doc.slice(0, start)}${BEGIN}\n\n${body}\n\n${doc.slice(end)}`;
}

function buildDoc() {
    const current = fs.readFileSync(DOC_PATH, 'utf8');
    return { current, next: replaceBlock(current, renderEndpoints(parseAll())) };
}

function main(argv) {
    const check = argv.includes('--check');
    const { current, next } = buildDoc();

    if (current === next) {
        console.log('API_REFERENCE endpoint tables are up to date.');
        return 0;
    }

    if (check) {
        console.error('API_REFERENCE endpoint tables are out of date. Run `npm run docs:api`.');
        return 1;
    }

    fs.writeFileSync(DOC_PATH, next);
    console.log('API_REFERENCE endpoint tables regenerated.');
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
    parseAll,
    parseRouter,
    renderEndpoints,
    replaceBlock,
    buildDoc,
    summaryAbove,
    requirements,
    BEGIN,
    END,
    DOC_PATH,
    API_DIR,
};
