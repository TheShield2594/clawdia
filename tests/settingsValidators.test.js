'use strict';

// The settings endpoint is the dashboard's untrusted-input boundary: a guild
// admin's browser posting arbitrary JSON at the Guild document. The key
// whitelist and the eleven field validators are the only thing between that
// body and Mongoose, and none of them had a test — 14.1% lines, 8.3% branches
// (#787).
//
// They are pure functions from an update patch to an error string or null, so
// they are tested as such. The one thing that cannot be: that the route
// actually calls them, and refuses a `__proto__` key before any of them run.
// That gets a request.

const express = require('express');
const request = require('supertest');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1', username: 'admin' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
    logAuditEvent: jest.fn(async () => {}),
}));

const Guild = require('../src/models/Guild');
const { CONFIRM_MODES, MCP_ROUTES } = require('../src/config/mcpServers');

const settings = require('../src/dashboard/routes/api/settings');
const stubBotGateway = require('./helpers/stubBotGateway');
const {
    ALLOWED_SETTING_PARENTS,
    isAllowedSettingKey,
    validateWelcomeUpdate,
    validateFarewellUpdate,
    validateBirthdaysUpdate,
    validateEventLogUpdate,
    validateBibleVerseUpdate,
    validateSnowflakeOrNull,
    validateNewspaperUpdate,
    validateExplorationUpdate,
    validateDynamicPricingUpdate,
    validateAiUpdate,
    validateHeistUpdate,
} = settings;

const SNOWFLAKE = '111222333444555666';

// ---------------------------------------------------------------------------
// The key whitelist
// ---------------------------------------------------------------------------

describe('isAllowedSettingKey', () => {
    it('accepts a whitelisted parent, on its own and dotted', () => {
        expect(isAllowedSettingKey('welcome')).toBe(true);
        expect(isAllowedSettingKey('welcome.message')).toBe(true);
        expect(isAllowedSettingKey('ai.mcpServers.0.name')).toBe(true);
    });

    it('refuses the prototype-pollution keys', () => {
        // The whole reason the list is a whitelist rather than a blacklist: a
        // `__proto__` or `constructor` key reaching guildSettings.set() writes
        // onto the prototype chain, not onto the document.
        for (const key of ['__proto__', 'constructor', 'prototype', '__proto__.polluted', 'constructor.prototype.x']) {
            expect([key, isAllowedSettingKey(key)]).toEqual([key, false]);
        }
    });

    it('refuses a schema field the dashboard does not manage', () => {
        // Balances and case counters are the bot's to write, not a form's.
        expect(isAllowedSettingKey('guildId')).toBe(false);
        expect(isAllowedSettingKey('casinoJackpot.pool')).toBe(false);
    });

    it('refuses a non-string key', () => {
        // Object.keys() only ever yields strings, so this is the guard for a
        // future caller that passes something else rather than for a request.
        for (const key of [null, undefined, 42, {}, ['welcome']]) {
            expect(isAllowedSettingKey(key)).toBe(false);
        }
    });

    it('matches on the whole first segment, not a prefix of it', () => {
        expect(isAllowedSettingKey('welcomeMat')).toBe(false);
        expect(ALLOWED_SETTING_PARENTS.has('welcome')).toBe(true);
    });

    // #920: the check read the first segment and nothing else, then the caller
    // handed the *whole* dotted key to `guildSettings.set()`. So a pollution
    // segment behind an allowed parent cleared the allow-list and arrived at the
    // write intact. Mongoose's strict schema is what refused it in the end,
    // which made this a hole in a named security control rather than a live bug.
    it('refuses a pollution segment anywhere in the path, not just at the front', () => {
        for (const key of [
            'ai.__proto__.x',
            'ai.constructor.prototype.polluted',
            'welcome.message.__proto__',
            'economy.prototype.x',
        ]) {
            expect([key, isAllowedSettingKey(key)]).toEqual([key, false]);
        }
    });

    it('refuses a path with an empty segment', () => {
        for (const key of ['welcome.', '.welcome', 'welcome..message']) {
            expect([key, isAllowedSettingKey(key)]).toEqual([key, false]);
        }
    });

    it('still accepts the deep paths the settings page actually sends', () => {
        expect(isAllowedSettingKey('ai.mcpServers.0.confirmMode')).toBe(true);
        expect(isAllowedSettingKey('moderation.autoModEnabled')).toBe(true);
    });

    it('is exported as a copy, so a caller cannot widen the writable surface', () => {
        const mine = settings.ALLOWED_SETTING_PARENTS;
        mine.add('casinoJackpot');

        expect(settings.ALLOWED_SETTING_PARENTS.has('casinoJackpot')).toBe(false);
        expect(isAllowedSettingKey('casinoJackpot.pool')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The field validators
// ---------------------------------------------------------------------------

describe('validateWelcomeUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateWelcomeUpdate({
            'welcome.enabled': true,
            'welcome.channelId': SNOWFLAKE,
            'welcome.message': 'hi {user}',
            'welcome.cardEnabled': false,
            'welcome.dmEnabled': true,
            'welcome.dmMessage': 'welcome',
        })).toBeNull();
    });

    it('ignores keys belonging to another section', () => {
        expect(validateWelcomeUpdate({ 'farewell.message': 42 })).toBeNull();
    });

    it.each(['message', 'dmMessage'])('rejects a non-string welcome.%s', field => {
        expect(validateWelcomeUpdate({ [`welcome.${field}`]: 42 })).toBe(`welcome.${field} must be a string`);
    });

    it('rejects a message over the 4000-character ceiling', () => {
        expect(validateWelcomeUpdate({ 'welcome.message': 'x'.repeat(4001) }))
            .toBe('welcome.message exceeds 4000 characters');
        expect(validateWelcomeUpdate({ 'welcome.message': 'x'.repeat(4000) })).toBeNull();
    });

    it.each(['enabled', 'cardEnabled', 'dmEnabled'])('rejects a non-boolean welcome.%s', field => {
        expect(validateWelcomeUpdate({ [`welcome.${field}`]: 'yes' })).toBe(`welcome.${field} must be a boolean`);
    });

    it.each([
        ['not digits', 'not-a-snowflake'],
        ['too short', '12345'],
        ['too long', '1'.repeat(21)],
        ['a number, not a string', Number(SNOWFLAKE)],
    ])('rejects a channelId that is %s', (_label, value) => {
        expect(validateWelcomeUpdate({ 'welcome.channelId': value }))
            .toBe('welcome.channelId must be a valid Discord snowflake or null');
    });

    it.each([['null', null], ['empty', '']])('accepts %s as "no channel"', (_label, value) => {
        expect(validateWelcomeUpdate({ 'welcome.channelId': value })).toBeNull();
    });
});

