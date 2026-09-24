'use strict';

/**
 * #1157. Feed URLs were logged whole, and a private feed's access token rides
 * in the query string. The label keeps origin + path and swaps anything else
 * for a short hash of the full URL.
 */
const fs = require('fs');
const path = require('path');
const { feedUrlLabel } = require('../src/utils/feedUrlLabel');

describe('feedUrlLabel', () => {
    it('leaves a URL with nothing secret-shaped in it as it was', () => {
        expect(feedUrlLabel('https://example.com/feed.xml')).toBe('https://example.com/feed.xml');
    });

    it('drops the query string, keeping a hash to tell subscriptions apart', () => {
        const a = feedUrlLabel('https://github.com/me.private.atom?token=SECRET1');
        const b = feedUrlLabel('https://github.com/me.private.atom?token=SECRET2');
        expect(a).toMatch(/^https:\/\/github\.com\/me\.private\.atom #[0-9a-f]{8}$/);
        expect(a).not.toContain('SECRET1');
        expect(a).not.toBe(b);
    });

    it('drops embedded credentials and the fragment', () => {
        const label = feedUrlLabel('https://user:pass@example.com/rss#key=SECRET');
        expect(label).toMatch(/^https:\/\/example\.com\/rss #[0-9a-f]{8}$/);
        expect(label).not.toMatch(/user|pass|SECRET/);
    });

    it('never echoes a string it cannot parse', () => {
        const label = feedUrlLabel('not a url ?token=SECRET');
        expect(label).toMatch(/^\[unparseable feed URL #[0-9a-f]{8}\]$/);
        expect(feedUrlLabel(undefined)).toMatch(/^\[unparseable feed URL #/);
    });
});

describe('feed services log labels, not raw URLs', () => {
    // A new log line written the obvious way — `${feed.url}` in a template —
    // is the regression this catches.
    const RAW = /console\.\w+\([^\n]*\$\{(?:feedUrl|feed\.url|feed\.feedUrl|url)\}/;

    it.each(['src/services/rssService.js', 'src/services/socialService.js'])('%s', file => {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        expect(source).not.toMatch(RAW);
    });
});
