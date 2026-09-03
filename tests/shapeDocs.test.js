'use strict';

// README's "Shape of the codebase" table was hand-written and had drifted
// (#916): 43 economy commands against 42 on disk, 22,572 economy lines against
// 25,319, 332 AI lines against 935, and a `/fish` described as a 3,190-line
// file months after #721 split it into a folder. It was the one doc block in
// this repo without a drift test, on the page everyone reads first.
//
// It is generated now, and this is what keeps it generated — adding a command
// or a few hundred lines turns `npm test` red until `npm run docs:shape` has
// been run, the same way tests/commandDocs.test.js guards docs/COMMANDS.md.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    measureAreas,
    areasOutweighedBy,
    headlineSentence,
    renderShape,
    replaceBlock,
    buildDoc,
    lineCount,
    BEGIN,
    END,
    DOC_PATH,
} = require('../scripts/docs-shape');

/** A throwaway command tree, so the shape tests need no fixture in src/. */
function withTree(layout, run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-shape-'));
    try {
        for (const [rel, body] of Object.entries(layout)) {
            const full = path.join(root, rel);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, body);
        }
        return run(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('generated shape table', () => {
    test('is in step with the command tree', () => {
        const { current, next } = buildDoc();

        // Not `toBe`: the diff on the whole README is unreadable, and the fix
        // is one command either way.
        expect(current === next).toBe(true);
    });

    test('keeps the markers the generator writes between', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');

        expect(doc).toContain(BEGIN);
        expect(doc).toContain(END);
        expect(doc.indexOf(BEGIN)).toBeLessThan(doc.indexOf(END));
    });

    test('regenerating leaves the surrounding prose alone', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');
        const rewritten = replaceBlock(doc, 'placeholder');

        expect(rewritten).toContain('## Shape of the codebase');
        expect(rewritten).toContain('## Features');
        expect(rewritten).toContain(`${BEGIN}\n\nplaceholder\n\n${END}`);
    });

    test('refuses to write when the markers are gone', () => {
        expect(() => replaceBlock('# Clawdia\n\nNo markers here.\n', 'body'))
            .toThrow(/missing the/);
    });
});

// The whole point of the block is that the numbers in it are measured rather
// than remembered, so the measuring is what is worth testing.
describe('measuring the command tree', () => {
    test('counts a folder command once and its siblings as lines', () => {
        // The old figure treated `/fish` as one file, which is how "3,190
        // lines" survived a split into nine modules.
        const areas = withTree({
            'economy/fish/index.js': 'a\nb\nc\n',
            'economy/fish/cast.js': 'd\ne\n',
            'economy/fish/shop/buy.js': 'f\n',
            'economy/balance.js': 'g\n',
        }, measureAreas);

        expect(areas).toEqual([
            { id: 'economy', label: 'Economy / RPG', commands: 2, lines: 7 },
        ]);
    });

    test('ignores a folder with no index.js, but still counts its lines', () => {
        // `<category>/<name>/index.js` is the loader's definition of a folder
        // command; anything else in there is an implementation detail.
        const [area] = withTree({
            'utility/helpers/format.js': 'a\nb\n',
            'utility/ping.js': 'c\n',
        }, measureAreas);

        expect([area.commands, area.lines]).toEqual([1, 3]);
    });

    test('counts only JavaScript', () => {
        const [area] = withTree({
            'utility/ping.js': 'a\n',
            'utility/notes.md': 'b\nc\nd\n',
        }, measureAreas);

        expect(area.lines).toBe(1);
    });

    test('names an unrecognised folder rather than dropping it', () => {
        // A new category with no entry in the label map is still the reader's
        // business; silently leaving it out is the drift in a new form.
        const areas = withTree({ 'weather/forecast.js': 'a\n' }, measureAreas);

        expect(areas).toEqual([{ id: 'weather', label: 'Weather', commands: 1, lines: 1 }]);
    });

    test('orders the table by size', () => {
        const areas = withTree({
            'admin/one.js': 'a\n',
            'economy/two.js': 'a\nb\nc\n',
            'fun/three.js': 'a\nb\n',
        }, measureAreas);

        expect(areas.map(a => a.id)).toEqual(['economy', 'fun', 'admin']);
    });

    test('refuses an empty tree rather than rendering an empty table', () => {
        expect(() => withTree({}, measureAreas)).toThrow(/no command categories/);
    });

    test('counts lines the way wc does', () => {
        const counted = withTree({ 'a.js': 'one\ntwo\n', 'b.js': 'one\ntwo' }, root => [
            lineCount(path.join(root, 'a.js')),
            lineCount(path.join(root, 'b.js')),
        ]);

        // A trailing newline ends the last line, it does not start another.
        expect(counted).toEqual([2, 1]);
    });
});

