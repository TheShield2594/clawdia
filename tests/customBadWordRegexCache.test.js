'use strict';

// #606: the base profanity list is compiled once at module load, but a guild's
// own additions were rebuilt from scratch on every message that reached the
// filter. They change only when an admin edits the list, so the compiled
// patterns are now kept until that happens.

const { _getCustomBadWordRegexes: getCustomBadWordRegexes } = require('../src/events/messageCreate');

describe('custom bad-word regex memoization', () => {
    it('compiles a guild\'s list once and reuses it', () => {
        const words = ['frobnicate', 'blorp'];

        const first = getCustomBadWordRegexes('g1', words);
        const second = getCustomBadWordRegexes('g1', words);

        expect(second).toBe(first);
    });

    it('reuses the compiled list across separate array instances with the same words', () => {
        // Each read hands back a fresh settings object, so the array identity
        // changes even when the admin has not touched the word list. Keying on
        // identity would recompile on every settings reload.
        const first = getCustomBadWordRegexes('g2', ['alpha', 'beta']);
        const second = getCustomBadWordRegexes('g2', ['alpha', 'beta']);

        expect(second).toBe(first);
    });

    it('recompiles when the guild\'s word list actually changes', () => {
        const first = getCustomBadWordRegexes('g3', ['alpha']);
        const second = getCustomBadWordRegexes('g3', ['alpha', 'beta']);

        expect(second).not.toBe(first);
        expect(second).toHaveLength(2);
    });

    it('recompiles when a word is removed', () => {
        getCustomBadWordRegexes('g4', ['alpha', 'beta']);
        const after = getCustomBadWordRegexes('g4', ['alpha']);

        expect(after).toHaveLength(1);
        expect(after[0].test('alpha')).toBe(true);
        expect(after[0].test('beta')).toBe(false);
    });

    it('does not let one guild see another guild\'s words', () => {
        const a = getCustomBadWordRegexes('g5', ['onlyhere']);
        const b = getCustomBadWordRegexes('g6', ['different']);

        expect(b).not.toBe(a);
        expect(b[0].test('onlyhere')).toBe(false);
    });

    it('matches on a word boundary and ignores case, as the base list does', () => {
        const [re] = getCustomBadWordRegexes('g7', ['Blorp']);

        expect(re.test('what a blorp')).toBe(true);
        expect(re.test('BLORP')).toBe(true);
        expect(re.test('blorpy')).toBe(false);
    });

    it('escapes regex metacharacters in an admin-entered word', () => {
        const [re] = getCustomBadWordRegexes('g8', ['a.c']);

        expect(re.test('a.c')).toBe(true);
        expect(re.test('abc')).toBe(false);
    });

    it('returns an empty list without caching anything for a guild with no custom words', () => {
        expect(getCustomBadWordRegexes('g9', [])).toEqual([]);
        expect(getCustomBadWordRegexes('g9', undefined)).toEqual([]);
        expect(getCustomBadWordRegexes('g9', null)).toEqual([]);
    });

    it('bounds itself so a large guild count cannot grow the map without limit', () => {
        // 5_000 entries is the cap; the oldest is evicted rather than retained.
        // An evicted guild simply recompiles on its next filtered message.
        const first = getCustomBadWordRegexes('evictme', ['word']);
        for (let i = 0; i < 5_001; i++) getCustomBadWordRegexes(`filler-${i}`, ['word']);

        expect(getCustomBadWordRegexes('evictme', ['word'])).not.toBe(first);
    });
});
