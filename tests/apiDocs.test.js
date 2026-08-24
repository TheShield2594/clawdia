'use strict';

// API_REFERENCE.md documented none of the 46 endpoints under
// src/dashboard/routes/api/ — it was a cookbook of generic Express snippets
// whose only endpoint example was a `/api/custom/:guildId` that has never
// existed (#711). The tables are generated now, and this is what keeps them
// generated: adding, moving or renaming a route turns `npm test` red until
// `npm run docs:api` has been run.

const fs = require('fs');
const path = require('path');

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
        for (const route of routes.filter(r => r.path.includes(':guildId'))) {
            const label = `${route.method} ${route.path}`;
            // The two image reads are deliberately public: they are served to
            // <img> tags, and the guild id in the path is the only key.
            if (route.method === 'GET' && route.path.startsWith('/api/v1/item-image/')) {
                expect([label, route.requires]).toEqual([label, ['public']]);
                continue;
            }
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
    /** Runs `body` with an extra router file on disk, and removes it after. */
    function withProbe(source, body) {
        const file = path.join(API_DIR, '__parser_probe.js');
        fs.writeFileSync(file, source);
        try {
            body();
        } finally {
            fs.unlinkSync(file);
        }
    }

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
        withProbe("router.get(buildPath(), handler);\n", () => {
            expect(() => parseRouter('__parser_probe')).toThrow(/cannot read/);
        });
    });

    // No router defines a HEAD route today. If one ever does, it has to land in
    // the table rather than being quietly dropped by a pattern that never
    // expected it.
    test('reads a HEAD route like any other', () => {
        withProbe("// Probes whether an export is ready.\nrouter.head('/export', checkAuth, handler);\n", () => {
            expect(parseRouter('__parser_probe').routes).toEqual([{
                method: 'HEAD',
                path: '/api/v1/export',
                requires: ['session'],
                summary: 'Probes whether an export is ready',
            }]);
        });
    });

    test('a new HEAD route makes --check fail until the doc is regenerated', () => {
        withProbe("// Probes whether an export is ready.\nrouter.head('/export', checkAuth, handler);\n", () => {
            // parseAll refuses an unmounted router, so mount the probe the way a
            // real router is mounted and check the doc against what it renders.
            const index = fs.readFileSync(API_INDEX, 'utf8');
            fs.writeFileSync(API_INDEX, `${index}\nrouter.use(require('./api/__parser_probe'));\n`);
            try {
                const { current, next } = buildDoc();
                expect(current === next).toBe(false);
                expect(next).toContain('| `HEAD` | `/api/v1/export` | session | Probes whether an export is ready |');
            } finally {
                fs.writeFileSync(API_INDEX, index);
            }
        });
    });

    test('refuses a router routes/api.js never mounts', () => {
        withProbe("// Probe.\nrouter.get('/probe', handler);\n", () => {
            expect(() => parseAll()).toThrow(/never mounts: __parser_probe/);
        });
    });
});
