/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
'use strict';

// #788: guild-settings.js is the largest file in the repo and no test loaded
// it. Chasing 4,500 lines of DOM wiring is not worth it; the layer that turns a
// panel into a request body is, and it is now its own module.
//
// The assertion that pays for the split is the last one here: every key the
// page can send has to be one `isAllowedSettingKey` accepts on the server. The
// whitelist and the sender are edited in different files by different changes,
// and when they disagree the panel does not fail loudly — the POST comes back
// 400 with "Disallowed setting key(s)" and that section silently stops saving.
//
// Which sections exist is read out of the panels' own markup rather than listed
// here, so a panel added with a new saveSettings('...') section is covered by
// this suite the day it lands.

process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const fs = require('fs');
const path = require('path');

// The settings router is required for one pure function — its key whitelist —
// and its auth middleware installs a real cleanup interval on require, which
// jsdom's timers cannot unref.
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (_req, _res, next) => next(),
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));

const { bootPage, clickTab, settle, renderPanel, forgetDocumentListeners } = require('./helpers/guildSettingsPage');
const { buildSettingsPayload } = require('../src/dashboard/public/settings-payload');
const { isAllowedSettingKey } = require('../src/dashboard/routes/api/settings');

const PANELS = path.join(__dirname, '..', 'src', 'dashboard', 'views', 'partials', 'panels');

// The same marker guild-settings.js uses to find its own save buttons. It was
// an `onclick="saveSettings('x')"` to parse out of; since #887 the section is
// an attribute of its own, so this reads it rather than extracting it.
const SAVE_SECTION = /data-action="save"\s+data-section="([^"]+)"/g;

/** panel id -> the saveSettings() sections its markup can trigger. */
function sectionsByPanel() {
    const map = new Map();
    for (const file of fs.readdirSync(PANELS).filter(f => f.endsWith('.ejs'))) {
        const id = path.basename(file, '.ejs');
        const sections = [...new Set([...renderPanel(id).matchAll(SAVE_SECTION)].map(m => m[1]))];
        if (sections.length) map.set(id, sections.sort());
    }
    return map;
}

const PANEL_SECTIONS = sectionsByPanel();
const CASES = [...PANEL_SECTIONS].flatMap(([panel, sections]) => sections.map(section => [panel, section]));

/** Boots the page, opens `panel`, and returns the body `section` would POST. */
async function payloadFor(panel, section, ctx) {
    bootPage();
    clickTab(panel);
    await settle();
    return buildSettingsPayload(section, ctx);
}

let errors;

beforeEach(() => {
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '';
});

afterEach(async () => {
    await settle();
    forgetDocumentListeners();
    errors.mockRestore();
    jest.restoreAllMocks();
});

describe('the panels this covers', () => {
    it('finds a save section in the panel markup', () => {
        expect(CASES.length).toBeGreaterThan(10);
        // A spot check that the discovery is reading real sections and not, say,
        // matching the helper's own source.
        expect(CASES.map(([, section]) => section)).toEqual(expect.arrayContaining(['welcome', 'moderation', 'ai']));
    });
});

describe('every section sends keys the settings endpoint accepts', () => {
    it.each(CASES)('%s panel → saveSettings(%p)', async (panel, section) => {
        const payload = await payloadFor(panel, section);

        // A section that reached no branch would pass the whitelist trivially by
        // sending nothing, which is the one way this could be vacuous.
        expect([section, Object.keys(payload).length > 0]).toEqual([section, true]);

        const rejected = Object.keys(payload).filter(key => !isAllowedSettingKey(key));
        expect([section, rejected]).toEqual([section, []]);
    });
});

