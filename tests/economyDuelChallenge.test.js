'use strict';

/**
 * #890. `/duel` sat at 10.1% statement coverage — a command that takes coins off
 * two players, holds them, and pays them to one. tests/duelEscrowSettlement
 * drives the escrow and the settlement directly (#873); nothing drove the
 * challenge around them, which is where the decision to take the escrow at all
 * is made and where every path that must *not* take it lives.
 *
 * That gap matters because the two are only correct together. `takeEscrow` being
 * safe says nothing about a decline that reaches it anyway, or an accept that
 * takes both stakes and then leaves the cooldown claimed after the escrow
 * failed. Those are properties of the flow, and #868's shape — a failure between
 * two writes, with nothing putting the first one back — is exactly what this
 * covers: the paired cooldown claim rolls its first half back, and a failed
 * escrow rolls the claim back.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { useFixedClock, DEFAULT_CLOCK } = require('./helpers/fixedClock');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { expectNonNegativeBalance } = require('./helpers/balanceInvariant');

const mockUsers = fakeCollection('User', {
    balance: 0, bank: 0, lastDuel: null, duelWins: 0, duelLosses: 0,
    lifetimeGambled: 0, paidPayouts: [],
});
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () => require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
// Sync, not async: `finalizeDuel` reads the return value without awaiting it,
// so an async stub hands it a Promise — always truthy — and every duel quietly
// pays the arena district's +15% bonus.
jest.mock('../src/services/districtService', () => ({ isDistrictActive: jest.fn(() => false) }));
jest.mock('../src/services/seasonMissionService', () => ({ advanceMissions: jest.fn(async () => {}) }));

const duel = require('../src/commands/economy/duel');
const { claimDuelCooldown, revertDuelCooldown } = duel.__test__;

const GUILD_ID = 'guild-1';
const CHALLENGER_ID = 'user-1';   // the harness's own user
const OPPONENT_ID = 'rival-1';

const opponentUser = (overrides = {}) => ({
    id: OPPONENT_ID, username: 'rival', bot: false, ...overrides,
});

const seedPlayer = (userId, fields = {}) =>
    mockUsers.seed({ userId, guildId: GUILD_ID, ...fields });

const wallet = userId => mockUsers.get(userId)?.balance;

/** The collector delivers its queued press a tick after execute() returns. */
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

const run = async ({ subcommand = 'casual', options = {}, components = [] } = {}) => {
    const interaction = makeInteraction({
        subcommand,
        options: { user: opponentUser(), amount: 100, game: 'coinflip', ...options },
        components,
        userId: CHALLENGER_ID,
    });
    await duel.execute(interaction);
    await settle();
    return interaction;
};

// The buttons carry a duelId of `${challengerId}_${Date.now()}`, so the press a
// test queues has to satisfy the command's own filter on an id the command has
// not rendered yet. Pinning the clock is what makes it knowable — and it is the
// clock the cooldown arithmetic reads too, so the fixtures below and the code
// under test agree on "now" whenever CI runs.
useFixedClock();
const NOW = new Date(DEFAULT_CLOCK).getTime();
const press = action => ({ customId: `duel_${action}_${CHALLENGER_ID}_${NOW}`, user: OPPONENT_ID });

const seedGuild = (economy = {}, rest = {}) => mockGuilds.seed({
    guildId: GUILD_ID, economy: { currency: '💰', enabled: true, ...economy }, ...rest,
});

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    jest.clearAllMocks();
    seedGuild();
});

