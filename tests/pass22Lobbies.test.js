'use strict';

/**
 * #873, pass 22 — the lobbies around the group and PvP payouts pass 1 and pass 7
 * audited: `/heist`'s lobby and skill checks, `/syndicate`'s membership and its
 * heist lobby, and `/duel`'s ranked season and rank view.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, paidPayouts: [], spentDebits: [], duelWins: 0, duelLosses: 0, lifetimeGambled: 0,
});
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });
const mockSyndicates = fakeCollection('Syndicate', { memberIds: [], pendingInvites: [], upgrades: [], heat: 0 }, { unique: ['syndicateId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/Syndicate', () => mockSyndicates.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/services/districtService', () => ({ isDistrictActive: jest.fn(() => false) }));
jest.mock('../src/services/seasonMissionService', () => ({ advanceMissions: jest.fn(async () => {}) }));

const heistCommand = require('../src/commands/economy/heist');
const heistService = require('../src/services/heistService');
const syndicate = require('../src/commands/economy/syndicate');
const syndicateService = require('../src/services/syndicateService');
const { claimSeat, releaseSeat, disbandIfAlone } = require('../src/services/syndicateMembership');
const duel = require('../src/commands/economy/duel');

// Numeric, as a snowflake is: a heist id is `<guildId>-<timestamp>` and the
// button route checks that shape.
const GUILD = '1001';
const ME = 'user-1';
const U2 = 'user-2';
const U3 = 'user-3';
const HOUR = 3_600_000;
const OLD = Date.now() - 365 * 24 * HOUR;

const seedGuild = (fields = {}) => mockGuilds.seed({ guildId: GUILD, economy: { enabled: true, currency: '💰' }, ...fields });
const seedUser = (userId, fields = {}) => mockUsers.seed({ userId, guildId: GUILD, ...fields });
const syn = id => mockSyndicates.all().find(d => d.syndicateId === id) ?? null;

/** A button press as the button route hands it to a handler. */
function press(customId, userId, extra = {}) {
    const replies = [];
    const record = p => { replies.push(p); return Promise.resolve(); };
    return {
        customId, guildId: GUILD, replies,
        user: { id: userId, username: userId },
        reply: jest.fn(record), update: jest.fn(record), deferUpdate: jest.fn(async () => {}),
        ...extra,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const c of [mockUsers, mockGuilds, mockSyndicates]) c.reset();
    heistService.clearHeist(GUILD);
    syndicateService.clearSyndicateHeist(GUILD);
});

afterEach(() => {
    heistService.clearHeist(GUILD);
    syndicateService.clearSyndicateHeist(GUILD);
    jest.useRealTimers();
    jest.restoreAllMocks();
});

// ── /heist ───────────────────────────────────────────────────────────────────

