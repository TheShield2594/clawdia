'use strict';

/**
 * #870, the earning side of the freeze — and the one place it escapes the
 * command gate entirely.
 *
 * `trackQuestCommandUse` runs after *every* successful command: the read-only
 * economy views the gate exempts, and every command outside the economy
 * category too. A quest completing in there pays coins, so a frozen member
 * finishes "use 5 commands" on `/help` and is paid for it — the sanction the
 * dashboard reports as in force, not being in force, which is the whole of what
 * #870 is about.
 *
 * It is refused here rather than by putting the freeze guard in the credit's
 * filter, and that is a deliberate distinction: this path records a credit that
 * matched nothing as an *owed payout*, so a guarded filter would queue the
 * reward for an operator to pay out later rather than refusing it. A refusal
 * has to happen before the reward is computed.
 *
 * Driven directly rather than through the interaction handler, the way
 * tests/commandPermissionGate.test.js drives the permission check.
 */

const mockUser = {
    findOne: jest.fn(),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
};

jest.mock('../src/models/User', () => mockUser);
jest.mock('../src/utils/guildSettingsCache', () => ({
    getGuildSettings: jest.fn(async () => ({ quests: { enabled: true } })),
}));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn(async () => {}),
    onCommandUse: jest.fn(async () => ({ completed: [], nearComplete: [] })),
    notifyQuestComplete: jest.fn(async () => {}),
    notifyQuestNearComplete: jest.fn(async () => {}),
}));
jest.mock('../src/utils/balanceDelta', () => ({
    saveWithBalanceDelta: jest.fn(async () => ({ credited: true, balance: 0 })),
    detachBalanceDelta: jest.fn(),
    applyBalanceDelta: jest.fn(),
    commitBalanceDelta: jest.fn(),
}));

const { trackQuestCommandUse } = require('../src/events/interactionCreate');
const { ensureQuests, onCommandUse } = require('../src/services/questService');
const { saveWithBalanceDelta } = require('../src/utils/balanceDelta');

const interaction = {
    guild: { id: 'guild-1' },
    user: { id: 'player-1' },
    member: {},
    channel: {},
};

beforeEach(() => jest.clearAllMocks());

test('a frozen member accrues no quest progress and is paid nothing', async () => {
    mockUser.findOne.mockResolvedValue({ userId: 'player-1', guildId: 'guild-1', balance: 100, economyFrozen: true });

    await trackQuestCommandUse(interaction);

    // Progress is withheld along with the coins: a quest that ticks while
    // frozen just pays out the moment the freeze lifts.
    expect(ensureQuests).not.toHaveBeenCalled();
    expect(onCommandUse).not.toHaveBeenCalled();
    // And nothing is written, so there is no credit to be recorded as owed.
    expect(saveWithBalanceDelta).not.toHaveBeenCalled();
});

test('an unfrozen member is tracked and paid as before', async () => {
    mockUser.findOne.mockResolvedValue({ userId: 'player-1', guildId: 'guild-1', balance: 100 });

    await trackQuestCommandUse(interaction);

    expect(onCommandUse).toHaveBeenCalled();
    expect(saveWithBalanceDelta).toHaveBeenCalled();
});

test('a member with no document yet is tracked, not refused', async () => {
    // The row is created empty, so `economyFrozen` is absent rather than false
    // — the same case the `$ne: true` guard exists for everywhere else.
    mockUser.findOne.mockResolvedValue(null);
    mockUser.create.mockResolvedValue({ userId: 'player-1', guildId: 'guild-1', balance: 0 });

    await trackQuestCommandUse(interaction);

    expect(onCommandUse).toHaveBeenCalled();
});