describe('/duel casual — refusals before any coins move', () => {
    beforeEach(() => {
        seedPlayer(CHALLENGER_ID, { balance: 1000 });
        seedPlayer(OPPONENT_ID, { balance: 1000 });
    });

    it('refuses a duel with yourself', async () => {
        const interaction = await run({
            options: { user: opponentUser({ id: CHALLENGER_ID, username: 'player' }) },
        });

        expect(repliedText(interaction)).toContain("can't duel yourself");
        expect(wallet(CHALLENGER_ID)).toBe(1000);
    });

    it('refuses a duel with a bot', async () => {
        const interaction = await run({ options: { user: opponentUser({ bot: true }) } });

        expect(repliedText(interaction)).toContain("can't duel a bot");
        expect(wallet(OPPONENT_ID)).toBe(1000);
    });

    it('refuses a bet over the server maximum', async () => {
        mockGuilds.reset();
        seedGuild({ duelMaxBet: 500 });

        const interaction = await run({ options: { amount: 900 } });

        expect(repliedText(interaction)).toContain('maximum bet');
        expect(wallet(CHALLENGER_ID)).toBe(1000);
    });

    it('refuses a challenger who cannot cover the bet', async () => {
        mockUsers.reset();
        seedPlayer(CHALLENGER_ID, { balance: 50 });
        seedPlayer(OPPONENT_ID, { balance: 1000 });

        const interaction = await run({ options: { amount: 500 } });

        expect(repliedText(interaction)).toContain("don't have enough");
        expect(wallet(CHALLENGER_ID)).toBe(50);
    });

    it('refuses while the challenger is on cooldown', async () => {
        mockUsers.reset();
        seedPlayer(CHALLENGER_ID, { balance: 1000, lastDuel: new Date() });
        seedPlayer(OPPONENT_ID, { balance: 1000 });

        const interaction = await run();

        expect(repliedText(interaction)).toContain('cooling down');
    });

    it('refuses while the opponent is on cooldown', async () => {
        mockUsers.reset();
        seedPlayer(CHALLENGER_ID, { balance: 1000 });
        seedPlayer(OPPONENT_ID, { balance: 1000, lastDuel: new Date() });

        const interaction = await run();

        expect(repliedText(interaction)).toContain('still on duel cooldown');
    });

    it('refuses when the economy is off', async () => {
        mockGuilds.reset();
        seedGuild({ enabled: false });

        const interaction = await run();

        expect(repliedText(interaction)).toContain('economy is disabled');
    });

    it('refuses when duels are off', async () => {
        mockGuilds.reset();
        seedGuild({ duelEnabled: false });

        const interaction = await run();

        expect(repliedText(interaction)).toContain('Duels are disabled');
    });

    it('refuses a ranked duel under the server minimum', async () => {
        mockGuilds.reset();
        seedGuild({}, { rankedDuels: { enabled: true, minBet: 500 } });

        const interaction = await run({ subcommand: 'ranked', options: { amount: 100 } });

        expect(repliedText(interaction)).toContain('minimum bet');
        expect(wallet(CHALLENGER_ID)).toBe(1000);
    });

    it('refuses a ranked duel when ranked is off', async () => {
        mockGuilds.reset();
        seedGuild({}, { rankedDuels: { enabled: false } });

        const interaction = await run({ subcommand: 'ranked' });

        expect(repliedText(interaction)).toContain('Ranked duels are disabled');
    });

    it('posts the challenge with an accept and a decline button', async () => {
        const interaction = await run();

        const ids = interaction.replies[0].components[0].components.map(c => c.data.custom_id);
        expect(ids.some(id => id.startsWith('duel_accept_'))).toBe(true);
        expect(ids.some(id => id.startsWith('duel_decline_'))).toBe(true);
        // Still nobody's coins.
        expect(wallet(CHALLENGER_ID)).toBe(1000);
        expect(wallet(OPPONENT_ID)).toBe(1000);
    });
});

