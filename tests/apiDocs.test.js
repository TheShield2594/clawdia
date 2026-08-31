'use strict';

// docs/API_REFERENCE.md documented none of the 46 endpoints under
// src/dashboard/routes/api/ — it was a cookbook of generic Express snippets
// whose only endpoint example was a `/api/custom/:guildId` that has never
// existed (#711). The tables are generated now, and this is what keeps them
// generated: adding, moving or renaming a route turns `npm test` red until
// `npm run docs:api` has been run.

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    parseAll,
    parseRouter,
    renderEndpoints,
    replaceBlock,
    buildDoc,
    summaryAbove,
    requirements,
    BEGIN,
    END,
    DOC_PATH,
    API_DIR,
    API_INDEX,
} = require('../scripts/docs-api');

describe('API_REFERENCE endpoint tables', () => {
    test('are in step with the routers that serve them', () => {
        const { current, next } = buildDoc();

        // Not `toBe`: the diff on a 46-row table is unreadable and the fix is
        // one command either way.
        expect(current === next).toBe(true);
    });

    test('keep the markers the generator writes between', () => {
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

        expect(rewritten).toContain('## Authorization');
        expect(rewritten).toContain('## Rate limits');
        expect(rewritten).toContain(`${BEGIN}\n\nplaceholder\n\n${END}`);
    });

    test('refuse to write when the markers are gone', () => {
        expect(() => replaceBlock('# Clawdia\n\nNo markers here.\n', 'body'))
            .toThrow(/missing the/);
    });
});

describe('the endpoints it finds', () => {
    const routers = parseAll();
    const routes = routers.flatMap(r => r.routes);

    test('cover every router routes/api.js mounts', () => {
        const onDisk = fs.readdirSync(API_DIR).filter(f => f.endsWith('.js')).sort();

        expect(routers.map(r => `${r.file}.js`).sort()).toEqual(onDisk);
    });

    test('are all under the /api/v1 mount', () => {
        for (const route of routes) {
            expect([route.path, route.path.startsWith('/api/v1/')]).toEqual([route.path, true]);
        }
    });

    // #561 was a cross-tenant write that `checkAuth` alone let through: being
    // logged in says nothing about administering *this* guild. Any new
    // :guildId route that forgets checkGuildAccess fails here, not in
    // production.
    test('gate every :guildId route on administering that guild', () => {
        // No exemptions. The two item-image reads used to be listed here as
        // deliberately public, on the reasoning that an <img> tag cannot
        // present a session — which was not true of them: every request comes
        // from a dashboard page on the dashboard's own origin and carries the
        // cookie (#565).
        for (const route of routes.filter(r => r.path.includes(':guildId'))) {
            const label = `${route.method} ${route.path}`;
            expect([label, route.requires.includes('guild admin')]).toEqual([label, true]);
        }
    });

    test('rate-limit every write', () => {
        for (const route of routes.filter(r => r.method !== 'GET' && r.method !== 'HEAD')) {
            const label = `${route.method} ${route.path}`;
            expect([label, route.requires.includes('write limit')]).toEqual([label, true]);
        }
    });

    test('each carry a summary short enough to read in a table', () => {
        for (const route of routes) {
            const label = `${route.method} ${route.path}`;
            expect([label, route.summary.length > 0 && route.summary.length <= 200]).toEqual([label, true]);
        }
    });
});

