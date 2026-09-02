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

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'dashboard', 'views');
const PUBLIC = path.join(ROOT, 'src', 'dashboard', 'public');

const script = fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8');

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
    ...fs.readdirSync(PUBLIC, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => fs.readFileSync(path.join(PUBLIC, entry.name), 'utf8')),
].join('\n');

/** The literal values of one data attribute across all of that markup. */
function used(attribute) {
    const names = new Set();
    for (const [, value] of markup.matchAll(new RegExp(`${attribute}="([^"$]+)"`, 'g'))) {
        names.add(value);
    }
    return names;
}

/** The keys of one object literal in guild-settings.js. */
function tableKeys(name) {
    const start = script.indexOf(`const ${name} = {`);
    if (start === -1) throw new Error(`${name} is not in guild-settings.js`);
    const body = script.slice(start, script.indexOf('\n};', start));
    return new Set([...body.matchAll(/^\s+'([a-z0-9-]+)':/gm)].map(m => m[1]));
}

// The click dispatcher is a table plus a chain of `d.action === '…'` for the
// cases that need more than a name.
const handledClicks = new Set([
    ...tableKeys('CLICK_ACTIONS'),
    ...[...script.matchAll(/d\.action === '([a-z0-9-]+)'/g)].map(m => m[1]),
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
        const handled = tableKeys('INPUT_ACTIONS');
        expect([...used('data-input')].filter(name => !handled.has(name))).toEqual([]);
    });

    it('for change', () => {
        const handled = tableKeys('CHANGE_ACTIONS');
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
        expect([...tableKeys('INPUT_ACTIONS')].filter(name => !inputs.has(name))).toEqual([]);
        expect([...tableKeys('CHANGE_ACTIONS')].filter(name => !changes.has(name))).toEqual([]);
    });
});

describe('the sweep is looking at something', () => {
    // Every assertion above is a filter over a derived list, and an empty list
    // passes all of them. This is what tells "nothing was wrong" from "nothing
    // was read".
    it('found actions on both sides', () => {
        expect(used('data-action').size).toBeGreaterThan(50);
        expect(handledClicks.size).toBeGreaterThan(50);
        expect(tableKeys('INPUT_ACTIONS').size).toBeGreaterThan(0);
        expect(tableKeys('CHANGE_ACTIONS').size).toBeGreaterThan(0);
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
