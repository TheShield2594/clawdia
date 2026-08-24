#!/usr/bin/env node
'use strict';

// Renders FEATURES.md's dashboard section list from the dashboard itself.
//
// The list was hand-written and had drifted: it enumerated 20 sections when 25
// panels existed, with Exploration and Newspaper missing entirely (#705). A
// later edit brought it to 22 entries but introduced a different error — a
// "Daily News" section that is part of the RSS panel, not a panel of its own —
// which is the shape a hand-maintained list of 25 things always ends up in.
//
//   npm run docs:panels             rewrite the block in FEATURES.md
//   npm run docs:panels -- --check  exit 1 if the block is out of date
//
// `--check` is what tests/panelDocs.test.js runs, so adding, renaming, moving
// or removing a panel turns `npm test` red until the block is regenerated.
//
// ── Where each column comes from ────────────────────────────────────────────
//
// Nothing here is written twice. The group, order, emoji and label are read off
// the sidebar in guild-settings.ejs, because that is the structure a reader of
// the docs is going to see on screen — a list in a different order, or using
// different names, is a list they have to translate.
//
// The description is the first sentence of the panel's own `<p>` under
// `.panel-head`, so it lives with the markup it describes and is read by anyone
// editing that panel. A panel whose head has no paragraph — overview, which
// opens on a greeting rather than a description — declares one instead:
//
//     <%# summary: Server stats, the setup checklist and quick settings. %>
//
// A panel with neither fails the build rather than being rendered blank.
//
// ── What it cross-checks ────────────────────────────────────────────────────
//
// Three lists have to agree: the panel templates on disk, the PANELS array that
// the panel endpoint validates against, and the sidebar. A panel missing from
// any one of them is broken in a way that is invisible until someone clicks the
// tab, so a disagreement is an error here rather than a quiet omission from the
// table.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'dashboard', 'views');
const PANEL_DIR = path.join(VIEWS, 'partials', 'panels');
const SIDEBAR = path.join(VIEWS, 'guild-settings.ejs');
const PANELS_MODULE = path.join(ROOT, 'src', 'dashboard', 'lib', 'panels.js');
const DOC_PATH = path.join(ROOT, 'FEATURES.md');

const BEGIN = '<!-- BEGIN GENERATED PANELS — npm run docs:panels -->';
const END = '<!-- END GENERATED PANELS -->';

const SUMMARY_MAX = 200;

// One sidebar entry. The markup is written on a single line per panel, which is
// what lets this stay a regex rather than an HTML parse.
const NAV_ITEM_RE = /<button[^>]*\bclass="nav-item[^"]*"[^>]*\bdata-tab="([\w-]+)"[^>]*>\s*<span class="nav-emoji"[^>]*>([^<]*)<\/span>\s*<span>([^<]+)<\/span>/;
// The group heading above each `<ul>`; `// Configure` renders as "Configure".
const NAV_GROUP_RE = /<div class="dash-nav-label"[^>]*>\/\/\s*([^<]+)<\/div>/;
// Anything else that declares a tab. Matching one of these means the parser has
// gone blind to a real panel, which is the drift a generated list exists to stop.
const SUSPECT_RE = /\bdata-tab="/;

/** Decodes the handful of entities the sidebar and panel copy actually use. */
function decodeEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

/**
 * The sidebar sections, in the order they are rendered.
 *
 * @returns {Array<{panel: string, label: string, emoji: string, group: string}>}
 */
function parseSidebar() {
    const lines = fs.readFileSync(SIDEBAR, 'utf8').split('\n');
    const items = [];
    let group = null;

    lines.forEach((line, index) => {
        const heading = NAV_GROUP_RE.exec(line);
        if (heading) {
            group = decodeEntities(heading[1]).trim();
            return;
        }

        const item = NAV_ITEM_RE.exec(line);
        if (!item) {
            // The panel stubs carry data-panel, not data-tab; only nav buttons
            // should match here.
            if (SUSPECT_RE.test(line)) {
                throw new Error(
                    `guild-settings.ejs:${index + 1} declares a tab this generator cannot read:\n    ${line.trim()}`
                );
            }
            return;
        }

        const [, panel, emoji, label] = item;
        if (!group) {
            throw new Error(`guild-settings.ejs:${index + 1} — the "${panel}" tab appears above any // group heading.`);
        }

        items.push({ panel, label: decodeEntities(label).trim(), emoji: emoji.trim(), group });
    });

    if (!items.length) throw new Error('guild-settings.ejs has no sidebar nav items — has the sidebar markup changed?');
    return items;
}

/**
 * The first sentence of a panel's description.
 *
 * Prefers an explicit `<%# summary: … %>` declaration, and otherwise reads the
 * `<p>` inside the panel's `.panel-head`.
 *
 * @param {string} panel basename without extension
 * @returns {string} may be empty, which the caller treats as an error
 */
function summaryOf(panel) {
    const source = fs.readFileSync(path.join(PANEL_DIR, `${panel}.ejs`), 'utf8');

    const declared = /<%#[\s\S]*?\bsummary:\s*([\s\S]*?)%>/.exec(source);
    const head = /class="panel-head"[\s\S]{0,400}?<p>([\s\S]*?)<\/p>/.exec(source);
    const raw = declared ? declared[1] : head ? head[1] : null;
    if (raw === null) return '';

    const text = decodeEntities(
        raw
            // <code>/explore</code> reads as `/explore` in a markdown table.
            .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
            .replace(/<[^>]+>/g, '')
    ).replace(/\s+/g, ' ').trim();

    const sentence = /^(.*?[.!?])(\s|$)/.exec(text);
    return (sentence ? sentence[1] : text).replace(/\.$/, '');
}