describe('validateFarewellUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateFarewellUpdate({ 'farewell.enabled': true, 'farewell.channelId': SNOWFLAKE, 'farewell.message': 'bye' }))
            .toBeNull();
    });

    it('rejects a non-string message, an over-length one and a bad channel', () => {
        expect(validateFarewellUpdate({ 'farewell.message': 42 })).toBe('farewell.message must be a string');
        expect(validateFarewellUpdate({ 'farewell.message': 'x'.repeat(4001) })).toBe('farewell.message exceeds 4000 characters');
        expect(validateFarewellUpdate({ 'farewell.channelId': 'nope' }))
            .toBe('farewell.channelId must be a valid Discord snowflake or null');
    });

    it('rejects a non-boolean enabled', () => {
        expect(validateFarewellUpdate({ 'farewell.enabled': 1 })).toBe('farewell.enabled must be a boolean');
    });
});

describe('validateBirthdaysUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateBirthdaysUpdate({
            'birthdays.enabled': true,
            'birthdays.channelId': SNOWFLAKE,
            'birthdays.roleId': SNOWFLAKE,
            'birthdays.message': 'happy birthday {user}',
            'birthdays.wishingHourUtc': 9,
        })).toBeNull();
    });

    it('holds the message to a shorter ceiling than welcome does', () => {
        expect(validateBirthdaysUpdate({ 'birthdays.message': 'x'.repeat(2001) }))
            .toBe('birthdays.message exceeds 2000 characters');
        expect(validateBirthdaysUpdate({ 'birthdays.message': 42 })).toBe('birthdays.message must be a string');
    });

    it('rejects a malformed roleId as well as a malformed channelId', () => {
        expect(validateBirthdaysUpdate({ 'birthdays.roleId': 'nope' }))
            .toBe('birthdays.roleId must be a valid Discord snowflake or null');
        expect(validateBirthdaysUpdate({ 'birthdays.channelId': 'nope' }))
            .toBe('birthdays.channelId must be a valid Discord snowflake or null');
        expect(validateBirthdaysUpdate({ 'birthdays.roleId': null, 'birthdays.channelId': '' })).toBeNull();
    });

    it.each([
        ['a fraction', 9.5],
        ['below midnight', -1],
        ['past 23', 24],
        ['a string', '9'],
    ])('rejects a wishing hour that is %s', (_label, value) => {
        expect(validateBirthdaysUpdate({ 'birthdays.wishingHourUtc': value }))
            .toBe('birthdays.wishingHourUtc must be an integer between 0 and 23');
    });

    it.each([0, 23])('accepts hour %i, at the edge of the range', hour => {
        expect(validateBirthdaysUpdate({ 'birthdays.wishingHourUtc': hour })).toBeNull();
    });

    it('rejects a non-boolean enabled', () => {
        expect(validateBirthdaysUpdate({ 'birthdays.enabled': 'true' })).toBe('birthdays.enabled must be a boolean');
    });
});