describe('/duel casual — the challenge is answered', () => {
    beforeEach(() => {
        seedPlayer(CHALLENGER_ID, { balance: 1000 });
        seedPlayer(OPPONENT_ID, { balance: 1000 });
    });

    it('takes nothing when the opponent declines', async () => {
        const interaction = await run({ components: [press('decline')] });

        expect(repliedText(interaction)).toContain('Duel Declined');
        expect(wallet(CHALLENGER_ID)).toBe(1000);
        expect(wallet(OPPONENT_ID)).toBe(1000);
    });

    it('takes nothing when nobody presses anything', async () => {
        const interaction = await run();

        expect(repliedText(interaction)).toContain('Duel Expired');
        expect(wallet(CHALLENGER_ID)).toBe(1000);
        expect(wallet(OPPONENT_ID)).toBe(1000);
    });

    it('ignores a press from someone who is not the opponent', async () => {
        const interaction = await run({
            components: [{ ...press('accept'), user: 'bystander-1' }],
        });

        // The filter turned it away, so the challenge simply ran out of time.
        expect(repliedText(interaction)).toContain('Duel Expired');
        expect(wallet(CHALLENGER_ID)).toBe(1000);
        expect(wallet(OPPONENT_ID)).toBe(1000);
    });

    it('escrows both stakes and settles the pot on accept', async () => {
        const interaction = await run({ components: [press('accept')] });

        // A coinflip has one winner and a 5% house cut, so the two wallets hold
        // 2000 minus the cut between them however the flip landed — the coins
        // are neither minted nor destroyed, which is the invariant that matters.
        const total = wallet(CHALLENGER_ID) + wallet(OPPONENT_ID);
        expect(total).toBe(2000 - Math.floor(200 * 0.05));
        expect(repliedText(interaction)).toContain('Coin Flip');
        expectNonNegativeBalance([mockUsers.get(CHALLENGER_ID), mockUsers.get(OPPONENT_ID)]);
    });

    it('puts the challenger\'s stake back when the opponent cannot cover theirs', async () => {
        // The #868 shape: the first debit committed, the second was refused,
        // and nothing put the first one back.
        mockUsers.reset();
        seedPlayer(CHALLENGER_ID, { balance: 1000 });
        seedPlayer(OPPONENT_ID, { balance: 10 });

        const interaction = await run({ components: [press('accept')] });

        expect(repliedText(interaction)).toContain('Duel Cancelled');
        expect(wallet(CHALLENGER_ID)).toBe(1000);
        expect(wallet(OPPONENT_ID)).toBe(10);
    });

    it('releases the duel cooldown when the escrow fails', async () => {
        // Claimed at accept time and only reverted on the failure path. Left
        // claimed, both players sit out five minutes for a duel that never was.
        mockUsers.reset();
        seedPlayer(CHALLENGER_ID, { balance: 1000 });
        seedPlayer(OPPONENT_ID, { balance: 10 });

        await run({ components: [press('accept')] });

        expect(mockUsers.get(CHALLENGER_ID).lastDuel).toBeNull();
        expect(mockUsers.get(OPPONENT_ID).lastDuel).toBeNull();
    });
});

describe('the paired cooldown claim', () => {
    // Relative to the pinned clock, not to whenever this module was loaded.
    const past = new Date(NOW - 10 * 60_000);

    beforeEach(() => {
        seedPlayer(CHALLENGER_ID, { balance: 1000 });
        seedPlayer(OPPONENT_ID, { balance: 1000 });
    });

    it('claims both players when both are off cooldown', async () => {
        const before = new Date(Date.now() - 5 * 60_000);

        const claim = await claimDuelCooldown(CHALLENGER_ID, OPPONENT_ID, GUILD_ID, before);

        expect(claim.ok).toBe(true);
        expect(mockUsers.get(CHALLENGER_ID).lastDuel).toBeInstanceOf(Date);
        expect(mockUsers.get(OPPONENT_ID).lastDuel).toBeInstanceOf(Date);
    });

    it('rolls the challenger back when the opponent is still cooling down', async () => {
        // Two writes, and the whole reason this is not two `updateOne` calls: a
        // challenger marked as having duelled when no duel happened is five
        // minutes of nothing.
        mockUsers.reset();
        seedPlayer(CHALLENGER_ID, { balance: 1000, lastDuel: past });
        seedPlayer(OPPONENT_ID, { balance: 1000, lastDuel: new Date() });

        const claim = await claimDuelCooldown(
            CHALLENGER_ID, OPPONENT_ID, GUILD_ID, new Date(Date.now() - 5 * 60_000));

        expect(claim).toMatchObject({ ok: false, reason: 'opponent' });
        expect(mockUsers.get(CHALLENGER_ID).lastDuel).toEqual(past);
    });

    it('claims nobody when the challenger is the one cooling down', async () => {
        mockUsers.reset();
        seedPlayer(CHALLENGER_ID, { balance: 1000, lastDuel: new Date() });
        seedPlayer(OPPONENT_ID, { balance: 1000, lastDuel: past });

        const claim = await claimDuelCooldown(
            CHALLENGER_ID, OPPONENT_ID, GUILD_ID, new Date(Date.now() - 5 * 60_000));

        expect(claim).toMatchObject({ ok: false, reason: 'challenger' });
        expect(mockUsers.get(OPPONENT_ID).lastDuel).toEqual(past);
    });

    it('puts both players back where they were', async () => {
        const claim = await claimDuelCooldown(
            CHALLENGER_ID, OPPONENT_ID, GUILD_ID, new Date(Date.now() - 5 * 60_000));
        await revertDuelCooldown(CHALLENGER_ID, OPPONENT_ID, GUILD_ID,
            claim.prevChallengerLastDuel, claim.prevOpponentLastDuel);

        expect(mockUsers.get(CHALLENGER_ID).lastDuel).toBeNull();
        expect(mockUsers.get(OPPONENT_ID).lastDuel).toBeNull();
    });
});
