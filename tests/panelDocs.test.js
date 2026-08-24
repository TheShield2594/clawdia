'use strict';

// FEATURES.md enumerated 20 dashboard sections when 25 panels existed, with
// Exploration and Newspaper missing outright (#705). The list is generated now,
// and this is what keeps it generated: adding, renaming or removing a panel
// turns `npm test` red until `npm run docs:panels` has been run.
//
// The cross-checks below are the more valuable half. A panel has to appear in
// three places to work at all — a template on disk, the PANELS array the panel
// endpoint validates against, and a sidebar tab to reach it by — and a panel
// present in two of the three is broken in a way nothing else here notices.

const fs = require('fs');
const path = require('path');

const {
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
} = require('../scripts/docs-panels');

describe('FEATURES dashboard section list', () => {
    test('is in step with the panels and the sidebar', () => {
        const { current, next } = buildDoc();

        // Not `toBe`: the diff on a 25-row table is unreadable and the fix is
        // one command either way.
        expect(current === next).toBe(true);
    });

    test('keeps the markers the generator writes between', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');

        expect(doc).toContain(BEGIN);
        expect(doc).toContain(END);
        expect(doc.indexOf(BEGIN)).toBeLessThan(doc.indexOf(END));
    });

    // The prose around the block is hand-written and has to survive a
    // regeneration — the generator replaces the block, not the file.
    test('regenerating leaves the surrounding prose alone', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');
        const rewritten = replaceBlock(doc, 'placeholder');

        expect(rewritten).toContain('### Multi-Server Support');
        expect(rewritten).toContain('## 🔐 Permissions');
        expect(rewritten).toContain(`${BEGIN}\n\nplaceholder\n\n${END}`);
    });

    test('refuses to write when the markers are gone', () => {
        expect(() => replaceBlock('# Clawdia\n\nNo markers here.\n', 'body'))
            .toThrow(/missing the/);
    });
});

describe('the sections it finds', () => {
    const sections = parseAll();

    test('are every panel template on disk, and nothing else', () => {
        expect(sections.map(s => s.panel).sort()).toEqual(panelsOnDisk().sort());
    });

    test('are every panel PANELS declares', () => {
        expect(sections.map(s => s.panel).sort()).toEqual([...declaredPanels()].sort());
    });

    // The count in the issue. 20 documented against 25 existing is the state
    // this whole file exists to make unreachable.
    test('cover all 25 of them', () => {
        expect(sections).toHaveLength(25);
    });

    test('each carry a label, an emoji and a group', () => {
        for (const section of sections) {
            expect([section.panel, section.label.length > 0]).toEqual([section.panel, true]);
            expect([section.panel, section.emoji.length > 0]).toEqual([section.panel, true]);
            expect([section.panel, section.group.length > 0]).toEqual([section.panel, true]);
        }
    });

    test('each carry a description short enough to read in a table', () => {
        for (const section of sections) {
            expect([section.panel, section.summary.length > 0 && section.summary.length <= 200])
                .toEqual([section.panel, true]);
        }
    });

    // Sidebar order is what a reader sees on screen; a docs list in a different
    // order is one they have to translate.
    test('are in sidebar order', () => {
        expect(sections.map(s => s.panel)).toEqual(parseSidebar().map(s => s.panel));
    });

    test('keep each group contiguous, so the table has one heading per group', () => {
        const groups = sections.map(s => s.group);
        const firstSeen = [...new Set(groups)];

        expect(groups).toEqual(firstSeen.flatMap(g => groups.filter(x => x === g)));
    });
});

describe('the generator itself', () => {
    /** Runs `body` with an extra panel template on disk, and removes it after. */
    function withProbe(source, body) {
        const file = path.join(PANEL_DIR, '__panel_probe.ejs');
        fs.writeFileSync(file, source);
        try {
            body();
        } finally {
            fs.unlinkSync(file);
        }
    }

    test('reads the panel-head paragraph, to the end of its first sentence', () => {
        withProbe('<div class="panel-head"><h2>Probe</h2><p>Does a thing. And another thing.</p></div>', () => {
            expect(summaryOf('__panel_probe')).toBe('Does a thing');
        });
    });

    test('renders an inline <code> as markdown backticks', () => {
        withProbe('<div class="panel-head"><p>Run <code>/probe</code> to start.</p></div>', () => {
            expect(summaryOf('__panel_probe')).toBe('Run `/probe` to start');
        });
    });

    test('decodes the entities the panel copy uses', () => {
        withProbe('<div class="panel-head"><p>Link &amp; invite filtering.</p></div>', () => {
            expect(summaryOf('__panel_probe')).toBe('Link & invite filtering');
        });
    });

    // Overview uses this: it opens on a greeting, not a description.
    test('prefers a declared summary over the panel-head paragraph', () => {
        withProbe('<%# summary: The declared one. %><div class="panel-head"><p>The paragraph one.</p></div>', () => {
            expect(summaryOf('__panel_probe')).toBe('The declared one');
        });
    });

    test('finds nothing in a panel with neither, which is what fails the build', () => {
        withProbe('<section id="probe" class="panel"><h2>Probe</h2></section>', () => {
            expect(summaryOf('__panel_probe')).toBe('');
        });
    });

    test('escapes a pipe in a description rather than splitting the table cell', () => {
        const body = renderPanels([{
            panel: 'probe', label: 'Probe', emoji: '🧪', group: 'Tools', summary: 'Either a | or a comma',
        }]);

        expect(body).toContain('| 🧪 **Probe** | Either a \\| or a comma |');
    });

    test('groups consecutive sections under one heading', () => {
        const body = renderPanels([
            { panel: 'a', label: 'A', emoji: '1️⃣', group: 'Tools', summary: 'First' },
            { panel: 'b', label: 'B', emoji: '2️⃣', group: 'Tools', summary: 'Second' },
            { panel: 'c', label: 'C', emoji: '3️⃣', group: 'Insights', summary: 'Third' },
        ]);

        expect(body.match(/^### Tools$/gm)).toHaveLength(1);
        expect(body.match(/^### Insights$/gm)).toHaveLength(1);
    });

    // A panel added to the directory and to PANELS but never linked from the
    // sidebar is unreachable in the UI. Silently leaving it out of the table
    // would document the bug as if it were the design.
    test('refuses a panel the sidebar has no tab for', () => {
        withProbe('<div class="panel-head"><p>Probe.</p></div>', () => {
            expect(() => parseAll()).toThrow(/no tab for them: __panel_probe/);
        });
    });

    test('refuses a panel PANELS does not declare', () => {
        const panels = require('../src/dashboard/lib/panels');
        const original = [...panels.PANELS];

        // Same shape as the sidebar-only case from the other side: a tab that
        // the panel endpoint will 404 because PANELS never validated it.
        panels.PANELS.pop();
        try {
            expect(() => parseAll()).toThrow(/PANELS is missing/);
        } finally {
            panels.PANELS.length = 0;
            panels.PANELS.push(...original);
        }
    });
});