/** The PANELS array the panel endpoint validates against. */
function declaredPanels() {
    // Required rather than parsed: it is a plain module with no side effects,
    // and requiring it means this cannot disagree with what the server loads.
    return require(PANELS_MODULE).PANELS;
}

/** Panel template basenames on disk. */
function panelsOnDisk() {
    return fs.readdirSync(PANEL_DIR).filter(f => f.endsWith('.ejs')).map(f => f.replace(/\.ejs$/, ''));
}

/**
 * Every dashboard section, in sidebar order, with the three sources checked
 * against each other first.
 */
function parseAll() {
    const sidebar = parseSidebar();
    const declared = declaredPanels();
    const onDisk = panelsOnDisk();

    const sorted = list => [...list].sort();
    const inSidebar = sidebar.map(item => item.panel);

    const duplicated = inSidebar.filter((panel, i) => inSidebar.indexOf(panel) !== i);
    if (duplicated.length) {
        throw new Error(`the sidebar lists these tabs twice: ${sorted(new Set(duplicated)).join(', ')}`);
    }

    const missingTemplate = inSidebar.filter(panel => !onDisk.includes(panel));
    if (missingTemplate.length) {
        throw new Error(
            `the sidebar links tabs with no template in partials/panels/: ${missingTemplate.join(', ')}\n` +
            '    Clicking one of these fetches a panel that does not exist.'
        );
    }

    const unlisted = onDisk.filter(panel => !inSidebar.includes(panel));
    if (unlisted.length) {
        throw new Error(
            `these panels exist but the sidebar has no tab for them: ${sorted(unlisted).join(', ')}\n` +
            '    A panel nobody can navigate to is the drift this list exists to catch.'
        );
    }

    if (sorted(declared).join() !== sorted(inSidebar).join()) {
        const notDeclared = inSidebar.filter(panel => !declared.includes(panel));
        const notInSidebar = declared.filter(panel => !inSidebar.includes(panel));
        throw new Error(
            'src/dashboard/lib/panels.js and the sidebar disagree.\n' +
            (notDeclared.length ? `    PANELS is missing: ${sorted(notDeclared).join(', ')} — the panel endpoint will 404 these.\n` : '') +
            (notInSidebar.length ? `    PANELS has no sidebar tab: ${sorted(notInSidebar).join(', ')}\n` : '')
        );
    }

    return sidebar.map(item => {
        const summary = summaryOf(item.panel);
        if (!summary) {
            throw new Error(
                `partials/panels/${item.panel}.ejs has no description.\n` +
                '    Add a <p> to its .panel-head, or declare one with <%# summary: … %>;\n' +
                "    it becomes the section's row in FEATURES.md."
            );
        }
        if (summary.length > SUMMARY_MAX) {
            throw new Error(
                `partials/panels/${item.panel}.ejs — description is ${summary.length} characters, over ${SUMMARY_MAX}.\n` +
                '    The first sentence goes in a table cell; keep it to one line and put the detail in the sentences after it.'
            );
        }
        return { ...item, summary };
    });
}

function escapeCell(text) {
    return text.replace(/\|/g, '\\|');
}

/** The markdown between the two markers, marker lines excluded. */
function renderPanels(sections) {
    const groups = [];
    for (const section of sections) {
        const last = groups[groups.length - 1];
        if (last && last.group === section.group) last.sections.push(section);
        else groups.push({ group: section.group, sections: [section] });
    }

    const rendered = groups.map(({ group, sections: rows }) => [
        `### ${group}`,
        '',
        '| Section | What it configures |',
        '| --- | --- |',
        ...rows.map(row => `| ${row.emoji} **${escapeCell(row.label)}** | ${escapeCell(row.summary)} |`),
    ].join('\n'));

    return [
        `_Generated by \`npm run docs:panels\` from the dashboard sidebar and \`src/dashboard/views/partials/panels/\` — ` +
        `${sections.length} sections, in the order the sidebar shows them. Edit the panels, not this table._`,
        ...rendered,
    ].join('\n\n');
}

/** @returns {string} the file with the block replaced */
function replaceBlock(doc, body) {
    const start = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`FEATURES.md is missing the ${BEGIN} / ${END} markers`);
    }
    return `${doc.slice(0, start)}${BEGIN}\n\n${body}\n\n${doc.slice(end)}`;
}

function buildDoc() {
    const current = fs.readFileSync(DOC_PATH, 'utf8');
    return { current, next: replaceBlock(current, renderPanels(parseAll())) };
}

function main(argv) {
    const check = argv.includes('--check');
    const { current, next } = buildDoc();

    if (current === next) {
        console.log('FEATURES dashboard section list is up to date.');
        return 0;
    }

    if (check) {
        console.error('FEATURES dashboard section list is out of date. Run `npm run docs:panels`.');
        return 1;
    }

    fs.writeFileSync(DOC_PATH, next);
    console.log('FEATURES dashboard section list regenerated.');
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
    parseSidebar,
    summaryOf,
    renderPanels,
    replaceBlock,
    buildDoc,
    declaredPanels,
    panelsOnDisk,
    BEGIN,
    END,
    DOC_PATH,
    PANEL_DIR,
    SIDEBAR,
};
