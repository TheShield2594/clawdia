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
const { guildSettingsLocals, populatedGuildSettingsLocals } = require('./helpers/guildSettingsLocals');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PANELS = path.join(VIEWS, 'partials', 'panels');

const panelNames = fs.readdirSync(PANELS).filter(f => f.endsWith('.ejs')).map(f => f.replace(/\.ejs$/, ''));

// A sweep that derives what it inspects at runtime reports the same green for
// "nothing was wrong" as for "nothing was looked at". A renamed directory
// would otherwise delete this whole suite silently.
if (!panelNames.length) throw new Error('no panels found — the sweep would inspect nothing');

function render(file, locals) {
    return ejs.render(fs.readFileSync(file, 'utf8'), locals || guildSettingsLocals(), { filename: file });
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

// Both fixtures, because a fresh Guild document leaves every array-backed list
// empty: on that fixture alone each panel's `forEach` renders nothing and the
// rules below never see a repeater row. Two of them held unnamed controls.
const fixtures = [
    ['empty', guildSettingsLocals],
    ['populated', populatedGuildSettingsLocals],
];
const cases = targets.flatMap(([name, file]) =>
    fixtures.map(([fixture, locals]) => [`${name} (${fixture})`, file, locals]));

describe.each(cases)('%s', (name, file, locals) => {
    let root;
    beforeAll(() => { root = parse(render(file, locals())); });

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
    const script = require('./helpers/dashboardScripts').pageScriptSource();

    it('emits no field-label without a for=', () => {
        const tags = script.match(/<label class="field-label"[^>]*>/g) || [];
        // Without this the filter below reports clean when the script stops
        // emitting field labels at all, and the rule quietly stops applying.
        expect(tags.length).toBeGreaterThan(0);
        expect(tags.filter(tag => !/\bfor=/.test(tag))).toEqual([]);
    });

    // The repeater rows the script appends have no <label> to pair with — they
    // are bare cells in a grid — so each control carries its own aria-label.
    // The panel sweep cannot see them: they exist only once a button is clicked.
    it('names every control in the rows it appends', () => {
        const builders = ['addLevelRoleReward', 'addSeasonTierRow', 'addRrMapping'];
        for (const builder of builders) {
            const start = script.indexOf(`function ${builder}(`);
            expect([builder, start]).not.toEqual([builder, -1]);
            const body = script.slice(start, script.indexOf('\n}', start));

            // Controls written as markup in a template string.
            const markup = body.match(/<(?:input|select|textarea)\b[^>]*>/g) || [];
            const unnamed = markup.filter(tag => !/aria-label=/.test(tag));
            expect([builder, unnamed]).toEqual([builder, []]);

            // Controls built through the DOM API instead.
            const created = (body.match(/createElement\('(input|select|textarea)'\)/g) || []).length;
            const labelled = (body.match(/setAttribute\('aria-label'/g) || []).length;
            expect([builder, labelled >= created]).toEqual([builder, true]);
        }
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
