/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #671. The same five-line option loop was copy-pasted into 39 selects across
 * 20 panels — 28 channel pickers and 11 role pickers — so every fix to how an
 * option renders had to be found and made 39 times.
 *
 * They go through partials/channel-select.ejs and partials/role-select.ejs
 * now. Two things are worth holding: that no panel has quietly gone back to
 * writing the loop by hand, and that the partials themselves get the details
 * right — the escaping, which option is selected, and the attributes that
 * carry a picker's meaning to the rest of the page.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { guildSettingsLocals, populatedGuildSettingsLocals } = require('./helpers/guildSettingsLocals');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PANELS = path.join(VIEWS, 'partials', 'panels');

const panelFiles = fs.readdirSync(PANELS).filter(f => f.endsWith('.ejs'));
if (!panelFiles.length) throw new Error('no panels found — the sweep would inspect nothing');

function renderPartial(name, locals) {
    const file = path.join(VIEWS, 'partials', `${name}.ejs`);
    return ejs.render(fs.readFileSync(file, 'utf8'), { ...guildSettingsLocals(), ...locals }, { filename: file });
}

/** The rendered partial as a live <select>, so attributes and options are read
 *  the way a browser would rather than by matching the source text. */
function select(name, locals) {
    const host = document.createElement('div');
    host.innerHTML = renderPartial(name, locals);
    return host.querySelector('select');
}

function renderPanel(file, locals) {
    const full = path.join(PANELS, file);
    return ejs.render(fs.readFileSync(full, 'utf8'), locals, { filename: full });
}

describe('no panel writes the option loop by hand', () => {
    it('has no channels.forEach or roles.forEach left in a panel', () => {
        const offenders = panelFiles.filter(f => {
            const src = fs.readFileSync(path.join(PANELS, f), 'utf8');
            return /\b(channels|roles)\.forEach/.test(src);
        });
        expect(offenders).toEqual([]);
    });

    it('routes the pickers the panels do have through the partials', () => {
        // The 39 the issue counted, plus the three modal and repeater selects
        // found alongside them. A floor rather than an exact count: a new panel
        // adding a picker is fine, and the check above is what catches one
        // added by hand.
        let includes = 0;
        for (const file of panelFiles) {
            const src = fs.readFileSync(path.join(PANELS, file), 'utf8');
            includes += [...src.matchAll(/include\('\.\.\/(channel|role)-select'/g)].length;
        }
        expect(includes).toBeGreaterThanOrEqual(42);
    });

    it('still renders every panel, with the selects the pages had', () => {
        for (const file of panelFiles) {
            const html = renderPanel(file, populatedGuildSettingsLocals());
            const host = document.createElement('div');
            host.innerHTML = html;
            for (const el of host.querySelectorAll('select')) {
                // An empty picker means the include lost its collection, which
                // renders as a select the reader simply cannot use.
                if (/-channel|-role|channels|roles/.test(el.id || el.className)) {
                    expect([file, el.id || el.className, el.options.length > 0]).toEqual([file, el.id || el.className, true]);
                }
            }
        }
    });
});

describe('channel-select', () => {
    it('lists every channel, prefixed the way Discord writes them', () => {
        const el = select('channel-select', { id: 'x', placeholder: 'Select a channel' });
        expect([...el.options].map(o => o.textContent)).toEqual(['Select a channel', '#general', '#off-topic']);
        expect([...el.options].map(o => o.value)).toEqual(['', '10', '11']);
    });

    it('omits the empty option when no placeholder is given', () => {
        const el = select('channel-select', { id: 'x' });
        expect([...el.options].map(o => o.value)).toEqual(['10', '11']);
    });

    it('marks the chosen channel', () => {
        const el = select('channel-select', { id: 'x', placeholder: 'Pick', selected: '11' });
        expect([...el.options].filter(o => o.selected).map(o => o.value)).toEqual(['11']);
    });

    it('marks every chosen channel of a multi-select', () => {
        const el = select('channel-select', { id: 'x', multiple: true, size: 4, selected: ['10', '11'] });
        expect(el.multiple).toBe(true);
        expect(el.size).toBe(4);
        expect([...el.selectedOptions].map(o => o.value)).toEqual(['10', '11']);
    });

    it('selects nothing when the setting is unset', () => {
        for (const selected of [undefined, null, '', []]) {
            const el = select('channel-select', { id: 'x', placeholder: 'Pick', selected });
            expect([...el.options].filter(o => o.selected && o.value)).toEqual([]);
        }
    });

    it('carries the attributes that tell the page what kind of picker it is', () => {
        const el = select('channel-select', {
            id: 'x', ariaLabel: 'Channel to exclude from XP', noDirty: true, placeholder: 'Pick',
        });
        expect(el.getAttribute('aria-label')).toBe('Channel to exclude from XP');
        // Read by the unsaved-changes tracking (#662): an "add one" picker is
        // not a setting, and counting it would pin the panel dirty.
        expect(el.hasAttribute('data-no-dirty')).toBe(true);
    });

    it('takes a class instead of an id, for the repeater rows', () => {
        const el = select('channel-select', { cls: 'level-reward-channel' });
        expect(el.className).toBe('level-reward-channel');
        expect(el.hasAttribute('id')).toBe(false);
    });
});

describe('role-select', () => {
    it('lists every role, prefixed the way Discord writes them', () => {
        const el = select('role-select', { id: 'x', placeholder: 'Select a role' });
        expect([...el.options].map(o => o.textContent)).toEqual(['Select a role', '@Member', "@Bob's crew"]);
    });

    it('escapes a role name rather than pasting it into the markup', () => {
        // A guild can name a role anything, and it reaches this page as guild
        // input. The apostrophe in the fixture already proves the escaping
        // path; this proves it holds for markup.
        const el = select('role-select', {
            id: 'x',
            roles: [{ id: '1', name: '<img src=x onerror=alert(1)>' }],
        });
        expect(el.querySelectorAll('img')).toHaveLength(0);
        expect(el.options[0].textContent).toBe('@<img src=x onerror=alert(1)>');
    });

    it('marks the chosen role', () => {
        const el = select('role-select', { id: 'x', placeholder: 'Pick', selected: '41' });
        expect([...el.options].filter(o => o.selected).map(o => o.value)).toEqual(['41']);
    });

    it('compares ids as text, so a numeric snowflake still matches', () => {
        // Discord snowflakes arrive as strings, but a setting round-tripped
        // through somewhere careless can come back as a number.
        const el = select('role-select', { id: 'x', placeholder: 'Pick', selected: 40 });
        expect([...el.options].filter(o => o.selected).map(o => o.value)).toEqual(['40']);
    });
});