describe('an unknown section', () => {
    it('sends nothing rather than throwing', () => {
        expect(buildSettingsPayload('not-a-section')).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// The serialization itself: what the form's controls become in the body.
// ---------------------------------------------------------------------------

describe('welcome', () => {
    it('sends what the fields say', async () => {
        bootPage();
        clickTab('welcome');
        await settle();
        document.getElementById('welcome-enabled').checked = true;
        document.getElementById('welcome-message').value = 'hi {user}';
        document.getElementById('welcome-dm-enabled').checked = false;

        const payload = buildSettingsPayload('welcome');

        expect(payload['welcome.enabled']).toBe(true);
        expect(payload['welcome.message']).toBe('hi {user}');
        expect(payload['welcome.dmEnabled']).toBe(false);
    });
});

describe('birthdays', () => {
    it('falls back to 09:00 UTC rather than sending a NaN hour', async () => {
        // The schema refuses a NaN, so an empty or half-typed hour field would
        // otherwise turn a save into a mongoose validation error.
        bootPage();
        clickTab('birthdays');
        await settle();
        document.getElementById('birthday-hour').value = '';

        expect(buildSettingsPayload('birthdays')['birthdays.wishingHourUtc']).toBe(9);
    });

    it('sends null, not an empty string, for an unset channel and role', async () => {
        bootPage();
        clickTab('birthdays');
        await settle();
        document.getElementById('birthday-channel').value = '';
        document.getElementById('birthday-role').value = '';

        const payload = buildSettingsPayload('birthdays');

        // '' and null both mean "unset" to the validator, but only null means it
        // to the schema's snowflake field.
        expect(payload['birthdays.channelId']).toBeNull();
        expect(payload['birthdays.roleId']).toBeNull();
    });
});

describe('moderation', () => {
    it('turns the newline-separated allowlists into arrays, dropping blank lines', async () => {
        bootPage();
        clickTab('moderation');
        await settle();
        document.getElementById('mod-link-allowlist').value = ' example.com \n\n  \nclawdia.dev\n';
        document.getElementById('mod-bad-words').value = 'one\n\ntwo\n';

        const payload = buildSettingsPayload('moderation');

        expect(payload['moderation.linkAllowlist']).toEqual(['example.com', 'clawdia.dev']);
        expect(payload['moderation.customBadWords']).toEqual(['one', 'two']);
    });

    it('falls back to the documented default for an unparseable threshold', async () => {
        bootPage();
        clickTab('moderation');
        await settle();
        document.getElementById('mod-spam-threshold').value = '';

        expect(buildSettingsPayload('moderation')['moderation.spamThreshold']).toBe(5);
    });

    it('takes the escalation ladder from the caller, not from the DOM', async () => {
        const ladder = [{ threshold: 3, action: 'mute', durationMinutes: 60 }];

        const payload = await payloadFor('moderation', 'moderation', {
            serializeEscalationLadder: () => ladder,
        });

        expect(payload['moderation.escalation.ladder']).toBe(ladder);
    });
});

describe('economy', () => {
    it('sends the shop, jobs and tier lists the panel holds outside the DOM', async () => {
        const storeItems = [{ itemId: 'apple', name: 'Apple', price: 10 }];
        const jobsList = [{ name: 'Barista' }];
        const jobTiersList = [{ name: 'Entry' }];

        const payload = await payloadFor('economy', 'economy', { storeItems, jobsList, jobTiersList });

        expect(payload.shop).toBe(storeItems);
        expect(payload.jobs).toBe(jobsList);
        expect(payload.jobTiers).toBe(jobTiersList);
    });

    it('sends empty lists when the caller passes none', async () => {
        const payload = await payloadFor('economy', 'economy');

        expect(payload.shop).toEqual([]);
    });
});

describe('achievements and command policies', () => {
    it('sends the arrays those panels keep in module state', async () => {
        const disabledAchievements = ['first_message'];
        const customAchievements = [{ id: 'custom-1', name: 'Custom' }];
        const cpRules = [{ command: 'ban', effect: 'deny' }];
        const cpCooldowns = [{ command: 'work', roleId: '1', cooldownSeconds: 30 }];

        const achievements = await payloadFor('achievements', 'achievements', { disabledAchievements, customAchievements });
        expect(achievements['achievements.disabledAchievements']).toBe(disabledAchievements);
        expect(achievements['achievements.customAchievements']).toBe(customAchievements);

        const policies = await payloadFor('commandpolicies', 'commandpolicies', { cpRules, cpCooldowns });
        expect(policies['commandPolicies.rules']).toBe(cpRules);
        expect(policies['commandPolicies.cooldownOverrides']).toBe(cpCooldowns);
    });
});

describe('ai', () => {
    it('omits the provider keys that were left blank', async () => {
        // The key inputs render empty for a guild that has one stored — sending
        // the empty value would erase it.
        const payload = await payloadFor('ai', 'ai');

        expect(payload).not.toHaveProperty('ai.openaiKey');
        expect(payload).not.toHaveProperty('ai.anthropicKey');
    });

    it('sends a key that was typed', async () => {
        bootPage();
        clickTab('ai');
        await settle();
        document.getElementById('ai-anthropic-key').value = 'sk-ant-typed';

        expect(buildSettingsPayload('ai')['ai.anthropicKey']).toBe('sk-ant-typed');
    });

    it('sends null for an empty context window rather than a NaN', async () => {
        bootPage();
        clickTab('ai');
        await settle();
        document.getElementById('ai-context-tokens').value = '   ';

        expect(buildSettingsPayload('ai')['ai.contextTokens']).toBeNull();
    });

    it('leaves the MCP fields out until the Connections tab has hydrated', async () => {
        // Those controls default to the first option, so sending them
        // unhydrated would put a guild with approvals on `writes` back to `off`
        // because somebody changed the temperature on the Chat tab.
        const unhydrated = await payloadFor('ai', 'ai');
        expect(unhydrated).not.toHaveProperty('ai.mcpConfirm');
        expect(unhydrated).not.toHaveProperty('ai.mcpRoute');

        const hydrated = await payloadFor('ai', 'ai', {
            mcpSettings: () => ({ confirm: 'writes', route: 'client' }),
        });
        expect(hydrated['ai.mcpConfirm']).toBe('writes');
        expect(hydrated['ai.mcpRoute']).toBe('client');
    });
});

describe('dailynews', () => {
    it('falls back to three items rather than sending a NaN ceiling', async () => {
        // parseInt('') is NaN, JSON.stringify turns that into null, and the
        // schema's `default: 3` does not apply to an explicit null — so an
        // empty field used to store a ceiling of null.
        bootPage();
        clickTab('rss');
        await settle();
        document.getElementById('dailynews-max-items').value = '';

        const payload = buildSettingsPayload('dailynews');

        expect(payload['dailyNews.maxItemsPerFeed']).toBe(3);
    });

    it('sends the ceiling that was typed', async () => {
        bootPage();
        clickTab('rss');
        await settle();
        document.getElementById('dailynews-max-items').value = '7';

        expect(buildSettingsPayload('dailynews')['dailyNews.maxItemsPerFeed']).toBe(7);
    });
});

describe('the over-length system prompt guard', () => {
    // The one piece of saveSettings('ai') that is not payload construction, and
    // the reason it stayed behind in the bundle. EJS renders a stored prompt
    // verbatim, so a value set through the API can exceed the textarea's
    // maxlength and reach here.
    it('refuses to POST a prompt over 4000 characters', async () => {
        bootPage();
        clickTab('ai');
        await settle();
        document.getElementById('ai-prompt').value = 'x'.repeat(4001);
        window.fetch.mockClear();

        await expect(window.saveSettings('ai')).resolves.toBeUndefined();

        expect(window.fetch.mock.calls.filter(([url]) => /\/settings$/.test(String(url)))).toEqual([]);
    });

    it('POSTs a prompt at the limit', async () => {
        bootPage();
        clickTab('ai');
        await settle();
        document.getElementById('ai-prompt').value = 'x'.repeat(4000);
        window.fetch.mockClear();

        await window.saveSettings('ai');

        const [, options] = window.fetch.mock.calls.find(([url]) => /\/settings$/.test(String(url)));
        expect(JSON.parse(options.body)['ai.systemPrompt']).toHaveLength(4000);
    });
});

describe('the bundle', () => {
    it('delegates its payload to the shared module at call time', async () => {
        // The split only holds if guild-settings.js keeps delegating; a section
        // built back inside it would be untested again. Asserted by standing in
        // for the module rather than by reading the bundle's source, so it is
        // the call that is pinned and not the formatting of the line making it.
        bootPage();
        clickTab('welcome');
        await settle();

        // Installed after bootPage, not before: booting re-evaluates
        // settings-payload.js, which would put the real function back.
        const real = window.buildSettingsPayload;
        const spy = jest.fn(() => ({ 'welcome.enabled': true }));
        window.buildSettingsPayload = spy;
        window.fetch.mockClear();
        try {
            await window.saveSettings('welcome');
        } finally {
            window.buildSettingsPayload = real;
        }

        expect(spy).toHaveBeenCalledTimes(1);
        const [section, ctx] = spy.mock.calls[0];
        expect(section).toBe('welcome');
        // Everything the panels hold outside the document still reaches it.
        expect(ctx).toEqual(expect.objectContaining({
            serializeEscalationLadder: expect.any(Function),
            storeItems: expect.any(Array),
            jobsList: expect.any(Array),
            jobTiersList: expect.any(Array),
            mcpSettings: expect.any(Function),
        }));

        // And what the module returned is what was POSTed, so this is the whole
        // path rather than a call whose result the bundle then discards.
        const [, options] = window.fetch.mock.calls.find(([url]) => /\/settings$/.test(String(url)));
        expect(JSON.parse(options.body)).toEqual({ 'welcome.enabled': true });
    });

    it('is served the module it calls', () => {
        const view = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'dashboard', 'views', 'guild-settings.ejs'), 'utf8'
        );
        expect(view).toContain("<script src=\"<%= asset('/settings-payload.js') %>\"></script>");
    });
});