describe('the generator itself', () => {
    /**
     * Runs `body` against a copy of routes/ that holds every real router plus
     * one extra, and hands it the `{ apiDir, apiIndex }` the generator reads.
     *
     * `mount: true` also appends the probe to the copied api.js, for the cases
     * that need it mounted rather than orphaned.
     *
     * The probe used to be written straight into src/dashboard/routes/api/,
     * and the mount line appended to the real src/dashboard/routes/api.js and
     * then undone. Jest runs suites in parallel workers and other suites sweep
     * that directory: apiEnvelope generates one test per file in it and reads
     * each in its own test body, and dashboardAuthEnforcement `require()`s
     * every file it finds — so the probe was a file they could list and then
     * fail to read, or load and blow up on, and the real api.js could be read
     * mid-edit. That race is what took out dashboardInlineAttributes on the
     * views side.
     *
     * The real routers are symlinked rather than copied, so the mirror is
     * content-identical and cannot drift from what ships; the probe and the
     * index are the only real files. Nothing is written inside src/ at any
     * point, which is what makes the race impossible rather than unlikely.
     */
    function withProbe(source, body, { mount = false } = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-routes-'));
        const apiDir = path.join(root, 'api');
        const apiIndex = path.join(root, 'api.js');
        try {
            fs.mkdirSync(apiDir);
            for (const name of fs.readdirSync(API_DIR)) {
                fs.symlinkSync(path.join(API_DIR, name), path.join(apiDir, name));
            }
            fs.writeFileSync(path.join(apiDir, '__parser_probe.js'), source);

            const index = fs.readFileSync(API_INDEX, 'utf8');
            fs.writeFileSync(apiIndex, mount
                ? `${index}\nrouter.use(require('./api/__parser_probe'));\n`
                : index);

            body({ apiDir, apiIndex });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    // The guard on the paragraph above, asserted *inside* the body while the
    // probe exists: checking afterwards would pass for the old version too,
    // which also cleaned up — it is the window in the middle that other workers
    // could see.
    test('never puts the probe anywhere the other suites can see it', () => {
        const before = fs.readdirSync(API_DIR).sort();
        const index = fs.readFileSync(API_INDEX, 'utf8');

        withProbe("// Probe.\nrouter.get('/probe', handler);\n", sources => {
            expect(fs.readdirSync(API_DIR).sort()).toEqual(before);
            expect(fs.existsSync(path.join(API_DIR, '__parser_probe.js'))).toBe(false);
            expect(fs.readFileSync(API_INDEX, 'utf8')).toBe(index);
            // …and the mirror really is the whole router set plus the one
            // extra, or the tests below would be reading a directory of one.
            expect(fs.readdirSync(sources.apiDir).sort())
                .toEqual([...before, '__parser_probe.js'].sort());
            expect(sources.apiDir.startsWith(os.tmpdir())).toBe(true);
        }, { mount: true });

        expect(fs.readdirSync(API_DIR).sort()).toEqual(before);
        expect(fs.readFileSync(API_INDEX, 'utf8')).toBe(index);
    });

    test('reads the comment block above a route, to the end of its first sentence', () => {
        const lines = [
            '// Grants an achievement to a member. The rewards are applied by',
            '// achievementService, not here.',
            "router.post('/x', checkAuth, handler);",
        ];

        expect(summaryAbove(lines, 2)).toBe('Grants an achievement to a member');
    });

    test('stops at the blank line above a separate paragraph', () => {
        const lines = [
            '// A long design note about why this route exists at all.',
            '',
            '// Deletes one entry.',
            "router.delete('/x', checkAuth, handler);",
        ];

        expect(summaryAbove(lines, 3)).toBe('Deletes one entry');
    });

    test('finds nothing above an uncommented route, which is what fails the build', () => {
        expect(summaryAbove(["router.get('/x', handler);"], 0)).toBe('');
    });

    test('names the middleware in a fixed order, whatever order the route lists it', () => {
        expect(requirements(' checkWriteRateLimit, checkGuildAccess, checkAuth, async (req, res) => {'))
            .toEqual(['session', 'guild admin', 'write limit']);
    });

    test('calls a route with no middleware public', () => {
        expect(requirements(' async (req, res) => {')).toEqual(['public']);
    });

    test('escapes a pipe in a summary rather than splitting the table cell', () => {
        const body = renderEndpoints([{
            file: 'probe',
            routes: [{ method: 'GET', path: '/api/probe', requires: ['public'], summary: 'Either a | or a comma' }],
        }]);

        expect(body).toContain('| `GET` | `/api/probe` | public | Either a \\| or a comma |');
    });

    // A route written in a shape the regex misses would be silently absent from
    // the table, which is precisely the drift a generated list exists to stop.
    test('refuses a route it cannot read rather than dropping it silently', () => {
        withProbe("router.get(buildPath(), handler);\n", sources => {
            expect(() => parseRouter('__parser_probe', sources)).toThrow(/cannot read/);
        });
    });

    // No router defines a HEAD route today. If one ever does, it has to land in
    // the table rather than being quietly dropped by a pattern that never
    // expected it.
    test('reads a HEAD route like any other', () => {
        withProbe("// Probes whether an export is ready.\nrouter.head('/export', checkAuth, handler);\n", sources => {
            expect(parseRouter('__parser_probe', sources).routes).toEqual([{
                method: 'HEAD',
                path: '/api/v1/export',
                requires: ['session'],
                summary: 'Probes whether an export is ready',
            }]);
        });
    });

    test('a new HEAD route makes --check fail until the doc is regenerated', () => {
        // parseAll refuses an unmounted router, so the probe is mounted the way
        // a real router is — in the copied index, never the real one.
        withProbe("// Probes whether an export is ready.\nrouter.head('/export', checkAuth, handler);\n", sources => {
            const { current, next } = buildDoc(sources);

            expect(current === next).toBe(false);
            expect(next).toContain('| `HEAD` | `/api/v1/export` | session | Probes whether an export is ready |');
        }, { mount: true });
    });

    test('refuses a router routes/api.js never mounts', () => {
        withProbe("// Probe.\nrouter.get('/probe', handler);\n", sources => {
            expect(() => parseAll(sources)).toThrow(/never mounts: __parser_probe/);
        });
    });
});