describe('/heist lobby', () => {
    const lobby = (initiatorId = ME) => heistService.createLobby({
        guildId: GUILD, channelId: 'c', initiatorId, target: 'bank', lobbyDurationSeconds: 60, maxPayout: 10_000,
    });

    test('a second lobby cannot replace the first, and a stale heist cannot clear the one that holds the slot', () => {
        const first = lobby();
        expect(lobby(U2)).toBeNull();
        expect(heistService.getHeist(GUILD)).toBe(first);

        const stale = { ...first, heistId: 'old', skillTimers: {} };
        heistService.clearHeist(GUILD, stale);
        expect(heistService.getHeist(GUILD)).toBe(first);
    });

    test('a /heist start whose reply fails gives the guild its slot back', async () => {
        seedGuild({ heist: { enabled: true } });
        seedUser(ME);
        const interaction = makeInteraction({ guildId: GUILD, subcommand: 'start', options: { target: 'bank' }, userId: ME });
        interaction.reply = jest.fn(async () => { throw new Error('Unknown interaction'); });

        await expect(heistCommand.execute(interaction, {})).rejects.toThrow('Unknown interaction');
        expect(heistService.getHeist(GUILD)).toBeNull();
    });

    test.each([
        ['frozen', { economyFrozen: true }, 'frozen'],
        ['jailed', { heistJailedUntil: new Date(Date.now() + HOUR) }, 'in jail'],
        ['on cooldown', { lastHeist: new Date(Date.now() - HOUR) }, 'cooldown'],
    ])('a %s member cannot join by button', async (_label, fields, says) => {
        seedGuild({ heist: { enabled: true, cooldownHours: 6 } });
        seedUser(U2, fields);
        const heist = lobby();

        const btn = press(`heist_join_${heist.heistId}_hacker`, U2);
        await heistService.handleHeistButton(btn, {});

        expect(JSON.stringify(btn.replies)).toMatch(new RegExp(says, 'i'));
        expect(heist.players.has(U2)).toBe(false);
    });

    test('a member in good standing joins', async () => {
        seedGuild({ heist: { enabled: true } });
        seedUser(U2);
        const heist = lobby();

        await heistService.handleHeistButton(press(`heist_join_${heist.heistId}_hacker`, U2), {});
        expect(heist.players.get(U2)).toMatchObject({ role: 'hacker' });
    });

    test('a skill check answers only to the player it was sent to', async () => {
        const heist = lobby();
        heistService.joinLobby(GUILD, U2, U2, 'hacker');
        heistService.endLobby(GUILD, heist);
        heist._skillChecks = { [U2]: { correct: '7' } };

        const btn = press(`heist_skill_${heist.heistId}_${U2}_7`, U3);
        await heistService.handleHeistButton(btn, {});

        expect(JSON.stringify(btn.replies)).toContain("This isn't your skill check.");
        expect(heist.players.get(U2).skillPassed).toBeNull();
    });

    test('closing the lobby puts the whole crew on the heist cooldown, not only the initiator', async () => {
        jest.useFakeTimers();
        seedGuild({ heist: { enabled: true } });
        seedUser(ME);
        seedUser(U2);
        const heist = lobby();
        heistService.joinLobby(GUILD, ME, ME, 'hacker');
        heistService.joinLobby(GUILD, U2, U2, 'lookout');

        const msg = { edit: jest.fn(async () => {}) };
        const client = { guilds: { fetch: jest.fn(async () => null) } };
        heistService.startLobbyCountdown(client, heist, msg, { minPlayers: 2, lobbyDurationSeconds: 60 });
        await jest.advanceTimersByTimeAsync(60_000);

        expect(mockUsers.get(U2).lastHeist).toBeInstanceOf(Date);
        expect(mockUsers.get(ME).lastHeist).toBeInstanceOf(Date);
    });
});

// ── /syndicate ───────────────────────────────────────────────────────────────

describe('/syndicate skill check', () => {
    // #1161: the heist version checked whose button it was and this one did
    // not. The buttons go out by DM, so nobody else sees them today — but that
    // is delivery, not a check.
    test('answers only to the player it was sent to', async () => {
        const heist = syndicateService.createSyndicateLobby({
            guildId: GUILD, channelId: 'c', syndicateId: 's1', leaderId: ME,
            target: Object.keys(syndicateService.SYNDICATE_TARGETS)[0], lobbyDurationSeconds: 60, currentHeat: 0,
        });
        syndicateService.joinSyndicateLobby(GUILD, U2, U2, Object.keys(syndicateService.SYNDICATE_ROLES)[0]);
        syndicateService.endSyndicateLobby(GUILD);
        heist._skillChecks = { [U2]: { correct: '7' } };

        const btn = press(`syn_skill_${heist.heistId}_${U2}_7`, U3);
        await syndicate.handleSyndicateButton(btn, {});

        expect(JSON.stringify(btn.replies)).toContain("This isn't your skill check.");
        expect(heist.players.get(U2).skillPassed).toBeNull();
    });
});