// "more than the moderation, leveling, AI, and admin command sets put together"
// was as hand-written as the numbers above it, and goes stale the same way.
describe('the sentence under the table', () => {
    const areas = [
        { id: 'economy', label: 'Economy / RPG', lines: 9000 },
        { id: 'fun', label: 'Fun', lines: 400 },
        { id: 'ai', label: 'AI', lines: 300 },
        { id: 'admin', label: 'Admin', lines: 200 },
    ];

    test('names the areas the command actually outweighs, largest first', () => {
        const { areas: named, total } = areasOutweighedBy(areas, 1000, 'economy');

        // 200 + 300 + 400 = 900 < 1000; a fourth would need the economy row,
        // which is the category the command is in.
        expect(named.map(a => a.label)).toEqual(['Fun', 'AI', 'Admin']);
        expect(total).toBe(900);
    });

    test('stops before the sum passes the command', () => {
        const { areas: named, total } = areasOutweighedBy(areas, 600, 'economy');

        expect(named.map(a => a.label)).toEqual(['AI', 'Admin']);
        expect(total).toBe(500);
    });

    test('drops the comparison when there is nothing much to compare against', () => {
        // Rather than "more than the  command sets put together".
        const sentence = headlineSentence(areas, 150, 9);

        expect(sentence).toBe('`/fish` alone is 150 lines, across 9 modules.');
        expect(sentence).not.toContain('put together');
    });

    test('reads as a sentence when it does compare', () => {
        expect(headlineSentence(areas, 1000, 9))
            .toBe('`/fish` alone is 1,000 lines — more than the Fun, AI and Admin command sets put together (900).');
    });
});

describe('the rendered block', () => {
    const areas = [
        { id: 'economy', label: 'Economy / RPG', commands: 38, lines: 26546 },
        { id: 'admin', label: 'Admin', commands: 1, lines: 275 },
    ];

    test('totals the columns and groups the digits', () => {
        const body = renderShape(areas, 3444, 9);

        expect(body).toContain('| Economy / RPG | 38 | 26,546 |');
        expect(body).toContain('| **Total** | **39** | **26,821** |');
    });

    test('says where the numbers came from', () => {
        // The reader who wants to change one needs to be told not to edit here.
        expect(renderShape(areas, 3444, 9)).toContain('npm run docs:shape');
    });
});

// The two blocks count the same commands out of the same tree, so they must
// agree — a README saying 38 beside a COMMANDS.md listing 42 is the bug back in
// a new place.
describe('against the generated command reference', () => {
    test('reports the same per-category command counts', () => {
        const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'COMMANDS.md'), 'utf8');

        const listed = new Map();
        let heading = null;
        for (const line of doc.split('\n')) {
            const section = /^### \S+\s+(.+)$/.exec(line);
            if (section) {
                heading = section[1].trim();
                listed.set(heading, 0);
                continue;
            }
            // `@Clawdia` is a catalog entry with no command file behind it, so
            // it is the one line docs-shape cannot and should not see.
            if (heading && /^- `\//.test(line)) listed.set(heading, listed.get(heading) + 1);
        }
        expect(listed.size).toBeGreaterThan(0);

        for (const area of measureAreas()) {
            // Economy / RPG is the table's label for the Economy section.
            const section = area.label.split(' / ')[0];
            expect([section, listed.get(section)]).toEqual([section, area.commands]);
        }
    });
});
