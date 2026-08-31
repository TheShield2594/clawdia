/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #670. Two dozen buttons on the dashboard were a single glyph and nothing
 * else: modal closes rendering `×` or `✕` with neither `title` nor
 * `aria-label`, and chip-removes carrying `title="Remove"` alone — which
 * announces "Remove, button" nine times over on a panel holding nine chips,
 * without ever saying what any of them removes.
 *
 * A glyph is not a name. The two rules below are the fix, checked over every
 * panel rather than the list of the ones that happened to be wrong:
 *
 *   - A button whose visible text is only symbols carries an `aria-label`.
 *   - That label names the thing acted on, not just the verb — so the sweep
 *     also rejects a bare "Remove" or "Close".
 *
 * `dashboardFormLabels.test.js` does the same for inputs, selects and
 * textareas, which the rules there skip buttons for; between them every
 * control a user can reach ends up named.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { guildSettingsLocals, populatedGuildSettingsLocals } = require('./helpers/guildSettingsLocals');
const { renderPanel, bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PANELS = path.join(VIEWS, 'partials', 'panels');
const SCRIPT = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'guild-settings.js');

const panelNames = fs.readdirSync(PANELS).filter(f => f.endsWith('.ejs')).map(f => f.replace(/\.ejs$/, ''));

// A sweep that discovers its own inputs reports the same green for "nothing was
// wrong" as for "nothing was looked at".
if (!panelNames.length) throw new Error('no panels found — the sweep would inspect nothing');

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", times: '×', nbsp: ' ' };

/**
 * `&times;` is five letters in the source and one symbol on the screen, so a
 * check that skips decoding sees a word where the reader sees a glyph — and
 * passes exactly the buttons this suite exists to catch.
 */
function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/** True for text a screen reader gets nothing out of: glyphs, emoji, spacing. */
const iconOnly = text => !/[\p{L}\p{N}]/u.test(decodeEntities(text));

/**
 * "Remove" repeated down a list of chips names none of them. A label that is
 * only a verb is what the issue was about, so it does not count as a name.
 */
const VERB_ONLY = /^(remove|delete|close|edit|dismiss|clear|cancel|add|x)$/i;

function accessibleName(root, el) {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();

    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
        const text = labelledby.split(/\s+/)
            .map(id => root.querySelector(`[id="${id}"]`)?.textContent ?? '')
            .join(' ').trim();
        if (text) return text;
    }

    const text = el.textContent.trim();
    return iconOnly(text) ? '' : text;
}

function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

const render = (file, locals) =>
    ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });

const targets = [
    ...panelNames.map(name => [`panels/${name}.ejs`, path.join(PANELS, `${name}.ejs`)]),
    ['guild-settings.ejs', path.join(VIEWS, 'guild-settings.ejs')],
    ['partials/game-item-card.ejs', path.join(VIEWS, 'partials', 'game-item-card.ejs')],
];

// Both fixtures: a fresh Guild document leaves every array-backed list empty,
// so on that one alone no chip and no repeater row is rendered at all — and the
// chip-removes are half of what the issue was about.
const fixtures = [
    ['empty', guildSettingsLocals],
    ['populated', populatedGuildSettingsLocals],
];

const cardLocals = base => ({
    ...base,
    item: { id: 'hunt:rifle', label: 'Hunting Rifle', emoji: '🔫', hasImage: true },
});

const cases = targets.flatMap(([name, file]) =>
    fixtures.map(([fixture, locals]) => [
        `${name} (${fixture})`,
        file,
        () => (name.endsWith('game-item-card.ejs') ? cardLocals(locals()) : locals()),
    ]));