describe('validateEventLogUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateEventLogUpdate({ 'eventLog.enabled': true, 'eventLog.channelId': SNOWFLAKE })).toBeNull();
    });

    // Every one of these switches a category of logging on or off. A string
    // "false" is truthy, so a non-boolean that got through would turn logging on
    // for a guild that asked for it off.
    it.each(['enabled', 'logMessageDelete', 'logMemberJoin', 'logVoiceMove', 'logThreadArchive', 'logBotAdd'])(
        'rejects a non-boolean eventLog.%s',
        field => {
            expect(validateEventLogUpdate({ [`eventLog.${field}`]: 'false' })).toBe(`eventLog.${field} must be a boolean`);
        }
    );

    it('rejects a malformed channelId and accepts the empty forms', () => {
        expect(validateEventLogUpdate({ 'eventLog.channelId': '123' }))
            .toBe('eventLog.channelId must be a valid Discord snowflake or null');
        expect(validateEventLogUpdate({ 'eventLog.channelId': null })).toBeNull();
    });

    it('leaves a field it has no rule for alone', () => {
        expect(validateEventLogUpdate({ 'eventLog.somethingNew': 'whatever' })).toBeNull();
    });
});

describe('validateBibleVerseUpdate', () => {
    const valid = {
        'bibleVerse.enabled': true,
        'bibleVerse.autoRespond': false,
        'bibleVerse.channelId': SNOWFLAKE,
        'bibleVerse.time': '08:00',
        'bibleVerse.timezone': 'America/New_York',
        'bibleVerse.translation': 'kjv',
    };

    it('accepts a well-formed update', () => {
        expect(validateBibleVerseUpdate(valid)).toBeNull();
    });

    it.each(['enabled', 'autoRespond'])('rejects a non-boolean bibleVerse.%s', field => {
        expect(validateBibleVerseUpdate({ [`bibleVerse.${field}`]: 'yes' })).toBe(`bibleVerse.${field} must be a boolean`);
    });

    it.each(['8am', '8:00pm', '0800', 25])('rejects %s as a time', value => {
        expect(validateBibleVerseUpdate({ 'bibleVerse.time': value }))
            .toBe('bibleVerse.time must be in HH:MM format (e.g. 08:00)');
    });

    it.each(['24:00', '08:60'])('rejects %s, which has the right shape but is not a time', value => {
        expect(validateBibleVerseUpdate({ 'bibleVerse.time': value }))
            .toBe('bibleVerse.time must be a valid 24-hour time (00:00–23:59)');
    });

    it('accepts the empty forms of time and timezone as "leave it alone"', () => {
        expect(validateBibleVerseUpdate({ 'bibleVerse.time': '', 'bibleVerse.timezone': null })).toBeNull();
    });

    it('rejects a timezone the runtime does not know', () => {
        expect(validateBibleVerseUpdate({ 'bibleVerse.timezone': 'Mars/Olympus_Mons' }))
            .toBe('bibleVerse.timezone "Mars/Olympus_Mons" is not a valid IANA timezone');
        expect(validateBibleVerseUpdate({ 'bibleVerse.timezone': 42 })).toBe('bibleVerse.timezone must be a string');
    });

    it('rejects a translation outside the supported set', () => {
        const error = validateBibleVerseUpdate({ 'bibleVerse.translation': 'esv' });
        expect(error).toMatch(/^bibleVerse\.translation must be one of: /);
        expect(error).toContain('kjv');
    });
});

