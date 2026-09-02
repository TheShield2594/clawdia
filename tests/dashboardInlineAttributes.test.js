/**
 * #692, finished in #887. The dashboard's CSP is a per-request nonce, and it
 * used to have two holes in it: `style-src 'unsafe-inline'` and
 * `script-src-attr 'unsafe-inline'`. Both were there for the same reason — the
 * views carried hundreds of `style=""` and `onclick=""` attributes, and an
 * attribute cannot carry a nonce. The second mattered more than it looked:
 * `script-src-attr 'unsafe-inline'` is what turns a stored-XSS finding from
 * blocked into exploitable.
 *
 * #692 declined to fix either outright and built a ratchet instead, so that the
 * day the allowances could be dropped would actually arrive. This is that file,
 * and for the handler half the day has come: every `onclick=""` in the views is
 * a `data-action` now, dispatched from one delegated listener, and the
 * directive is `'none'`.
 *
 * So the two halves are no longer the same rule, and this no longer states them
 * as one:
 *
 *   * Inline handlers are banned outright, in a view or in a script. With the
 *     directive dropped, one would not be a slipped standard — it would be a
 *     control that silently does nothing.
 *   * Inline styles stay a ratchet. Every file that has them is recorded with
 *     what it has; a file may hold its count or lower it, never raise it, and a
 *     file not in the table must have none. `style-src 'unsafe-inline'` is a
 *     much smaller thing than `script-src-attr` was, and untangling 327 of them
 *     is the large change with no visible result that #692 declined to make.
 *
 * When you remove some, lower the number here in the same commit. A count that
 * is merely stale reads as a budget nobody is spending, which is the opposite
 * of what this is for. The convention is written up in docs/EXTENDING.md.
 *
 * ## The scripts count too (#887)
 *
 * For its first two years this counted views and nothing else, which made the
 * number it reported wrong in the direction that mattered: public/*.js builds
 * markup with `innerHTML` and `insertAdjacentHTML`, and those strings carried
 * around forty inline handlers of their own. Every one of them held the
 * directive open exactly as a view's would, and they sat next to the API
 * strings a security review named as the injection sinks — so the ratchet could
 * have reached zero on the views and the directive still could not have gone.
 */
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');
const PUBLIC = path.join(__dirname, '..', 'src', 'dashboard', 'public');

// file (relative to views/) -> inline style attributes
//
// The handler column is gone: it is zero for every view, and the assertion
// below is now a ban rather than a budget. What is left is the styles, which
// stay a ratchet — `style-src 'unsafe-inline'` is a much smaller thing than
// `script-src-attr` was, and untangling 327 of them is the large change with no
// visible result that #692 declined to make.
const BASELINE = {
    'dashboard.ejs': 4,
    'guild-settings.ejs': 12,
    'index.ejs': 11,
    'partials/game-item-card.ejs': 1,
    'partials/panels/achievements.ejs': 14,
    'partials/panels/ai.ejs': 50,
    'partials/panels/analytics.ejs': 10,
    'partials/panels/antinuke.ejs': 12,
    'partials/panels/bibleverses.ejs': 4,
    'partials/panels/commandpolicies.ejs': 21,
    'partials/panels/economy.ejs': 39,
    'partials/panels/eventlog.ejs': 6,
    'partials/panels/exploration.ejs': 5,
    'partials/panels/leveling.ejs': 28,
    'partials/panels/moderation.ejs': 28,
    'partials/panels/newspaper.ejs': 4,
    'partials/panels/overview.ejs': 18,
    'partials/panels/progressiontracks.ejs': 2,
    'partials/panels/quests.ejs': 5,
    'partials/panels/raiddetection.ejs': 1,
    'partials/panels/reactionroles.ejs': 5,
    'partials/panels/rss.ejs': 6,
    'partials/panels/season.ejs': 7,
    'partials/panels/starboard.ejs': 1,
    'partials/panels/suggestions.ejs': 6,
    'partials/panels/tempvoice.ejs': 2,
    'partials/panels/welcome.ejs': 5,
};

// The same table for the browser scripts that build markup. Chart.js under
// vendor/ is not ours and is not swept; everything else here is.
//
// file (relative to public/) -> inline style attributes
const SCRIPT_BASELINE = {
    // Layout a rendered row sets on itself — a card's own display and spacing,
    // an avatar's 16px box. Lower it the way the view numbers are lowered: move
    // the rule into a class in styles.css.
    'guild-settings.js': 102,
};

