'use strict';

/**
 * #708. `package.json` sat at `1.0.0` for 299 commits and fourteen migrations
 * while three templates rendered a hardcoded `v4.2.0`, and no tag existed to
 * tell one build from another. The version is a real one now and the templates
 * read it; this is what stops all three drifting apart again.
 *
 * The migration assertion is the substantive one: it makes the changelog entry
 * for the current version state which migrations a deployment of it has run,
 * which is the fact a rollback decision turns on (docs/RELEASING.md).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const changelog = read('CHANGELOG.md');

/** The version in the newest `## [x.y.z]` heading, which is the released one. */
function newestChangelogVersion() {
    const match = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
    return match ? match[1] : null;
}

/** Everything under the newest heading, up to the next one. */
function newestChangelogEntry() {
    const start = changelog.search(/^## \[/m);
    const rest = changelog.slice(start);
    const next = rest.slice(1).search(/^## \[/m);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * `014_scope_item_images_per_guild` — the last migration a deploy will run.
 *
 * Ordered on the parsed number, not the filename. The series is zero-padded to
 * three digits today, which makes the two orderings agree, but the runner does
 * not require the padding: one `15_thing.js` written without it sorts before
 * `009_`, and this would then name a migration that is not the highest while
 * looking like it works.
 */
function highestMigration() {
    return fs.readdirSync(path.join(ROOT, 'src', 'migrations'))
        .filter(f => /^\d+_.+\.js$/.test(f))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .pop()
        .replace(/\.js$/, '');
}

describe('the released version', () => {
    test('is semver, and not the 1.0.0 placeholder it was pinned at', () => {
        expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pkg.version).not.toBe('1.0.0');
    });

    // `npm version` writes both; hand-editing package.json alone does not, and
    // the lockfile is what `npm ci` installs from.
    test('is the same in the lockfile, in both places it appears', () => {
        expect(lock.version).toBe(pkg.version);
        expect(lock.packages['']?.version).toBe(pkg.version);
    });

    test('has a changelog entry as its newest', () => {
        expect(newestChangelogVersion()).toBe(pkg.version);
    });
});

describe('the changelog entry for it', () => {
    // A migration added without touching the changelog leaves the newest entry
    // claiming a schema state no deployment of that version actually has, which
    // is the one thing that makes the mapping worse than having none.
    test('names the highest migration on disk', () => {
        expect(newestChangelogEntry()).toContain(highestMigration());
    });

    test('says something beyond its own heading', () => {
        expect(newestChangelogEntry().trim().split('\n').length).toBeGreaterThan(1);
    });
});

describe('the dashboard templates', () => {
    const views = path.join(ROOT, 'src', 'dashboard', 'views');
    const files = fs.readdirSync(views).filter(f => f.endsWith('.ejs'));

    // The footers and the hero eyebrow each carried their own copy. Every one
    // of them was wrong, and had been for the entire life of the repo.
    //
    // Two checks, because the copies were `v4.2.0` and a bare `4.2.0` is just
    // as wrong. A blanket `\d+\.\d+\.\d+` is not the way to catch the second:
    // guild-settings.ejs cites "WCAG 1.4.1" in a comment, and the stylesheet
    // attributes are full of decimals. Matching the version actually shipped is
    // both narrower and stricter — it fails on the one string that matters.
    test.each(files)('%s hardcodes no version of its own', file => {
        const body = read(path.join('src', 'dashboard', 'views', file));

        expect(body).not.toMatch(/v\d+\.\d+(\.\d+)?\b/);
        expect(body).not.toContain(pkg.version);
    });

    test('at least one of them renders the real version', () => {
        const rendered = files.filter(f => read(path.join('src', 'dashboard', 'views', f)).includes('<%= version %>'));
        expect(rendered.length).toBeGreaterThan(0);
    });
});