describe('/syndicate membership', () => {
    const seedSyndicate = (fields = {}) => {
        const doc = {
            _id: 'syn-doc', syndicateId: 'S1', guildId: GUILD, name: 'Crew', leaderId: ME,
            memberIds: [ME], pendingInvites: [], openToJoin: true, ...fields,
        };
        mockSyndicates.seed(doc);
        return doc;
    };

    test('two joins for the last seat seat one member, not two', async () => {
        const synDoc = seedSyndicate();
        seedUser(U2);
        seedUser(U3);

        const results = await Promise.all([
            claimSeat(synDoc, U2, GUILD, 2),
            claimSeat(synDoc, U3, GUILD, 2),
        ]);

        expect(results.filter(r => r.ok)).toHaveLength(1);
        expect(syn('S1').memberIds).toHaveLength(2);
    });

    test('a join that loses to the player founding another syndicate gives the seat back', async () => {
        const synDoc = seedSyndicate();
        seedUser(U2, { syndicateId: 'S-founded' });

        expect(await claimSeat(synDoc, U2, GUILD, 10)).toEqual({ ok: false, reason: 'elsewhere' });
        expect(syn('S1').memberIds).toEqual([ME]);
        expect(mockUsers.get(U2).syndicateId).toBe('S-founded');
    });

    test('an invite-only syndicate seats only the invited', async () => {
        const synDoc = seedSyndicate({ openToJoin: false, pendingInvites: [U2] });
        seedUser(U2);
        seedUser(U3);

        expect((await claimSeat(synDoc, U3, GUILD, 10)).ok).toBe(false);
        expect((await claimSeat(synDoc, U2, GUILD, 10)).ok).toBe(true);
        expect(syn('S1')).toMatchObject({ memberIds: [ME, U2], pendingInvites: [] });
    });

    test('leaving clears the pointer only while it still names this syndicate', async () => {
        seedSyndicate({ memberIds: [ME, U2] });
        seedUser(U2, { syndicateId: 'S-other' });

        await releaseSeat('S1', GUILD, U2);

        expect(syn('S1').memberIds).toEqual([ME]);
        expect(mockUsers.get(U2).syndicateId).toBe('S-other');
    });

    test('a leader cannot disband over a member who joined after the read', async () => {
        seedSyndicate({ memberIds: [ME, U2] });
        seedUser(ME, { syndicateId: 'S1' });

        expect(await disbandIfAlone('S1', GUILD, ME)).toBe(false);
        expect(syn('S1')).toBeTruthy();

        syn('S1').memberIds = [ME];
        expect(await disbandIfAlone('S1', GUILD, ME)).toBe(true);
        expect(mockUsers.get(ME).syndicateId).toBeNull();
    });

    test('/syndicate join refuses a full syndicate even when its roster was read with room', async () => {
        seedGuild({ syndicates: { enabled: true } });
        seedSyndicate({ memberIds: Array.from({ length: 9 }, (_, i) => `m${i}`) });
        seedUser(U2);
        // Another join lands between the command's read and its write.
        const realFind = mockSyndicates.model.findOne.getMockImplementation();
        mockSyndicates.model.findOne.mockImplementationOnce((...args) => {
            const read = realFind(...args);
            syn('S1').memberIds.push('late');
            return read;
        });

        const interaction = makeInteraction({ guildId: GUILD, subcommand: 'join', options: { name: 'Crew' }, userId: U2 });
        await syndicate.execute(interaction, {});

        expect(repliedText(interaction)).toContain('filled up');
        expect(syn('S1').memberIds).toHaveLength(10);
        expect(mockUsers.get(U2).syndicateId ?? null).toBeNull();
        mockSyndicates.model.findOne.mockImplementation(realFind);
    });

    test('the public kick reply pings only the member kicked, whatever the syndicate is called', async () => {
        seedGuild({ syndicates: { enabled: true } });
        seedSyndicate({ name: '@everyone', memberIds: [ME, U2] });
        seedUser(ME, { syndicateId: 'S1' });
        seedUser(U2, { syndicateId: 'S1' });

        const interaction = makeInteraction({ guildId: GUILD, subcommand: 'kick', options: { user: { id: U2, username: 'u2' } }, userId: ME });
        await syndicate.execute(interaction, {});

        expect(interaction.replies.at(-1).allowedMentions).toEqual({ users: [U2] });
        expect(mockUsers.get(U2).syndicateId).toBeNull();
    });
});

describe('/syndicate heist and sabotage', () => {
    test('sabotage takes its heat from the stored value, not from the already-decayed one', async () => {
        seedGuild({ syndicates: { enabled: true } });
        // 60 stored, three days of decay: 30 effective.
        mockSyndicates.seed({
            syndicateId: 'S1', guildId: GUILD, name: 'Crew', leaderId: ME, memberIds: [ME],
            heat: 60, lastHeistAt: new Date(Date.now() - 3 * 24 * HOUR - HOUR),
        });
        seedUser(ME, { syndicateId: 'S1' });
        const rival = syndicateService.createSyndicateLobby({
            guildId: GUILD, channelId: 'c', syndicateId: 'S2', leaderId: U2, target: 'bank_job', lobbyDurationSeconds: 60, currentHeat: 0,
        });
        syndicateService.endSyndicateLobby(GUILD);
        rival.sabotageCount = 0;

        await syndicate.execute(makeInteraction({ guildId: GUILD, subcommand: 'sabotage', userId: ME }), {});

        const stored = syn('S1');
        expect(stored.heat).toBe(40);
        expect(syndicateService.getEffectiveHeat(stored)).toBe(10);
    });

    test('a frozen member cannot join the heist lobby by button', async () => {
        seedUser(U2, { syndicateId: 'S1', economyFrozen: true });
        const heist = syndicateService.createSyndicateLobby({
            guildId: GUILD, channelId: 'c', syndicateId: 'S1', leaderId: ME, target: 'bank_job', lobbyDurationSeconds: 60, currentHeat: 0,
        });
        const role = Object.keys(syndicateService.SYNDICATE_ROLES)[0];

        const btn = press(`syn_join_${heist.heistId}_${role}`, U2);
        await syndicate.handleSyndicateButton(btn, {});

        expect(JSON.stringify(btn.replies)).toMatch(/frozen/i);
        expect(heist.players.has(U2)).toBe(false);
    });

    test('a heist lobby whose reply fails gives the guild its slot back', async () => {
        seedGuild({ syndicates: { enabled: true } });
        mockSyndicates.seed({ syndicateId: 'S1', guildId: GUILD, name: 'Crew', leaderId: ME, memberIds: [ME, U2, U3] });
        seedUser(ME, { syndicateId: 'S1' });
        const interaction = makeInteraction({ guildId: GUILD, subcommand: 'heist', options: { target: 'bank_job' }, userId: ME });
        interaction.reply = jest.fn(async () => { throw new Error('Unknown interaction'); });

        await expect(syndicate.execute(interaction, {})).rejects.toThrow('Unknown interaction');
        expect(syndicateService.getSyndicateHeist(GUILD)).toBeNull();
    });
});

