'use strict';

/**
 * #666. Forty-odd collectors filtered with
 * `filter: i => i.user.id === interaction.user.id`. A filter returning false
 * does not decline an interaction — it drops it, and Discord's client, after
 * waiting three seconds for a response that was never coming, shows the member
 * a red "This interaction failed". Most of these buttons are on a public
 * message, so the second person to reach for the Replay button under someone
 * else's slot spin was told the bot was broken.
 */
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

const { NOT_YOURS, rejectOtherUser, ownedBy, ownedByMembers } = require('../src/utils/collectorOwner');

const SRC = path.join(__dirname, '..', 'src');

/** A component interaction that records what it was replied with. */
function click(userId, customId = 'x') {
    const replies = [];
    return {
        replies,
        user: { id: userId },
        customId,
        reply: payload => { replies.push(payload); return Promise.resolve(); },
    };
}

describe('ownedBy', () => {
    it('lets the owner through without saying anything', () => {
        const i = click('owner');
        expect(ownedBy('owner')(i)).toBe(true);
        expect(i.replies).toEqual([]);
    });

    it('turns everyone else away with an ephemeral explanation', () => {
        const i = click('stranger');
        expect(ownedBy('owner')(i)).toBe(false);
        expect(i.replies).toEqual([{ content: NOT_YOURS, flags: MessageFlags.Ephemeral }]);
    });

    it('says what the caller asked it to say', () => {
        const i = click('stranger');
        ownedBy('owner', () => true, "This isn't your spin.")(i);
        expect(i.replies[0].content).toBe("This isn't your spin.");
    });

    // Half the call sites have no customId test to give — their collector is on
    // a message carrying only their own buttons — and pass the message in the
    // second position. Calling a string threw `matches is not a function` on
    // every click including the owner's, and a filter that throws takes the
    // collector with it, so those buttons did nothing at all (#786). No test
    // reached the two-argument form until the interaction harness started
    // running filters.
    it('takes the message in the second position when there is no customId test', () => {
        const owner = click('owner');
        expect(ownedBy('owner', "This isn't your job.")(owner)).toBe(true);
        expect(owner.replies).toEqual([]);

        const stranger = click('stranger');
        expect(ownedBy('owner', "This isn't your job.")(stranger)).toBe(false);
        expect(stranger.replies[0].content).toBe("This isn't your job.");
    });

    it('still falls back to the default message with neither argument', () => {
        const i = click('stranger');
        expect(ownedBy('owner')(i)).toBe(false);
        expect(i.replies[0].content).toBe(NOT_YOURS);
    });

    it('is what every call site actually passes', () => {
        // The two forms, checked against the tree rather than assumed: a second
        // argument is either a function or a string, and nothing else.
        const bad = [];
        const seen = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (entry.name !== 'dashboard') walk(full); continue; }
                // The file that declares them, where the "second argument" is
                // the parameter list.
                if (!entry.name.endsWith('.js') || full === path.join(SRC, 'utils', 'collectorOwner.js')) continue;
                const src = fs.readFileSync(full, 'utf8');
                for (const m of src.matchAll(/ownedBy(?:Members)?\(\s*([^\n]*)/g)) {
                    const rest = m[1].trim();
                    // Only the single-line calls are checked; the wrapped ones
                    // are the customId-test form by construction.
                    if (!rest.includes(',')) continue;
                    const second = rest.slice(rest.indexOf(',') + 1).trim();
                    if (!second) continue;
                    const looksLikeFunction = /^\(?\w*\)?\s*=>/.test(second) || /^(function|i\b|c\b)/.test(second);
                    const looksLikeString = /^["'`]/.test(second);
                    if (!looksLikeFunction && !looksLikeString) {
                        bad.push(`${path.relative(SRC, full)}: ${second.slice(0, 40)}`);
                    }
                    seen.push(path.relative(SRC, full));
                }
            }
        };
        walk(SRC);
        // A sweep that finds nothing to inspect reports the same green as one
        // that found nothing wrong.
        expect(seen.length).toBeGreaterThan(20);
        expect(bad).toEqual([]);
    });

    it('accepts a set of owners, for the two-party prompts', () => {
        expect(ownedBy(['a', 'b'])(click('b'))).toBe(true);
        expect(ownedBy(['a', 'b'])(click('c'))).toBe(false);
    });

    it('ignores an unrelated component in silence, rather than refusing it', () => {
        // Another command's buttons can share a message. Answering "this isn't
        // yours" to a click the collector was never interested in would be a
        // second kind of wrong reply.
        const i = click('stranger', 'someone_elses_button');
        expect(ownedBy('owner', c => c.customId === 'ours')(i)).toBe(false);
        expect(i.replies).toEqual([]);
    });

    it('checks the customId before the user, so the owner is filtered too', () => {
        const i = click('owner', 'not_ours');
        expect(ownedBy('owner', c => c.customId === 'ours')(i)).toBe(false);
        expect(i.replies).toEqual([]);
    });

    it('survives a reply that never lands', () => {
        // The interaction may already have expired, or the bot may have lost
        // the channel. Neither may take the collector down.
        const i = { user: { id: 'stranger' }, customId: 'x', reply: () => Promise.reject(new Error('10062')) };
        expect(() => ownedBy('owner')(i)).not.toThrow();
    });
});

describe('ownedByMembers', () => {
    const players = new Set(['a']);

    it('asks at click time, not when the collector was built', () => {
        const filter = ownedByMembers(id => players.has(id));
        expect(filter(click('b'))).toBe(false);
        players.add('b');
        expect(filter(click('b'))).toBe(true);
    });

    it('tells a non-member why nothing happened', () => {
        const i = click('nobody');
        ownedByMembers(id => players.has(id), () => true, "You're not in this round.")(i);
        expect(i.replies).toEqual([{ content: "You're not in this round.", flags: MessageFlags.Ephemeral }]);
    });
});

describe('rejectOtherUser', () => {
    it('reports whether it handled the click, so a filter can negate it', () => {
        expect(rejectOtherUser(click('owner'), 'owner')).toBe(false);
        expect(rejectOtherUser(click('stranger'), 'owner')).toBe(true);
    });
});

describe('no collector drops another member\'s click in silence', () => {
    function componentFilters() {
        const found = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'dashboard') walk(full);
                } else if (entry.name.endsWith('.js')) {
                    fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                        if (/^\s*filter:.*\.user\.id\s*===/.test(line)) {
                            found.push(`${path.relative(SRC, full)}:${i + 1}`);
                        }
                    });
                }
            }
        };
        walk(SRC);
        return found;
    }

    it('leaves no bare user check in a collector filter', () => {
        // Bare, meaning: returns false for the wrong member and says nothing.
        // ownedBy / ownedByMembers / rejectOtherUser all answer first.
        expect(componentFilters()).toEqual([]);
    });

    it('actually reached the call sites', () => {
        // A sweep that derives its own input reports the same green for
        // "nothing was wrong" as for "nothing was looked at".
        const uses = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (entry.name !== 'dashboard') walk(full); }
                else if (entry.name.endsWith('.js') && full !== path.join(SRC, 'utils', 'collectorOwner.js')) {
                    if (/collectorOwner/.test(fs.readFileSync(full, 'utf8'))) uses.push(full);
                }
            }
        };
        walk(SRC);
        expect(uses.length).toBeGreaterThan(25);
    });
});