describe.each(cases)('%s', (name, file, locals) => {
    let root;
    beforeAll(() => { root = parse(render(file, locals())); });

    it('gives every icon-only button an accessible name', () => {
        const nameless = [...root.querySelectorAll('button')]
            .filter(button => iconOnly(button.textContent))
            .filter(button => !accessibleName(root, button))
            .map(button => button.outerHTML.replace(/\s+/g, ' ').slice(0, 90));
        expect(nameless).toEqual([]);
    });

    it('names what each icon-only button acts on, not just the verb', () => {
        const vague = [...root.querySelectorAll('button')]
            .filter(button => iconOnly(button.textContent))
            .map(button => accessibleName(root, button))
            .filter(label => VERB_ONLY.test(label));
        expect(vague).toEqual([]);
    });
});

// The panel sweep above only sees what the server rendered. Chips, repeater
// rows and list entries the user adds after load are built by the script, and
// every one of them was a `×` with a `title="Remove"` at most.
describe('markup the script renders at runtime', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');

    /** Every `<button …>…</button>` written as markup inside the script. */
    function markupButtons() {
        const found = [];
        const open = /<button\b([^>]*)>/g;
        for (let m = open.exec(script); m; m = open.exec(script)) {
            const end = script.indexOf('</button>', open.lastIndex);
            found.push({ attrs: m[1], text: end === -1 ? '' : script.slice(open.lastIndex, end) });
        }
        return found;
    }

    it('finds the buttons it is meant to be checking', () => {
        // Guards against a rewrite that moves this markup somewhere the regex
        // no longer matches, which would otherwise read as a clean sweep.
        expect(markupButtons().length).toBeGreaterThan(5);
        expect(markupButtons().filter(b => iconOnly(b.text)).length).toBeGreaterThan(5);
    });

    // A repeater row's button is named from the row's own fields, which change
    // under the user, so its label is written by labelRepeatedRows rather than
    // baked into the markup. `data-row-remove` is what opts a button into that,
    // and the DOM suite below is what checks the labels actually arrive.
    const namedAtRuntime = attrs => /\bdata-row-remove\s*=/.test(attrs);

    it('labels every icon-only button it writes as markup', () => {
        const nameless = markupButtons()
            .filter(button => iconOnly(button.text))
            .filter(button => !/\baria-label\s*=/.test(button.attrs) && !namedAtRuntime(button.attrs))
            .map(button => `<button${button.attrs}>${button.text}`.replace(/\s+/g, ' ').slice(0, 90));
        expect(nameless).toEqual([]);
    });

    /**
     * The chip removes are built with createElement rather than markup, so the
     * scan above cannot see them: `btn.textContent = '×'` is the whole label.
     */
    it('labels every icon-only button it builds with createElement', () => {
        const lines = script.split('\n');
        const created = /(?:const|let|var)\s+(\w+)\s*=\s*document\.createElement\(['"]button['"]\)/;
        const nameless = [];

        lines.forEach((line, i) => {
            const m = created.exec(line);
            if (!m) return;
            const name = m[1];
            const block = lines.slice(i, i + 15).join('\n');
            const text = new RegExp(`${name}\\.textContent\\s*=\\s*'([^']*)'`).exec(block);
            if (!text || !iconOnly(text[1])) return;
            if (new RegExp(`${name}\\.(setAttribute\\(['"]aria-label|ariaLabel\\s*=)`).test(block)) return;
            // Or it opts into being named from its row's contents at runtime.
            if (new RegExp(`${name}\\.(dataset\\.rowRemove|setAttribute\\(['"]data-row-remove)`).test(block)) return;
            nameless.push(`${name} at line ${i + 1}`);
        });

        expect(nameless).toEqual([]);
    });

    it('finds the createElement buttons it is meant to be checking', () => {
        const created = script.match(/document\.createElement\(['"]button['"]\)/g) || [];
        expect(created.length).toBeGreaterThan(2);
        expect((script.match(/setAttribute\('aria-label'/g) || []).length).toBeGreaterThan(2);
    });
});

// A repeater is where a static label runs out. Every row holds the same button,
// so "Remove this level reward" five times over names none of them — and the
// value that would name one is a field the user edits, so the label has to be
// rewritten as the row changes rather than written once. These drive the real
// page and read the labels back off it.
describe('repeated rows name themselves', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        // The populated fixture, so the server-rendered rows exist: on a fresh
        // Guild every one of these lists is empty.
        bootPage({
            panelFetch: panel => ({
                ok: true, status: 200,
                text: async () => renderPanel(panel, populatedGuildSettingsLocals()),
            }),
        });
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    const labelsIn = id => [...document.querySelectorAll(`#${id} [data-row-remove]`)]
        .map(button => button.getAttribute('aria-label'));

    const openPanel = async name => { clickTab(name); await settle(); };
    const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
    /** The relabel after a removal is scheduled a tick later, as the row goes. */
    const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

    describe('level rewards', () => {
        beforeEach(() => openPanel('leveling'));

        it('names every server-rendered row after its own level', () => {
            expect(labelsIn('level-role-rewards-list'))
                .toEqual(['Remove the level 5 reward', 'Remove the level 10 reward']);
        });

        it('follows the level when it is edited, rather than naming the old one', () => {
            const input = document.querySelector('#level-role-rewards-list .level-reward-level');
            input.value = '12';
            fire(input, 'input');

            expect(labelsIn('level-role-rewards-list')[0]).toBe('Remove the level 12 reward');
        });

        it('falls back to the row position while a new row has no level yet', () => {
            window.addLevelRoleReward();
            expect(labelsIn('level-role-rewards-list')[2])
                .toBe('Remove reward row 3, which has no level set');
        });

        // The fallback names a row by position, so a removal above it makes
        // every label below it wrong until they are rewritten.
        it('renumbers the rows a removal moved', async () => {
            window.addLevelRoleReward();
            window.addLevelRoleReward();
            expect(labelsIn('level-role-rewards-list')[3]).toBe('Remove reward row 4, which has no level set');

            // The third row — the first of the two just added. jsdom does not
            // compile the inline onclick the server-rendered rows carry, so the
            // removal is driven from a row whose handler is a property.
            document.querySelectorAll('#level-role-rewards-list [data-row-remove]')[2].click();
            await nextTick();

            expect(labelsIn('level-role-rewards-list')).toEqual([
                'Remove the level 5 reward',
                'Remove the level 10 reward',
                'Remove reward row 3, which has no level set',
            ]);
        });
    });

    describe('season tiers', () => {
        beforeEach(() => openPanel('season'));

        it('names the server-rendered row after its tier', () => {
            expect(labelsIn('season-tier-rewards-list')).toEqual(['Remove the tier 1 reward']);
        });

        it('names a row added in the browser once it has a tier', () => {
            window.addSeasonTierRow();
            expect(labelsIn('season-tier-rewards-list')[1])
                .toBe('Remove tier row 2, which has no tier set');

            const input = document.querySelectorAll('#season-tier-rewards-list .season-tier-num')[1];
            input.value = '4';
            fire(input, 'input');

            expect(labelsIn('season-tier-rewards-list')[1]).toBe('Remove the tier 4 reward');
        });
    });

    describe('reaction role mappings', () => {
        beforeEach(() => openPanel('reactionroles'));

        it('names a mapping after the emoji and role it maps', () => {
            window.addRrMapping();
            expect(labelsIn('rr-mappings-list')).toEqual(['Remove mapping row 1, which is empty']);

            const emoji = document.querySelector('#rr-mappings-list .rr-emoji');
            emoji.value = '👍';
            fire(emoji, 'input');

            const role = document.querySelector('#rr-mappings-list .rr-role');
            role.value = '40';
            fire(role, 'change');

            expect(labelsIn('rr-mappings-list')).toEqual(['Remove the 👍 → @Member mapping']);
        });

        it('says which half is missing rather than going back to a bare Remove', () => {
            window.addRrMapping();
            const emoji = document.querySelector('#rr-mappings-list .rr-emoji');
            emoji.value = '🎉';
            fire(emoji, 'input');

            expect(labelsIn('rr-mappings-list')).toEqual(['Remove the 🎉 → no role mapping']);
        });
    });
});
