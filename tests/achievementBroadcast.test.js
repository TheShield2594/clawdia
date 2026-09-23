'use strict';

// The server-wide unlock broadcast used to read the same channel as the
// per-user reveal and then skip itself for being that channel, so it never
// posted. It now has its own `broadcastChannelId`. This drives
// announceAchievements with a fake client and pins: which tiers broadcast under
// each threshold, that a secret broadcast stays redacted (no badge art), that
// the two channels are independent, and that one channel never gets both.

jest.mock('../src/utils/delay', () => ({ delay: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/utils/cardGenerator', () => ({
    createAchievementCard: jest.fn(() => Promise.resolve(Buffer.from('card'))),
}));
jest.mock('../src/utils/achievementArt', () => ({
    getAchievementArt: jest.fn(() => Buffer.from('badge')),
}));

const { announceAchievements } = require('../src/services/achievementService');

const REVEAL = '100000000000000001';
const BROADCAST = '100000000000000002';

// Defs shaped like the built-ins; the tier comes from xpReward and `secret`.
const COMMON    = { id: 'chatty', name: 'Chatty', description: 'd', emoji: '🗣️', xpReward: 50 };
const RARE      = { id: 'millionaire', name: 'Millionaire', description: 'd', emoji: '🤑', xpReward: 500 };
const LEGENDARY = { id: 'level_100', name: 'Legend', description: 'd', emoji: '🏅', xpReward: 1500 };
const SECRET    = { id: 'unstoppable', name: 'Unstoppable', description: 'd', emoji: '⚡', xpReward: 2000, secret: true };

function fakeChannel() {
    const sent = [];
    return {
        sent,
        isTextBased: () => true,
        send: jest.fn(async (payload) => {
            sent.push(payload);
            return { edit: jest.fn(async (p) => { sent.push(p); }) };
        }),
    };
}

function setup({ reveal = REVEAL, broadcast = BROADCAST, threshold } = {}) {
    const channels = { [REVEAL]: fakeChannel(), [BROADCAST]: fakeChannel() };
    const client = {
        guilds: { cache: new Map([['g1', { channels: { cache: new Map(Object.entries(channels)) } }]]) },
    };
    const guildSettings = {
        guildId: 'g1',
        achievements: {
            announcementChannelId: reveal,
            broadcastChannelId: broadcast,
            ...(threshold ? { achievementAnnounceThreshold: threshold } : {}),
        },
    };
    return { client, guildSettings, reveal: channels[REVEAL], broadcast: channels[BROADCAST] };
}

const user = { userId: '42' };
const member = { displayName: 'Ada' };

async function announce(ctx, defs) {
    await announceAchievements(ctx.client, ctx.guildSettings, user, member, defs);
    await new Promise(setImmediate); // let the fire-and-forget broadcasts settle
}

const descriptions = (channel) => channel.sent.map(p => p.embeds[0].data.description || '');

describe('achievement unlock broadcast', () => {
    test('default threshold broadcasts rare, legendary and secret, not common', async () => {
        const ctx = setup();
        await announce(ctx, [COMMON, RARE, LEGENDARY, SECRET]);
        const posted = descriptions(ctx.broadcast);
        expect(posted).toHaveLength(3);
        expect(posted.some(d => d.includes('Millionaire'))).toBe(true);
        expect(posted.some(d => d.includes('LEGEND'))).toBe(true);
        expect(posted.some(d => d.includes('secret achievement'))).toBe(true);
        expect(posted.some(d => d.includes('Chatty'))).toBe(false);
    });

    test('legendary threshold drops rare; secret threshold keeps only secrets', async () => {
        const legendary = setup({ threshold: 'legendary' });
        await announce(legendary, [RARE, LEGENDARY, SECRET]);
        expect(legendary.broadcast.sent).toHaveLength(2);
        expect(descriptions(legendary.broadcast).some(d => d.includes('Millionaire'))).toBe(false);

        const secretOnly = setup({ threshold: 'secret' });
        await announce(secretOnly, [RARE, LEGENDARY, SECRET]);
        expect(secretOnly.broadcast.sent).toHaveLength(1);
        expect(descriptions(secretOnly.broadcast)[0]).toContain('secret achievement');
    });

    test('a secret broadcast is redacted and carries no badge art', async () => {
        const ctx = setup();
        await announce(ctx, [SECRET]);
        const [payload] = ctx.broadcast.sent;
        expect(payload.files).toEqual([]);
        expect(payload.embeds[0].data.thumbnail).toBeUndefined();
        expect(JSON.stringify(payload.embeds[0].data)).not.toContain('Unstoppable');
    });

    test('rare and legendary broadcasts carry the badge as a thumbnail', async () => {
        const ctx = setup();
        await announce(ctx, [RARE, LEGENDARY]);
        for (const payload of ctx.broadcast.sent) {
            expect(payload.files).toHaveLength(1);
            expect(payload.embeds[0].data.thumbnail.url).toBe('attachment://achievement-badge.png');
        }
    });

    test('no broadcast channel means no broadcast, and the reveal still runs', async () => {
        const ctx = setup({ broadcast: null });
        await announce(ctx, [LEGENDARY]);
        expect(ctx.broadcast.sent).toHaveLength(0);
        expect(ctx.reveal.sent.length).toBeGreaterThan(0);
    });

    test('the broadcast runs without a reveal channel', async () => {
        const ctx = setup({ reveal: null });
        await announce(ctx, [LEGENDARY]);
        expect(ctx.reveal.sent).toHaveLength(0);
        expect(ctx.broadcast.sent).toHaveLength(1);
    });

    test('a broadcast channel equal to the reveal channel does not post twice', async () => {
        const ctx = setup({ broadcast: REVEAL });
        await announce(ctx, [LEGENDARY]);
        // mystery beat + its edit, no third broadcast message
        expect(ctx.reveal.send).toHaveBeenCalledTimes(1);
    });
});