// ── /duel ────────────────────────────────────────────────────────────────────

describe('/duel', () => {
    const rival = { id: U2, username: 'rival', bot: false, createdTimestamp: OLD, displayAvatarURL: () => 'x' };

    test('a ranked challenge is refused while an ended season waits for its rollover', async () => {
        seedGuild({ rankedDuels: { enabled: true, currentSeasonId: 'S1', seasonNumber: 1, seasonEndsAt: new Date(Date.now() - 60_000) } });
        seedUser(ME, { balance: 1_000 });
        seedUser(U2, { balance: 1_000 });

        const interaction = makeInteraction({ guildId: GUILD, subcommand: 'ranked', options: { user: rival, amount: 100 }, userId: ME });
        await duel.execute(interaction);

        expect(repliedText(interaction)).toContain('ranked duels reopen in a few minutes');
        expect(mockUsers.get(ME).balance).toBe(1_000);
    });

    test('a ranked duel that finishes just past the season end counts toward that season', async () => {
        seedGuild({ rankedDuels: { enabled: true, currentSeasonId: 'S1', seasonNumber: 1, seasonEndsAt: new Date(Date.now() - 60_000) } });
        seedUser(ME, { ranked: { elo: 1200, currentSeasonId: 'S1', seasonRankedWins: 9, seasonRankedLosses: 1, seasonPeakElo: 1200 } });
        seedUser(U2, { ranked: { elo: 1000, currentSeasonId: 'S1', seasonRankedWins: 2, seasonRankedLosses: 2, seasonPeakElo: 1010 } });

        await duel.__test__.finalizeDuel({
            interaction: makeInteraction({ guildId: GUILD, userId: ME }), targetUser: rival, challengerId: ME, opponentId: U2,
            amount: 100, currency: '💰', houseCut: 0.05, challengerWins: true, tie: false,
            game: 'coinflip', gameResult: 'flip', isRanked: true, duelId: 'd1',
        });

        // Still tagged with the season the rollover is about to score, so the
        // leader is in its top three.
        expect(mockUsers.get(ME).ranked).toMatchObject({ currentSeasonId: 'S1', seasonRankedWins: 10 });
        expect(mockUsers.get(U2).ranked).toMatchObject({ currentSeasonId: 'S1', seasonRankedLosses: 3 });
    });

    test('/duel rank places a player below 1000 among ladder players only', async () => {
        seedUser(ME, { ranked: { elo: 984, rankedWins: 0, rankedLosses: 1 } });
        seedUser(U2, { ranked: { elo: 1016, rankedWins: 1, rankedLosses: 0 } });
        for (let i = 0; i < 5; i++) seedUser(`bystander-${i}`, { ranked: { elo: 1000 } });

        const interaction = makeInteraction({ guildId: GUILD, subcommand: 'rank', userId: ME });
        await duel.execute(interaction);

        expect(JSON.stringify(interaction.replies)).toContain('#2');
        expect(JSON.stringify(interaction.replies)).not.toContain('#7');
    });

    test('a challenge to a frozen member is refused by name before it is posted', async () => {
        seedGuild();
        seedUser(ME, { balance: 1_000 });
        seedUser(U2, { balance: 1_000, economyFrozen: true });

        const interaction = makeInteraction({ guildId: GUILD, subcommand: 'casual', options: { user: rival, amount: 100 }, userId: ME });
        await duel.execute(interaction);

        expect(repliedText(interaction)).toMatch(/frozen/i);
        expect(interaction.replies).toHaveLength(1);
    });
});