// Either quote style. HTML treats style='x' and onclick='x()' exactly like
// their double-quoted forms, and the CSP does too — a regex that only saw one
// of them let a view not in BASELINE carry inline handlers and still report
// clean, which is the case this whole file exists to prevent.
const STYLE_ATTR = /\sstyle\s*=\s*["']/g;
const HANDLER_ATTR = /\son[a-z]+\s*=\s*["']/g;

function views(dir = VIEWS) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...views(full));
        else if (entry.name.endsWith('.ejs')) found.push(path.relative(VIEWS, full));
    }
    return found.sort();
}

function counts(file, root = VIEWS) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    return [(src.match(STYLE_ATTR) || []).length, (src.match(HANDLER_ATTR) || []).length];
}

function scripts() {
    return fs.readdirSync(PUBLIC, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => entry.name)
        .sort();
}

const allViews = views();
// A sweep that derives its own input reports the same green for "nothing was
// wrong" as for "nothing was looked at".
if (!allViews.length) throw new Error('no views found — the sweep would inspect nothing');

// The list is built here, at module load, and each file is read later in its
// own test body. That gap used to be a race: tests/panelDocs.test.js wrote a
// probe template into views/partials/panels/ and deleted it again, and Jest
// runs suites in parallel workers, so this one could list the probe and then
// read a file that had already vanished — a run with one extra test case and an
// ENOENT out of counts(), green again on a re-run.
//
// It is ruled out rather than tolerated: withProbe builds a mirror directory
// under os.tmpdir() now and writes nothing inside src/ at all, and a test there
// fails if that stops being true. So a file listed here and missing at read
// time is a real fault, and counts() should still throw on it — swallowing an
// ENOENT would turn a deleted view into a silently skipped one, which is the
// failure this whole sweep exists to prevent.

describe('inline styles only ever decrease, and handlers are gone', () => {
    it.each(allViews)('%s stays within its recorded style count', file => {
        const styles = counts(file)[0];
        const maxStyles = BASELINE[file] ?? 0;

        // A new view is expected to be clean: use a class in styles.css. See
        // docs/EXTENDING.md, "Styles and handlers in dashboard views".
        // Compared as numbers rather than booleans so a failure reports what
        // the file has and what it is allowed to have; it.each already names it.
        expect(styles).toBeLessThanOrEqual(maxStyles);
    });

    it('records no file that has since been cleaned up or removed', () => {
        // A baseline entry left behind after the work is done is a budget
        // nobody is spending, and it quietly re-permits what was removed.
        const stale = Object.entries(BASELINE)
            .filter(([file, styles]) => !allViews.includes(file) || counts(file)[0] < styles)
            .map(([file]) => file);
        expect(stale).toEqual([]);
    });

    it.each(scripts())('%s renders no more inline styles than recorded', file => {
        expect(counts(file, PUBLIC)[0]).toBeLessThanOrEqual(SCRIPT_BASELINE[file] ?? 0);
    });

    it('records no script that has since been cleaned up or removed', () => {
        const present = scripts();
        const stale = Object.entries(SCRIPT_BASELINE)
            .filter(([file, styles]) => !present.includes(file) || counts(file, PUBLIC)[0] < styles)
            .map(([file]) => file);
        expect(stale).toEqual([]);
    });

    it('has no inline handler left anywhere, in a view or in a script', () => {
        // The assertion the whole file was built to reach (#887). It is a ban,
        // not a budget: with `script-src-attr 'unsafe-inline'` dropped from the
        // CSP, one of these would not be a slipped standard — it would be a
        // control that silently does nothing, blocked by the policy.
        const offenders = [
            ...allViews.filter(file => counts(file)[1] > 0).map(file => `views/${file}`),
            ...scripts().filter(file => counts(file, PUBLIC)[1] > 0).map(file => `public/${file}`),
        ];
        expect(offenders).toEqual([]);
    });

    it('is what the CSP comment in server.js points at', () => {
        // The rationale and the ratchet have to move together, or the comment
        // outlives the reason.
        const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'server.js'), 'utf8');
        expect(server).toContain("style-src 'self' 'unsafe-inline'");
        expect(server).toMatch(/dashboardInlineAttributes/);
    });

    it('no longer allows an inline handler attribute to run at all', () => {
        // The point of the exercise. `script-src-attr 'unsafe-inline'` is what
        // decides whether an injected `onclick=""` executes or is blocked, and
        // with nothing left needing it, it is gone (#887). The explicit
        // `'none'` rather than silence: script-src-attr falls back to
        // script-src, which carries a nonce — and an attribute cannot have one,
        // so the fallback would refuse them too, but only by implication.
        // Comments stripped: server.js explains what it dropped and why, in
        // prose that names the very directive this is asserting is gone.
        const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'server.js'), 'utf8')
            .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
        expect(server).toContain("script-src-attr 'none'");
        expect(server).not.toContain("script-src-attr 'unsafe-inline'");
    });
});
