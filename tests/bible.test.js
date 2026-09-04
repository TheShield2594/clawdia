'use strict';

jest.mock('discord.js', () => ({
    EmbedBuilder: jest.fn().mockImplementation(() => ({
        setColor: jest.fn().mockReturnThis(),
        setTitle: jest.fn().mockReturnThis(),
        setURL: jest.fn().mockReturnThis(),
        setThumbnail: jest.fn().mockReturnThis(),
        setDescription: jest.fn().mockReturnThis(),
        setFooter: jest.fn().mockReturnThis(),
        setTimestamp: jest.fn().mockReturnThis(),
    })),
    ActionRowBuilder: jest.fn().mockImplementation(() => ({
        addComponents: jest.fn().mockReturnThis(),
    })),
    ButtonBuilder: jest.fn().mockImplementation(() => ({
        setLabel: jest.fn().mockReturnThis(),
        setURL: jest.fn().mockReturnThis(),
        setStyle: jest.fn().mockReturnThis(),
        setEmoji: jest.fn().mockReturnThis(),
    })),
    ButtonStyle: { Link: 5 },
    PermissionFlagsBits: { SendMessages: 1n << 11n },
}));

jest.mock('node-cron', () => ({
    schedule: jest.fn(() => ({ stop: jest.fn() })),
}));
jest.mock('../src/models/Guild');

const cron = require('node-cron');
const { jsonResponse, textResponse } = require('./helpers/fetchResponse');
const Guild = require('../src/models/Guild');

// Both lookups are plain `fetch` calls to fixed public endpoints, so there is
// nothing to intercept below the client — the global is the seam. A fresh
// `Response` per call, because a body can only be read once and several tests
// here trigger two lookups.
let fetchMock;
beforeEach(() => { fetchMock = jest.spyOn(globalThis, 'fetch'); });
afterEach(() => fetchMock.mockRestore());

const {
    lookupVerse,
    getDailyVerse,
    createVerseEmbed,
    detectVerseReferences,
} = require('../src/services/bibleService');
const { startDailyBibleService, rescheduleBibleVerse } = require('../src/services/dailyBibleService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(hasPerm = true) {
    const perms = { has: jest.fn().mockReturnValue(hasPerm) };
    return {
        guild: {
            members: {
                me: { id: 'bot1' },
                fetchMe: jest.fn(),
            },
        },
        permissionsFor: jest.fn().mockReturnValue(perms),
        send: jest.fn().mockResolvedValue(undefined),
    };
}

function makeClient(channel) {
    return {
        channels: {
            cache: { get: jest.fn().mockReturnValue(channel) },
            fetch: jest.fn().mockResolvedValue(channel),
        },
    };
}

// ---------------------------------------------------------------------------
// bibleService — detectVerseReferences
// ---------------------------------------------------------------------------

describe('detectVerseReferences', () => {
    test('detects a simple verse reference', () => {
        expect(detectVerseReferences('I love John 3:16!')).toEqual(['John 3:16']);
    });

    test('detects a verse range', () => {
        expect(detectVerseReferences('Read Psalms 23:1-6 today')).toEqual(['Psalms 23:1-6']);
    });

    test('detects multiple distinct references', () => {
        const refs = detectVerseReferences('John 3:16 and Romans 8:28 are great');
        expect(refs).toContain('John 3:16');
        expect(refs).toContain('Romans 8:28');
        expect(refs).toHaveLength(2);
    });

    test('deduplicates the same reference', () => {
        const refs = detectVerseReferences('John 3:16 and again John 3:16');
        expect(refs).toHaveLength(1);
    });

    test('detects abbreviated book names', () => {
        const refs = detectVerseReferences('Gen 1:1 is the beginning');
        expect(refs).toHaveLength(1);
        expect(refs[0]).toMatch(/gen/i);
    });

    test('returns empty array when no verse reference present', () => {
        expect(detectVerseReferences('Hello, how are you?')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// bibleService — lookupVerse
// ---------------------------------------------------------------------------

describe('lookupVerse', () => {
    afterEach(() => jest.clearAllMocks());

    test('returns verse data on success', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({ text: 'For God so loved…', reference: 'John 3:16', translation_name: 'KJV' }));
        const result = await lookupVerse('John 3:16');
        expect(result.text).toBe('For God so loved…');
        expect(result.reference).toBe('John 3:16');
    });

    test('returns null when API returns an error field', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({ error: 'not found' }));
        const result = await lookupVerse('Fake 1:1');
        expect(result).toBeNull();
    });

    test('returns null on network failure', async () => {
        fetchMock.mockRejectedValue(new Error('Network error'));
        const result = await lookupVerse('John 3:16');
        expect(result).toBeNull();
    });

    // axios threw for a 4xx and this was caught; `fetch` hands the error page
    // back as an ordinary response, so the status is checked explicitly (#932).
    test('returns null on an HTTP error rather than reading the error page', async () => {
        fetchMock.mockImplementation(async () => textResponse('Not Found', 404));
        expect(await lookupVerse('Fake 1:1')).toBeNull();
    });

    test('passes translation to API URL', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({ text: 'text', reference: 'John 3:16', translation_name: 'ASV' }));
        await lookupVerse('John 3:16', 'asv');
        expect(fetchMock.mock.calls[0][0]).toContain('translation=asv');
    });
});

// ---------------------------------------------------------------------------
// bibleService — getDailyVerse
// ---------------------------------------------------------------------------

