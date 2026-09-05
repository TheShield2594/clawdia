'use strict';

/**
 * #935. The guild settings page was one 5,206-line guild-settings.js covering
 * every panel's load, save, validation and dialog behaviour, with nothing
 * enforcing a boundary between any two of them. It is a dozen scripts now — the
 * shared machinery, the chart helpers, one per panel, then the shell — and a
 * split is only worth having while the boundaries hold. Two properties do that,
 * and neither is visible in a diff.
 *
 * **A name that crosses a file has to be a `var` or a function declaration.**
 * These are classic scripts sharing one global scope, and the two spellings do
 * not behave the same across it: a top-level `var` and a function declaration
 * become properties of the window, while a `const` or a `let` is a binding in
 * the shared *global lexical* scope. A browser resolves that across scripts;
 * the suites boot the page by evaluating each file on its own, which does not.
 * So a panel reading a sibling's `const` works in one and throws in the other —
 * the worst shape a defect can have. Panel-local state stays `const`/`let`;
 * anything another file reads is a `var` or a function.
 *
 * **The shared surface is the one written down.** eslint.config.js lists what
 * may cross, per file, and `no-undef` holds each file to it — so this suite
 * checks the other direction: that every name on that list is really declared
 * by the file the list says declares it, and that nothing on it has since been
 * deleted. A stale entry is permission to reach for something that is not
 * there.
 */

const espree = require('espree');
const { PAGE_SCRIPTS, readScript } = require('./helpers/dashboardScripts');

/** Every top-level binding in one script, by the kind it was declared with. */
function topLevelBindings(source) {
    const bindings = new Map();
    for (const node of espree.parse(source, { ecmaVersion: 2024, sourceType: 'script' }).body) {
        if (node.type === 'FunctionDeclaration') bindings.set(node.id.name, 'function');
        if (node.type === 'ClassDeclaration') bindings.set(node.id.name, 'class');
        if (node.type === 'VariableDeclaration') {
            for (const declarator of node.declarations) {
                if (declarator.id.type === 'Identifier') bindings.set(declarator.id.name, node.kind);
            }
        }
    }
    return bindings;
}

// The page's scripts minus the two that were always separate files: esc-html.js
// and settings-payload.js each export exactly one function and were never part
// of the split.
const SPLIT_SCRIPTS = PAGE_SCRIPTS.filter(file => !['esc-html.js', 'settings-payload.js'].includes(file));

const bindingsByFile = new Map(SPLIT_SCRIPTS.map(file => [file, topLevelBindings(readScript(file))]));

/** Which file declares `name`, or undefined. */
function declaringFile(name) {
    for (const [file, bindings] of bindingsByFile) if (bindings.has(name)) return file;
    return undefined;
}

// The shared surface, read out of the lint config rather than restated here:
// two lists that could disagree would leave the weaker one deciding.
const eslintConfig = require('../eslint.config.js');
const sharedNames = new Set(
    eslintConfig
        // The per-file blocks that name the page's own scripts, not the broad
        // `public/**` one — that grants the browser's own globals, which are
        // nobody's to declare.
        .filter(block => (block.files || []).some(pattern =>
            pattern.startsWith('src/dashboard/public/') && !pattern.includes('**')))
        .flatMap(block => Object.keys(block.languageOptions?.globals || []))
        // Declared outside the split: the other two scripts, and the vendored
        // Chart.js that loadChartJs() injects.
        .filter(name => !['escHtml', 'buildSettingsPayload', 'Chart'].includes(name)),
);

describe('the page is really more than one file', () => {
    test('there are a dozen of them, and none is the old monolith', () => {
        expect(SPLIT_SCRIPTS.length).toBeGreaterThan(8);
        // A ceiling rather than an average: the point of the split is that no
        // one of these is the file #935 was about, and an average would let one
        // grow back while the others stayed small.
        const lengths = SPLIT_SCRIPTS.map(file => [file, readScript(file).split('\n').length]);
        expect(lengths.filter(([, lines]) => lines > 1200)).toEqual([]);
    });

    test('every script is a classic script, not a module', () => {
        for (const file of SPLIT_SCRIPTS) {
            expect(() => espree.parse(readScript(file), { ecmaVersion: 2024, sourceType: 'script' })).not.toThrow();
        }
    });
});

describe('the shared surface is declared where the lint config says', () => {
    // Vacuously green if the config is read wrong, which is the one way this
    // whole file could stop meaning anything.
    test('the surface is a real list', () => {
        expect(sharedNames.size).toBeGreaterThan(20);
    });

    test.each([...sharedNames].sort())('%s is declared by one of the page scripts', name => {
        expect([name, declaringFile(name)]).toEqual([name, expect.any(String)]);
    });

    test.each([...sharedNames].sort())('%s is a var or a function, so it crosses files', name => {
        const file = declaringFile(name);
        // `const` and `let` are the ones a browser shares across scripts and a
        // per-file eval does not. See the note at the top.
        expect([name, file, bindingsByFile.get(file)?.get(name)]).toEqual([
            name, file, expect.stringMatching(/^(var|function)$/),
        ]);
    });
});

describe('no two scripts declare the same name', () => {
    // One global scope: a second `var` of the same name silently wins, and a
    // second `const` throws on load. Either way the page is broken by two files
    // that each look right on their own.
    test('every top-level binding belongs to exactly one file', () => {
        const seen = new Map();
        const clashes = [];
        for (const [file, bindings] of bindingsByFile) {
            for (const name of bindings.keys()) {
                if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} and ${file}`);
                else seen.set(name, file);
            }
        }
        expect(clashes).toEqual([]);
    });
});