describe('validateSnowflakeOrNull', () => {
    it.each([[null], [''], [undefined], [SNOWFLAKE], ['1'.repeat(17)], ['1'.repeat(20)]])(
        'accepts %p',
        value => expect(validateSnowflakeOrNull(value, 'x.id')).toBeNull()
    );

    it.each([['1'.repeat(16)], ['1'.repeat(21)], ['12a45678901234567'], [123], [{}]])(
        'rejects %p, naming the field it was given',
        value => expect(validateSnowflakeOrNull(value, 'x.id')).toBe('x.id must be a valid Discord snowflake or null')
    );
});

describe('validateNewspaperUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateNewspaperUpdate({ 'newspaper.channelId': SNOWFLAKE, 'newspaper.quoteChannelIds': [SNOWFLAKE] }))
            .toBeNull();
    });

    it('rejects a malformed channelId', () => {
        expect(validateNewspaperUpdate({ 'newspaper.channelId': 'nope' }))
            .toBe('newspaper.channelId must be a valid Discord snowflake or null');
    });

    it.each([
        ['not an array', SNOWFLAKE],
        ['longer than 100 entries', Array(101).fill(SNOWFLAKE)],
    ])('rejects quoteChannelIds that are %s', (_label, value) => {
        expect(validateNewspaperUpdate({ 'newspaper.quoteChannelIds': value }))
            .toBe('newspaper.quoteChannelIds must be an array of at most 100 channel ids');
    });

    it('rejects a bad id inside an otherwise fine array', () => {
        expect(validateNewspaperUpdate({ 'newspaper.quoteChannelIds': [SNOWFLAKE, 'nope'] }))
            .toBe('newspaper.quoteChannelIds entry must be a valid Discord snowflake or null');
    });
});

describe('validateExplorationUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateExplorationUpdate({
            'exploration.enabled': true,
            'exploration.announceSecrets': false,
            'exploration.dropRateMultiplier': 1.5,
            'exploration.rareEventBonus': 0.1,
            'exploration.disabledRegions': ['cave'],
        })).toBeNull();
    });

    it.each(['enabled', 'announceSecrets'])('rejects a non-boolean exploration.%s', field => {
        expect(validateExplorationUpdate({ [`exploration.${field}`]: 'on' }))
            .toBe(`exploration.${field} must be a boolean`);
    });

    it.each([0.05, 5.1, Infinity, NaN, '2'])('rejects a drop rate of %p', value => {
        expect(validateExplorationUpdate({ 'exploration.dropRateMultiplier': value }))
            .toBe('exploration.dropRateMultiplier must be a number between 0.1 and 5');
    });

    it.each([-0.01, 0.26, '0.1'])('rejects a rare-event bonus of %p', value => {
        expect(validateExplorationUpdate({ 'exploration.rareEventBonus': value }))
            .toBe('exploration.rareEventBonus must be a number between 0 and 0.25');
    });

    it.each([
        ['not an array', 'cave'],
        ['longer than 100 entries', Array(101).fill('cave')],
        ['holding a non-string', ['cave', 7]],
        ['holding an over-long id', ['x'.repeat(65)]],
    ])('rejects disabledRegions that are %s', (_label, value) => {
        expect(validateExplorationUpdate({ 'exploration.disabledRegions': value }))
            .toBe('exploration.disabledRegions must be an array of at most 100 region id strings');
    });
});

describe('validateDynamicPricingUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateDynamicPricingUpdate({
            'dynamicPricing.enabled': true,
            'dynamicPricing.volatility': 'medium',
            'dynamicPricing.priceBand': 0.5,
            'dynamicPricing.recalcMinutes': 60,
        })).toBeNull();
    });

    it('rejects a non-boolean enabled', () => {
        expect(validateDynamicPricingUpdate({ 'dynamicPricing.enabled': 'yes' }))
            .toBe('dynamicPricing.enabled must be a boolean');
    });

    it('rejects a volatility outside the three the pricing engine knows', () => {
        expect(validateDynamicPricingUpdate({ 'dynamicPricing.volatility': 'extreme' }))
            .toBe("dynamicPricing.volatility must be 'low', 'medium', or 'high'");
    });

    it.each([0.04, 0.91, '0.5', NaN])('rejects a price band of %p', value => {
        expect(validateDynamicPricingUpdate({ 'dynamicPricing.priceBand': value }))
            .toBe('dynamicPricing.priceBand must be a number between 0.05 and 0.9');
    });

    it.each([14, 1441, 60.5, '60'])('rejects a recalc interval of %p', value => {
        expect(validateDynamicPricingUpdate({ 'dynamicPricing.recalcMinutes': value }))
            .toBe('dynamicPricing.recalcMinutes must be an integer between 15 and 1440');
    });
});

