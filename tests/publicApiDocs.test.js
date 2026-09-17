'use strict';

// #1018. The public routes are documented in API_REFERENCE.md as public, and
// #927 is the reminder that a "public" claim in the docs has to actually match
// the code. It does here because the label is read off the route's middleware
// chain, not typed: a route that grew a `checkAuth` would stop rendering as
// public, and this keeps the block regenerated whenever the routes change.

const fs = require('fs');

const {
    parsePublicRouter,
    renderPublicEndpoints,
    buildFullDoc,
    replacePublicBlock,
    PUBLIC_BEGIN,
    PUBLIC_END,
    DOC_PATH,
} = require('../scripts/docs-api');

describe('the public routes block', () => {
    test('is in step with routes/public.js', () => {
        const { current, next } = buildFullDoc();
        expect(current === next).toBe(true);
    });

    test('keeps its own markers, distinct from the /api/v1 block', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');
        expect(doc).toContain(PUBLIC_BEGIN);
        expect(doc).toContain(PUBLIC_END);
        expect(doc.indexOf(PUBLIC_BEGIN)).toBeLessThan(doc.indexOf(PUBLIC_END));
    });

    test('refuses to write when the public markers are gone', () => {
        expect(() => replacePublicBlock('# Doc\n\nno markers\n', 'body')).toThrow(/missing the/);
    });
});

describe('the routes it documents', () => {
    const routes = parsePublicRouter();

    test('are the three public pages, all under /s', () => {
        expect(routes.map(r => `${r.method} ${r.path}`)).toEqual([
            'GET /s/:id',
            'GET /s/:id/u/:userId',
            'GET /s/:id/u/:userId/card.png',
        ]);
    });

    test('are documented as public — the claim the code must match', () => {
        for (const route of routes) {
            expect([route.path, route.requires]).toEqual([route.path, ['public']]);
        }
    });

    test('and the rendered table says so', () => {
        const table = renderPublicEndpoints();
        expect(table).toContain('| `GET` | `/s/:id` | public |');
        expect(table).toContain('/s/:id/u/:userId/card.png');
    });
});
