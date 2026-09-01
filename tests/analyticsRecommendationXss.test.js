/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

// jsdom omits a few Node globals that mongoose's driver reaches for on require.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const fs = require('fs');
const path = require('path');
const { PUBLIC, bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

/**
 * #918. The overview and analytics panels render strings that come off
 * /stats and /insights — recommendations, churn alerts, likely causes —
 * straight into innerHTML. Every one of them is a fixed sentence the server
 * composes today, so there is no live injection path; the point is that the
 * first one to quote a guild name, a channel topic or a member's nickname
 * would make this stored XSS, and by then the escape wants to already be
 * there. These tests are what keeps it there.
 *
 * The payload is what such a recommendation would carry.
 */
const PAYLOAD = '<img src=x onerror="window.__xss=1">';

/** What /stats and /insights answer, with the payload in every API string. */
const STATS = {
    analytics: {
        recommendations: [PAYLOAD],
        churnAlerts: [PAYLOAD],
        likelyCauses: [PAYLOAD],
        commandUsage: {},
        economyStats: { activeUsers: 0 },
    },
    topLevels: [],
    memberGrowth: [],
};

const INSIGHTS = {
    retention: { joins7: 1, leaves7: 0 },
    newcomerConversion: {},
    activeHours: { topHours: [] },
    toxicChannels: [],
};

/** Boot the page, then answer the two analytics endpoints with the payload. */
function bootWithPayload() {
    bootPage();
    const panels = window.fetch;
    window.fetch = jest.fn(async (url, options) => {
        const target = String(url);
        if (/\/stats(\?|$)/.test(target)) return { ok: true, status: 200, json: async () => STATS };
        if (/\/insights(\?|$)/.test(target)) return { ok: true, status: 200, json: async () => INSIGHTS };
        return panels(url, options);
    });
}

describe('API-supplied analytics strings', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        delete window.__xss;
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    it('renders an overview recommendation as text, not markup', async () => {
        bootWithPayload();
        await window.loadOverviewStats();
        await settle();

        const msg = document.getElementById('clawdia-msg');
        // The payload survives as the visible text and nothing else.
        expect(msg.textContent).toContain(PAYLOAD);
        expect(msg.querySelector('img')).toBeNull();
        expect(window.__xss).toBeUndefined();
    });

    it('renders a churn alert in the activity feed as text too', async () => {
        bootWithPayload();
        await window.loadOverviewStats();
        await settle();

        const feed = document.getElementById('overview-activity-feed');
        expect(feed.textContent).toContain(PAYLOAD);
        expect(feed.querySelector('img')).toBeNull();
        expect(window.__xss).toBeUndefined();
    });

    it('renders an analytics recommendation card as text, not markup', async () => {
        bootWithPayload();
        clickTab('analytics');
        await settle();
        await window.loadAnalytics();
        await settle();

        const cards = document.getElementById('analytics-recommendations');
        expect(cards.textContent).toContain(PAYLOAD);
        expect(cards.querySelector('img')).toBeNull();
        expect(window.__xss).toBeUndefined();
    });

    it('renders the insight rows — churn alerts, likely causes — as text', async () => {
        bootWithPayload();
        clickTab('analytics');
        await settle();
        await window.loadAnalytics();
        await settle();

        const insights = document.getElementById('analytics-insights-content');
        expect(insights.textContent).toContain(PAYLOAD);
        expect(insights.querySelector('img')).toBeNull();
        expect(window.__xss).toBeUndefined();
    });

    it('never drops one of these strings into markup unescaped', () => {
        // The sinks themselves, so an edit that reintroduces a bare `${rec}`
        // fails here rather than waiting for the data to change. Each pattern
        // carries the markup around the interpolation, because `${val}` alone
        // also appears in a textContent assignment, where it is fine.
        const script = fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8');
        const sinks = [
            '<span>${r}</span>',                            // Ask Clawdia box
            '<strong>${label}</strong><span>${val}</span>', // insight rows
            '${it.text}</span>',                            // activity feed
            '\u{1F4A1} ${rec}</span>',                      // analytics rec card
            '\u{1F4A1} ${r.text}</span>',                   // the default cards
        ];
        for (const sink of sinks) {
            expect([sink, script.includes(sink)]).toEqual([sink, false]);
        }
    });
});