describe('validateHeistUpdate', () => {
    it('accepts a valid announce channel and the empty forms', () => {
        expect(validateHeistUpdate({ 'heist.announceChannelId': SNOWFLAKE })).toBeNull();
        expect(validateHeistUpdate({ 'heist.announceChannelId': null })).toBeNull();
    });

    it('rejects a malformed announce channel', () => {
        expect(validateHeistUpdate({ 'heist.announceChannelId': 'nope' }))
            .toBe('heist.announceChannelId must be a valid Discord snowflake or null');
    });

    it('leaves the numeric heist fields to the schema', () => {
        expect(validateHeistUpdate({ 'heist.cooldownHours': 6 })).toBeNull();
    });
});

describe('validateAiUpdate', () => {
    it('accepts a well-formed update', () => {
        expect(validateAiUpdate({
            'ai.mcpConfirm': CONFIRM_MODES[0],
            'ai.mcpRoute': MCP_ROUTES[0],
            'ai.monthlyTokenLimit': 0,
            'ai.monthlyCostLimit': 12.5,
            'ai.contextTokens': 128000,
        })).toBeNull();
    });

    it('rejects a confirm mode and a route the enum does not know', () => {
        expect(validateAiUpdate({ 'ai.mcpConfirm': 'sometimes' }))
            .toBe(`ai.mcpConfirm must be one of: ${CONFIRM_MODES.join(', ')}`);
        expect(validateAiUpdate({ 'ai.mcpRoute': 'carrier-pigeon' }))
            .toBe(`ai.mcpRoute must be one of: ${MCP_ROUTES.join(', ')}`);
    });

    it.each(['monthlyTokenLimit', 'monthlyCostLimit'])('rejects a non-numeric ai.%s', field => {
        // Mongoose casts "lots" to NaN, and a NaN ceiling compares false
        // against every total — a limit that never refuses (#831).
        expect(validateAiUpdate({ [`ai.${field}`]: 'lots' }))
            .toBe(`ai.${field} must be a number of 0 or more (0 disables it)`);
        expect(validateAiUpdate({ [`ai.${field}`]: -1 }))
            .toBe(`ai.${field} must be a number of 0 or more (0 disables it)`);
        expect(validateAiUpdate({ [`ai.${field}`]: null })).toBeNull();
    });

    it.each([1023, 2_000_001, 4096.5, '8192'])('rejects a context window of %p', value => {
        expect(validateAiUpdate({ 'ai.contextTokens': value }))
            .toBe('ai.contextTokens must be an integer between 1024 and 2000000, or empty to derive it from the model');
    });

    it.each([null, ''])('treats %p as "derive the context window from the model"', value => {
        expect(validateAiUpdate({ 'ai.contextTokens': value })).toBeNull();
    });

    it('refuses an ollama base URL the request path would refuse', () => {
        // The form has to reject exactly what the provider rejects, or the
        // error arrives as a failed chat instead of a message on the field.
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 'file:///etc/passwd' })).toEqual(expect.any(String));
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': '' })).toBeNull();
    });

    // Every rule above also has to fire when the dashboard sends the whole `ai`
    // object rather than dotted keys, which is the shape the API accepts too.
    it('applies the same rules to a whole-object ai update', () => {
        expect(validateAiUpdate({ ai: { mcpConfirm: 'sometimes' } }))
            .toBe(`ai.mcpConfirm must be one of: ${CONFIRM_MODES.join(', ')}`);
        expect(validateAiUpdate({ ai: { mcpRoute: 'carrier-pigeon' } }))
            .toBe(`ai.mcpRoute must be one of: ${MCP_ROUTES.join(', ')}`);
        expect(validateAiUpdate({ ai: { monthlyCostLimit: 'lots' } }))
            .toBe('ai.monthlyCostLimit must be a number of 0 or more (0 disables it)');
        expect(validateAiUpdate({ ai: { contextTokens: 12.5 } })).toEqual(expect.any(String));
        expect(validateAiUpdate({ ai: { provider: 'anthropic', model: 'claude' } })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The route, which is what has to call all of the above
// ---------------------------------------------------------------------------

describe('POST /guild/:guildId/settings', () => {
    // The gateway facade lives out here so the reschedule hook is a mock the
    // assertions can read, rather than a fresh one built per request and thrown
    // away inside the middleware.
    const bot = stubBotGateway({ rescheduleBibleVerse: jest.fn(async () => null) });

    function makeApp() {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.bot = bot; next(); });
        app.use('/api/v1', settings);
        return app;
    }

    function makeDoc() {
        return { guildId: 'g1', shop: [], set: jest.fn(), save: jest.fn(async () => {}) };
    }

    let app;
    let doc;

    beforeEach(() => {
        jest.clearAllMocks();
        app = makeApp();
        doc = makeDoc();
        Guild.findOne.mockResolvedValue(doc);
    });

    const post = body => request(app).post('/api/v1/guild/g1/settings').send(body);

    it('refuses a body carrying __proto__, before anything is written', async () => {
        // Sent as raw JSON text rather than an object: assigning `__proto__`
        // onto a request body object sets its prototype instead of adding a
        // key, so the payload would never survive the trip. express.json()
        // parses it into an own key, which is what the whitelist has to catch.
        const res = await request(app)
            .post('/api/v1/guild/g1/settings')
            .set('Content-Type', 'application/json')
            .send('{"__proto__": {"polluted": true}}');

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Disallowed setting key(s)');
        expect(doc.set).not.toHaveBeenCalled();
        expect(doc.save).not.toHaveBeenCalled();
        expect({}.polluted).toBeUndefined();
    });

    it('names every disallowed key it refused', async () => {
        const res = await post({ 'welcome.enabled': true, guildId: 'somebody-elses', constructor: {} });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('guildId');
        expect(res.body.error).toContain('constructor');
        expect(res.body.error).not.toContain('welcome.enabled');
    });

    it('refuses a body that is not a plain object', async () => {
        for (const body of [[{ 'welcome.enabled': true }], 'welcome']) {
            const res = await post(body);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Request body must be a plain object');
        }
    });

    it('surfaces a field validator’s message rather than a generic 400', async () => {
        const res = await post({ 'welcome.message': 'x'.repeat(4001) });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('welcome.message exceeds 4000 characters');
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('runs every section validator, not only the first', async () => {
        // One `if (error) return` per validator, in a fixed order — a validator
        // dropped from that chain is a rule that silently stops applying.
        const cases = [
            [{ 'farewell.enabled': 'yes' }, 'farewell.enabled must be a boolean'],
            [{ 'birthdays.wishingHourUtc': 99 }, 'birthdays.wishingHourUtc must be an integer between 0 and 23'],
            [{ 'bibleVerse.time': '8am' }, 'bibleVerse.time must be in HH:MM format (e.g. 08:00)'],
            [{ 'eventLog.enabled': 'yes' }, 'eventLog.enabled must be a boolean'],
            [{ 'newspaper.channelId': 'nope' }, 'newspaper.channelId must be a valid Discord snowflake or null'],
            [{ 'dynamicPricing.volatility': 'extreme' }, "dynamicPricing.volatility must be 'low', 'medium', or 'high'"],
            [{ 'heist.announceChannelId': 'nope' }, 'heist.announceChannelId must be a valid Discord snowflake or null'],
            [{ 'ai.mcpConfirm': 'sometimes' }, `ai.mcpConfirm must be one of: ${CONFIRM_MODES.join(', ')}`],
            [{ 'exploration.dropRateMultiplier': 99 }, 'exploration.dropRateMultiplier must be a number between 0.1 and 5'],
        ];

        for (const [body, expected] of cases) {
            const res = await post(body);
            expect([body, res.status, res.body.error]).toEqual([body, 400, expected]);
        }
    });

    it('saves a valid patch and reschedules the bible verse when its schedule moved', async () => {
        const res = await post({ 'bibleVerse.time': '08:00', 'welcome.enabled': true });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(doc.set).toHaveBeenCalledWith('welcome.enabled', true);
        expect(doc.save).toHaveBeenCalled();
        // The scheduler holds the old cron until it is told; without this the
        // verse keeps arriving at the time the guild just changed away from.
        expect(bot.rescheduleBibleVerse).toHaveBeenCalledWith('g1');
    });

    it('leaves the schedule alone when no bibleVerse key changed', async () => {
        const res = await post({ 'welcome.enabled': true });

        expect(res.status).toBe(200);
        expect(bot.rescheduleBibleVerse).not.toHaveBeenCalled();
    });

    it('404s a guild with no settings document', async () => {
        Guild.findOne.mockResolvedValue(null);

        const res = await post({ 'welcome.enabled': true });

        expect(res.status).toBe(404);
    });
});
