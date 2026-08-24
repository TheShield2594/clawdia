/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #657. Around 40 <label> elements had no `for` and did not wrap their control,
 * so the inputs they sat above had no accessible name at all — a screen reader
 * announced "edit text, blank" for a field captioned "Min pay *".
 *
 * Two rules, one per half of the fix:
 *
 *   - A <label> must name exactly one control. Where the caption is really the
 *     heading of a composite widget (a tag list plus a search box, a repeater),
 *     it is a <div class="field-label"> tied to the group with aria-labelledby,
 *     because a <label> that labels nothing is the bug, not the fix.
 *   - Every control a user can reach must end up with a name from somewhere:
 *     a label, aria-label, or aria-labelledby.
 *
 * The panels are the source of truth here, so the check runs over all of them
 * rather than a list of the ones that happened to be wrong.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { guildSettingsLocals } = require('./helpers/guildSettingsLocals');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PANELS = path.join(VIEWS, 'partials', 'panels');

const panelNames = fs.readdirSync(PANELS).filter(f => f.endsWith('.ejs')).map(f => f.replace(/\.ejs$/, ''));

function render(file) {
    return ejs.render(fs.readFileSync(file, 'utf8'), guildSettingsLocals(), { filename: file });
}

function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

/** Controls that are display:none are storage, not UI, and are not exposed. */
function visibleControls(root) {
    return [...root.querySelectorAll('input, select, textarea')].filter(el => {
        if (el.type === 'hidden') return false;
        return !/display\s*:\s*none/.test(el.getAttribute('style') || '');
    });
}

function accessibleName(root, el) {
    if (el.getAttribute('aria-label')?.trim()) return true;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby && labelledby.split(/\s+/).some(id => root.querySelector(`[id="${id}"]`))) return true;
    if (el.closest('label')) return true;
    return el.id && [...root.querySelectorAll('label[for]')].some(l => l.getAttribute('for') === el.id);
}

const targets = [
    ...panelNames.map(name => [`panels/${name}.ejs`, path.join(PANELS, `${name}.ejs`)]),
    ['guild-settings.ejs', path.join(VIEWS, 'guild-settings.ejs')],
];

describe.each(targets)('%s', (name, file) => {
    let root;
    beforeAll(() => { root = parse(render(file)); });

    it('has no label that names nothing', () => {
        const orphans = [...root.querySelectorAll('label')]
            .filter(l => !l.getAttribute('for'))
            .filter(l => !l.querySelector('input, select, textarea, button'))
            .map(l => l.textContent.trim().replace(/\s+/g, ' ').slice(0, 50));
        expect(orphans).toEqual([]);
    });

    it('points every for= at a control that exists on the page', () => {
        const dangling = [...root.querySelectorAll('label[for]')]
            .map(l => l.getAttribute('for'))
            .filter(id => {
                const target = root.querySelector(`[id="${id}"]`);
                return !target || !/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
            });
        expect(dangling).toEqual([]);
    });

    it('gives every control an accessible name', () => {
        const nameless = visibleControls(root)
            .filter(el => !accessibleName(root, el))
            .map(el => `${el.tagName.toLowerCase()}#${el.id || '(no id)'}`);
        expect(nameless).toEqual([]);
    });

    it('resolves every aria-labelledby it uses', () => {
        const dangling = [...root.querySelectorAll('[aria-labelledby]')]
            .flatMap(el => el.getAttribute('aria-labelledby').split(/\s+/))
            .filter(id => !root.querySelector(`[id="${id}"]`));
        expect(dangling).toEqual([]);
    });

    it('keeps ids unique, so a for= cannot resolve to the wrong control', () => {
        const seen = new Map();
        for (const el of root.querySelectorAll('[id]')) {
            seen.set(el.id, (seen.get(el.id) || 0) + 1);
        }
        expect([...seen].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
    });
});

describe('markup the script renders at runtime', () => {
    // The escalation ladder is built from a template literal rather than a
    // panel, so the panel sweep above cannot see it. Its five captions per row
    // were orphans for the same reason.
    const script = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'dashboard', 'public', 'guild-settings.js'),
        'utf8',
    );

    it('emits no field-label without a for=', () => {
        const orphans = (script.match(/<label class="field-label"[^>]*>/g) || [])
            .filter(tag => !/\bfor=/.test(tag));
        expect(orphans).toEqual([]);
    });

    it('gives each escalation row its own ids, so a two-step ladder has no duplicates', () => {
        const rowIds = [...script.matchAll(/id="(esc-\$\{idx\}-[a-z]+)"/g)].map(m => m[1]);
        expect(rowIds.length).toBeGreaterThan(0);
        expect(new Set(rowIds).size).toBe(rowIds.length);

        // Every one of those ids must be the target of a label in the same row.
        const labelled = [...script.matchAll(/for="(esc-\$\{idx\}-[a-z]+)"/g)].map(m => m[1]);
        expect(rowIds.filter(id => !labelled.includes(id))).toEqual([]);
    });
});
