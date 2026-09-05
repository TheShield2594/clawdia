'use strict';

/**
 * The watch on `rss-parser` (#954).
 *
 * Not a defect, and there is nothing to fix today. `rss-parser` is historically
 * slow-moving and brings a transitive XML-parsing surface, which is a category
 * with a long history of entity-expansion and parser CVEs — and it processes
 * attacker-influenced input, since any URL a guild admin can subscribe to ends
 * up in it. The fetch side is already handled: `safeFeedFetch.js` pins DNS,
 * refuses private and reserved addresses on every redirect hop, and caps the
 * body at 5 MB. This is about the parse side and the package's maintenance
 * trajectory.
 *
 * A watch item that lives only in an issue is a watch item nobody keeps. What
 * this file does is hold the two things that make the watch actionable, so
 * neither can lapse quietly:
 *
 *   1. Dependabot still covers it, so a published advisory raises a PR the day
 *      it lands rather than whenever somebody next runs `npm audit`.
 *   2. The surface stays small. The exit plan, if the package does go
 *      unmaintained, is to vendor or replace the parsing this project actually
 *      uses — and that plan is only cheap while "what it actually uses" is one
 *      method on a string that something else already fetched and bounded. A
 *      third call site, or a `parseURL` that does its own fetching, is what
 *      would turn a morning's work into a migration; each is one line to write
 *      and neither would be noticed in review.
 *
 * If it does go stale, the replacement is `parseString` against a maintained
 * parser, and nothing else in `src/` has to change.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// Comments stripped throughout: both rssService.js and safeFeedFetch.js explain
// in prose why they do not use the call this file asserts nobody makes, and the
// assertion would otherwise be failed by its own documentation.
const stripComments = src => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

/**
 * The argument text of every `.parseString(...)` call in one source file.
 *
 * Paren-matched rather than regexed to the next `)`, because the argument that
 * matters most — `parseString(await safeFetchFeed(url))` — contains one.
 */
function parseStringArguments(src) {
    const args = [];
    const CALL = /\.parseString\(/g;
    for (let match = CALL.exec(src); match; match = CALL.exec(src)) {
        let depth = 1;
        let i = match.index + match[0].length;
        const start = i;
        for (; i < src.length && depth > 0; i += 1) {
            if (src[i] === '(') depth += 1;
            else if (src[i] === ')') depth -= 1;
        }
        args.push(src.slice(start, i - 1).trim());
    }
    return args;
}

const sources = walk(path.join(ROOT, 'src'))
    .map(file => [path.relative(ROOT, file), stripComments(fs.readFileSync(file, 'utf8'))]);

const importers = sources
    .filter(([, src]) => /require\(['"]rss-parser['"]\)/.test(src))
    .map(([file]) => file);

describe('rss-parser stays watched (#954)', () => {
    it('is a direct dependency, so Dependabot can see it at all', () => {
        // A transitive-only dependency is updated when its parent chooses to,
        // which for a slow-moving package is the failure mode this watch is
        // about. It is direct today; this fails if it is ever demoted.
        expect(Object.keys(pkg.dependencies)).toContain('rss-parser');
    });

    it('is not excluded from the npm update schedule', () => {
        const config = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8'));
        const npm = config.updates.find(u => u['package-ecosystem'] === 'npm');
        expect(npm).toBeDefined();
        expect(npm.directory).toBe('/');
        // `ignore` is the cheapest way to make this watch silently stop: one
        // entry added to quiet a noisy bump takes the security PRs with it,
        // because Dependabot applies it to those too.
        const ignored = (npm.ignore || []).map(rule => rule['dependency-name']);
        expect(ignored).not.toContain('rss-parser');
        expect(ignored).not.toContain('*');
        // `allow` is the same hole from the other side, and the quieter one: it
        // is a whitelist, so adding an entry for any *other* package silently
        // drops everything not named — this one included — rather than
        // mentioning it. Absent is the state today and the state that keeps the
        // schedule reaching everything.
        const allowed = (npm.allow || []).map(rule => rule['dependency-name']);
        if (npm.allow) {
            expect(allowed).toContain('rss-parser');
        }
    });

    it('is required in exactly the two places that parse a feed', () => {
        // Named rather than counted: a third importer is not automatically
        // wrong, but it is the thing to look at, and adding it here is the
        // moment to ask whether the vendoring plan still holds.
        expect(importers.sort()).toEqual([
            'src/dashboard/routes/api/rss.js',
            'src/services/rssService.js',
        ]);
    });

    it('never fetches for itself', () => {
        for (const [file, src] of sources) {
            // `parseURL` does its own HTTP, which walks straight past the DNS
            // pinning, the private-address refusal on every redirect hop and the
            // body cap in safeFeedFetch.js — a feed URL is operator-supplied, so
            // that is an SSRF proxy and an unbounded read in one call.
            expect([file, src.includes('parseURL')]).toEqual([file, false]);
        }
    });

    it('is only ever handed a string something else already bounded', () => {
        for (const file of importers) {
            const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
            // The module and the function it exports are spelled differently —
            // `safeFeedFetch.js` exports `safeFetchFeed` — and only the second
            // proves the guard is actually called rather than merely imported.
            expect([file, /require\(['"][^'"]*safeFeedFetch['"]\)/.test(src)]).toEqual([file, true]);
            expect([file, /\bsafeFetchFeed\s*\(/.test(src)]).toEqual([file, true]);

            // `parseString` is the whole of the surface, and so the whole of
            // what a replacement would have to provide. Anything else here
            // means the exit plan wants re-costing before it is needed rather
            // than after.
            const calls = [...src.matchAll(/\b(?:parser|feedParser)\.(\w+)\(/g)];
            expect([file, calls.length]).not.toEqual([file, 0]);
            for (const [, method] of calls) {
                expect([file, method]).toEqual([file, 'parseString']);
            }

            // And what it is handed has to come from the guard, not merely be
            // parsed in a file that happens to import it. Both shapes are in
            // use: the service inlines the call, the route awaits it into a
            // local first — so an argument is either the call itself or an
            // identifier this file assigns from it. `parseString(rawBody)`
            // after a bare fetch is the regression, and it is one line.
            for (const argument of parseStringArguments(src)) {
                if (/\bsafeFetchFeed\s*\(/.test(argument)) continue;
                expect([file, argument]).toEqual([file, expect.stringMatching(/^[A-Za-z_$][\w$]*$/)]);
                const assignment = new RegExp(
                    `\\b(?:const|let|var)\\s+${argument}\\s*=\\s*await\\s+safeFetchFeed\\s*\\(`);
                expect([file, argument, assignment.test(src)]).toEqual([file, argument, true]);
            }
        }
    });
});
