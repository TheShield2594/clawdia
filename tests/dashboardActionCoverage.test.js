'use strict';

/**
 * #887. Every `onclick=""` on the dashboard became a `data-action`, dispatched
 * from delegated listeners in public/guild-settings.js. That trade is what let
 * `script-src-attr 'unsafe-inline'` be dropped, and it moves one failure mode:
 * an inline handler naming a function that does not exist throws a visible
 * ReferenceError in the console, while a `data-action` naming a case that does
 * not exist does nothing at all. A button that silently stops working is the
 * worse of the two.
 *
 * So the two sides are held together here. Every action name the markup uses
 * must be handled, and every case the dispatcher handles must be used by
 * something — a stale one is a case nobody can reach, which is how a rename
 * ends up half-done.
 */
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'dashboard', 'views');
const PUBLIC = path.join(ROOT, 'src', 'dashboard', 'public');

// Every one of the page's own scripts, not just guild-settings.js: the panels
// are separate files now (#935) and each registers the actions for its own
// markup, so a scan of one file would pass by finding nothing.
const scriptFiles = fs.readdirSync(PUBLIC, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.min.js'))
    .map(entry => entry.name)
    .sort();
const sources = scriptFiles.map(name => fs.readFileSync(path.join(PUBLIC, name), 'utf8'));
const script = sources.join('\n');

function viewFiles(dir = VIEWS) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...viewFiles(full));
        else if (entry.name.endsWith('.ejs')) found.push(full);
    }
    return found;
}

// Views plus the browser scripts: both render markup carrying these attributes,
// and a name that only one side knows is broken wherever it appears.
const markup = [
    ...viewFiles().map(file => fs.readFileSync(file, 'utf8')),
    ...sources,
].join('\n');

/**
 * The literal values of one data attribute across all of that markup.
 *
 * All three quoting forms HTML accepts, not just the double-quoted one: a
 * `data-action='save'` the scan could not see would be an action nobody
 * checked was dispatched, which is the failure this file exists to catch.
 * Values holding a `$` are skipped — those are template interpolations rather
 * than literal names, and no view has one today.
 */
function used(attribute) {
    const names = new Set();
    const pattern = new RegExp(`${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'gi');
    for (const match of markup.matchAll(pattern)) {
        const value = match[1] ?? match[2] ?? match[3];
        if (value && !value.includes('$')) names.add(value);
    }
    return names;
}

/**
 * Every action name registered for one event, across all of the page's scripts.
 *
 * Read from the syntax rather than by matching text: a handler table is an
 * argument to registerPanelActions() now, and it may be written in any of a
 * dozen files. Walking the calls is what makes the scan whole-page rather than
 * whole-file, which is the property this suite needs to keep after #935.
 */
function tableKeys(event) {
    const names = new Set();

    const collect = node => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'CallExpression'
            && node.callee.type === 'Identifier'
            && node.callee.name === 'registerPanelActions'
            && node.arguments[0]?.type === 'ObjectExpression') {
            for (const group of node.arguments[0].properties) {
                if (group.type !== 'Property') continue;
                const groupName = group.key.name ?? group.key.value;
                if (groupName !== event || group.value.type !== 'ObjectExpression') continue;
                for (const action of group.value.properties) {
                    if (action.type !== 'Property') continue;
                    names.add(action.key.value ?? action.key.name);
                }
            }
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (Array.isArray(child)) child.forEach(collect);
            else if (child && typeof child.type === 'string') collect(child);
        }
    };

    for (const source of sources) {
        collect(espree.parse(source, { ecmaVersion: 2024, sourceType: 'script' }));
    }
    return names;
}

const handledClicks = new Set([
    ...tableKeys('click'),
    // A couple are matched by their own listener rather than by the click
    // dispatcher — the member picker listens on mousedown, because the dropdown
    // is closed by the input's blur before a click would land.
    ...[...script.matchAll(/\[data-action="([a-z0-9-]+)"\]/g)].map(m => m[1]),
]);

describe('every action the markup names is dispatched', () => {
    it('for click', () => {
        const unknown = [...used('data-action')].filter(name => !handledClicks.has(name));
        expect(unknown).toEqual([]);
    });

    it('for input', () => {
        const handled = tableKeys('input');
        expect([...used('data-input')].filter(name => !handled.has(name))).toEqual([]);
    });

    it('for change', () => {
        const handled = tableKeys('change');
        expect([...used('data-change')].filter(name => !handled.has(name))).toEqual([]);
    });
});

describe('every action the dispatcher handles is reachable', () => {
    it('has markup for each click case', () => {
        // A case nobody can reach is the other half of a half-finished rename,
        // and it reads as working code.
        const inMarkup = used('data-action');
        expect([...handledClicks].filter(name => !inMarkup.has(name))).toEqual([]);
    });

    it('has markup for each input and change case', () => {
        const inputs = used('data-input');
        const changes = used('data-change');
        expect([...tableKeys('input')].filter(name => !inputs.has(name))).toEqual([]);
        expect([...tableKeys('change')].filter(name => !changes.has(name))).toEqual([]);
    });
});

describe('the sweep is looking at something', () => {
    // Every assertion above is a filter over a derived list, and an empty list
    // passes all of them. This is what tells "nothing was wrong" from "nothing
    // was read".
    it('found actions on both sides', () => {
        expect(used('data-action').size).toBeGreaterThan(50);
        expect(handledClicks.size).toBeGreaterThan(50);
        expect(tableKeys('input').size).toBeGreaterThan(0);
        expect(tableKeys('change').size).toBeGreaterThan(0);
    });
});

describe('the marker attributes are wired too', () => {
    // Not action names: these say "this element behaves like that" and are
    // matched by their own listener. Each was an inline handler before #887, so
    // a marker nothing listens for is the same silent breakage.
    it.each([
        ['data-validate-timezone', 'blur'],
        ['data-hide-on-error', 'error'],
        ['data-emoji-fallback', 'error'],
        ['data-no-submit', 'submit'],
    ])('%s has a listener', attribute => {
        expect(markup).toContain(attribute);
        // The listener matches on the attribute, so its name appears in a
        // selector inside the script.
        expect(script).toContain(`[${attribute}]`);
    });
});