describe('getDailyVerse', () => {
    afterEach(() => jest.clearAllMocks());

    test('returns verse on success', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({ verse: { details: { text: 'The Lord is my shepherd', reference: 'Psalms 23:1', version: 'KJV' } } }));
        const result = await getDailyVerse();
        expect(result.text).toBe('The Lord is my shepherd');
        expect(result.reference).toBe('Psalms 23:1');
    });

    test('returns null when response is malformed', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({}));
        expect(await getDailyVerse()).toBeNull();
    });

    test('returns null on network failure', async () => {
        fetchMock.mockRejectedValue(new Error('timeout'));
        expect(await getDailyVerse()).toBeNull();
    });

    test('returns null on an HTTP error', async () => {
        fetchMock.mockImplementation(async () => textResponse('Bad Gateway', 502));
        expect(await getDailyVerse()).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// bibleService — createVerseEmbed
// ---------------------------------------------------------------------------

describe('createVerseEmbed', () => {
    const { EmbedBuilder } = require('discord.js');

    beforeEach(() => EmbedBuilder.mockClear());

    test('truncates text longer than 4090 chars', () => {
        const longText = 'a'.repeat(5000);
        const instance = createVerseEmbed({ text: longText, reference: 'Test 1:1', translation_name: 'KJV' });
        const setDesc = instance.setDescription.mock.calls[0][0];
        expect(setDesc.length).toBeLessThanOrEqual(4096);
        expect(setDesc).toContain('…"*');
    });

    test('includes reference and translation in footer', () => {
        const instance = createVerseEmbed({ text: 'short', reference: 'John 3:16', translation_name: 'KJV' });
        const footer = instance.setFooter.mock.calls[0][0].text;
        expect(footer).toContain('John 3:16');
        expect(footer).toContain('KJV');
    });

    test('uses translation_id as fallback when translation_name missing', () => {
        const instance = createVerseEmbed({ text: 'short', reference: 'John 3:16', translation_id: 'asv' });
        const footer = instance.setFooter.mock.calls[0][0].text;
        expect(footer).toContain('ASV');
    });
});

// ---------------------------------------------------------------------------
// dailyBibleService — startDailyBibleService
// ---------------------------------------------------------------------------

describe('startDailyBibleService', () => {
    afterEach(() => jest.clearAllMocks());

    test('schedules a cron job for each enabled guild', async () => {
        Guild.find.mockResolvedValue([
            { guildId: 'g1', bibleVerse: { enabled: true, channelId: '111', time: '08:00', timezone: 'UTC', translation: 'kjv' } },
            { guildId: 'g2', bibleVerse: { enabled: true, channelId: '222', time: '09:00', timezone: 'America/New_York', translation: 'asv' } },
        ]);
        const client = {};
        await startDailyBibleService(client);
        expect(cron.schedule).toHaveBeenCalledTimes(2);
    });

    test('does not crash when Guild.find rejects', async () => {
        Guild.find.mockRejectedValue(new Error('DB down'));
        await expect(startDailyBibleService({})).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// dailyBibleService — postDailyVerse (permission guard)
// ---------------------------------------------------------------------------

describe('postDailyVerse — permission guard', () => {
    afterEach(() => jest.clearAllMocks());

    test('sends embed when bot has permission', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({ verse: { details: { text: 'The Lord is my shepherd', reference: 'Psalms 23:1', version: 'KJV' } } }));
        Guild.find.mockResolvedValue([
            { guildId: 'g1', bibleVerse: { enabled: true, channelId: '111', time: '08:00', timezone: 'UTC', translation: 'kjv' } },
        ]);

        const channel = makeChannel(true);
        const client = makeClient(channel);

        await startDailyBibleService(client);
        expect(cron.schedule).toHaveBeenCalledTimes(1);

        // Invoke the scheduled callback directly
        const callback = cron.schedule.mock.calls[0][1];
        await callback();
        expect(channel.send).toHaveBeenCalled();
    });

    test('skips send when bot lacks SendMessages permission', async () => {
        fetchMock.mockImplementation(async () => jsonResponse({ verse: { details: { text: 'verse text', reference: 'John 1:1', version: 'KJV' } } }));
        Guild.find.mockResolvedValue([
            { guildId: 'g1', bibleVerse: { enabled: true, channelId: '111', time: '08:00', timezone: 'UTC', translation: 'kjv' } },
        ]);

        const channel = makeChannel(false);
        const client = makeClient(channel);

        await startDailyBibleService(client);
        const callback = cron.schedule.mock.calls[0][1];
        await callback();
        expect(channel.send).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// dailyBibleService — rescheduleBibleVerse
// ---------------------------------------------------------------------------

describe('rescheduleBibleVerse', () => {
    afterEach(() => jest.clearAllMocks());

    test('reschedules job when guild exists with enabled bibleVerse', async () => {
        Guild.findOne = jest.fn().mockResolvedValue({
            guildId: 'g1',
            bibleVerse: { enabled: true, channelId: '111', time: '10:00', timezone: 'UTC', translation: 'kjv' },
        });
        const client = {};
        rescheduleBibleVerse(client, 'g1');
        // Allow the promise to resolve
        await new Promise(resolve => setImmediate(resolve));
        expect(cron.schedule).toHaveBeenCalledTimes(1);
    });

    test('does not schedule when guild bibleVerse is disabled', async () => {
        Guild.findOne = jest.fn().mockResolvedValue({
            guildId: 'g1',
            bibleVerse: { enabled: false, channelId: '111', time: '10:00', timezone: 'UTC', translation: 'kjv' },
        });
        rescheduleBibleVerse({}, 'g1');
        await new Promise(resolve => setImmediate(resolve));
        expect(cron.schedule).not.toHaveBeenCalled();
    });
});
