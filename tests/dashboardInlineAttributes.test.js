/**
 * #692. The dashboard's CSP is a per-request nonce, with two holes in it:
 * `style-src 'unsafe-inline'` and `script-src-attr 'unsafe-inline'`. Both are
 * there for the same reason — the views carry hundreds of `style=""` and
 * `onclick=""` attributes, and an attribute cannot carry a nonce. The second
 * one matters more than it looks: `script-src-attr 'unsafe-inline'` is what
 * turns a stored-XSS finding from blocked into exploitable.
 *
 * The issue's own conclusion was that a sweeping refactor is not worth doing
 * now, and that is still true — untangling 327 inline styles is a large change
 * with no visible result and a real chance of breaking layout. What is worth
 * doing is making sure the number only ever goes down, so the day the two
 * allowances can be dropped actually arrives.
 *
 * So this is a ratchet, not a ban. Every view that has inline attributes today
 * is recorded here with what it has; a file may hold its count or lower it,
 * never raise it, and a view not in the table must have none at all. New
 * panels therefore start clean, which is exactly what the issue asked for:
 * classes in styles.css and addEventListener, so the allowances can eventually
 * go. The convention is written up in docs/EXTENDING.md.
 *
 * When you remove some, lower the number here in the same commit. A count that
 * is merely stale reads as a budget nobody is spending, which is the opposite
 * of what this is for.
 */
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', 'src', 'dashboard', 'views');

// file (relative to views/) -> [inline style attributes, inline handler attributes]
const BASELINE = {
    'dashboard.ejs': [9, 0],
    'guild-settings.ejs': [16, 5],
    'index.ejs': [11, 0],
    'partials/game-item-card.ejs': [2, 4],
    'partials/panels/achievements.ejs': [14, 9],
    'partials/panels/ai.ejs': [50, 21],
    'partials/panels/analytics.ejs': [10, 3],
    'partials/panels/antinuke.ejs': [12, 1],
    'partials/panels/bibleverses.ejs': [4, 2],
    'partials/panels/birthdays.ejs': [0, 2],
    'partials/panels/commandpolicies.ejs': [21, 11],
    'partials/panels/economy.ejs': [42, 22],
    'partials/panels/eventlog.ejs': [6, 1],
    'partials/panels/exploration.ejs': [5, 1],
    'partials/panels/farewell.ejs': [0, 2],
    'partials/panels/leveling.ejs': [29, 14],
    'partials/panels/moderation.ejs': [28, 19],
    'partials/panels/newspaper.ejs': [4, 1],
    'partials/panels/overview.ejs': [20, 7],
    'partials/panels/progressiontracks.ejs': [2, 1],
    'partials/panels/quests.ejs': [5, 1],
    'partials/panels/raiddetection.ejs': [1, 1],
    'partials/panels/reactionroles.ejs': [7, 3],
    'partials/panels/rss.ejs': [8, 7],
    'partials/panels/season.ejs': [7, 3],
    'partials/panels/starboard.ejs': [1, 1],
    'partials/panels/suggestions.ejs': [6, 1],
    'partials/panels/tempvoice.ejs': [2, 1],
    'partials/panels/welcome.ejs': [5, 4],
};

const STYLE_ATTR = /\sstyle\s*=\s*"/g;
const HANDLER_ATTR = /\son[a-z]+\s*=\s*"/g;

function views(dir = VIEWS) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...views(full));
        else if (entry.name.endsWith('.ejs')) found.push(path.relative(VIEWS, full));
    }
    return found.sort();
}

function counts(file) {
    const src = fs.readFileSync(path.join(VIEWS, file), 'utf8');
    return [(src.match(STYLE_ATTR) || []).length, (src.match(HANDLER_ATTR) || []).length];
}

const allViews = views();
// A sweep that derives its own input reports the same green for "nothing was
// wrong" as for "nothing was looked at".
if (!allViews.length) throw new Error('no views found — the sweep would inspect nothing');

describe('inline styles and handlers only ever decrease', () => {
    it.each(allViews)('%s stays within its recorded count', file => {
        const [styles, handlers] = counts(file);
        const [maxStyles, maxHandlers] = BASELINE[file] || [0, 0];

        // A new view is expected to be clean: use a class in styles.css and
        // addEventListener. See docs/EXTENDING.md, "Styles and handlers in
        // dashboard views".
        expect({ file, styles: styles <= maxStyles, handlers: handlers <= maxHandlers })
            .toEqual({ file, styles: true, handlers: true });
    });

    it('records no file that has since been cleaned up or removed', () => {
        // A baseline entry left behind after the work is done is a budget
        // nobody is spending, and it quietly re-permits what was removed.
        const stale = Object.entries(BASELINE)
            .filter(([file, [styles, handlers]]) => {
                if (!allViews.includes(file)) return true;
                const [haveStyles, haveHandlers] = counts(file);
                return haveStyles < styles || haveHandlers < handlers;
            })
            .map(([file]) => file);
        expect(stale).toEqual([]);
    });

    it('is what the CSP comment in server.js points at', () => {
        // The rationale and the ratchet have to move together, or the comment
        // outlives the reason.
        const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'server.js'), 'utf8');
        expect(server).toContain("style-src 'self' 'unsafe-inline'");
        expect(server).toContain("script-src-attr 'unsafe-inline'");
        expect(server).toMatch(/dashboardInlineAttributes/);
    });
});
