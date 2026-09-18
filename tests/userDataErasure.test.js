'use strict';

// The registry's two promises that only a real database can check: that erasure
// actually removes what it says it removes and leaves what it says it leaves,
// and that running it a second time changes nothing. Plus the money invariant —
// coins a member is erased with leave a Transaction behind so the guild's supply
// stays reconcilable — which is meaningless against a stubbed model and exact
// against a server.

const { useMongo } = require('./helpers/mongo');
const {
    exportUserData,
    deleteUserData,
    pseudonymize,
    ERASURE_TX_TYPE,
} = require('../src/utils/userDataRegistry');

const User = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const Conversation = require('../src/models/Conversation');
const Reminder = require('../src/models/Reminder');
const Case = require('../src/models/Case');
const TempBan = require('../src/models/TempBan');
const Syndicate = require('../src/models/Syndicate');

useMongo();

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';
const USER = '111111111111111111';
const OTHER_USER = '222222222222222222';

async function seed() {
    await User.create({ userId: USER, guildId: GUILD, balance: 400, bank: 600 });
    await User.create({ userId: USER, guildId: OTHER_GUILD, balance: 5, bank: 0 });
    await User.create({ userId: OTHER_USER, guildId: GUILD, balance: 10, bank: 0 });

    await Conversation.create({ userId: USER, guildId: GUILD, channelId: 'c1', messages: [] });
    await Reminder.create({ userId: USER, guildId: GUILD, channelId: 'c1', message: 'x', remindAt: new Date() });
    await Transaction.create({ userId: USER, guildId: GUILD, type: 'daily', amount: 50, balance: 400 });

    await Case.create({
        caseId: 1, guildId: GUILD, targetUserId: USER, moderatorId: OTHER_USER,
        type: 'warn', reason: 'test',
    });
    await TempBan.create({
        guildId: GUILD, userId: USER, moderatorId: OTHER_USER, expiresAt: new Date(Date.now() + 1e6),
    });
    await Syndicate.create({
        syndicateId: 's1', guildId: GUILD, name: 'Crew', nameLower: 'crew',
        leaderId: OTHER_USER, memberIds: [OTHER_USER, USER],
    });
}

describe('exportUserData', () => {
    beforeEach(seed);

    test('collects the member\'s records in this guild only', async () => {
        const dump = await exportUserData(USER, GUILD);

        expect(dump.userId).toBe(USER);
        expect(dump.collections.profile.records).toHaveLength(1);
        expect(dump.collections.profile.records[0].guildId).toBe(GUILD);
        expect(dump.collections.conversations.records).toHaveLength(1);
        expect(dump.collections.transactions.records).toHaveLength(1);
        expect(dump.collections.cases.records).toHaveLength(1);
    });

    test('marks the collections erasure keeps', async () => {
        const dump = await exportUserData(USER, GUILD);
        expect(dump.collections.profile.retained).toBe(false);
        expect(dump.collections.cases.retained).toBe(true);
        expect(dump.collections.tempBans.retained).toBe(true);
        expect(dump.collections.tempBans.reason).toMatch(/ban evasion/i);
    });
});

describe('deleteUserData', () => {
    beforeEach(seed);

    test('deletes the member\'s own rows and leaves everyone else\'s', async () => {
        await deleteUserData(USER, GUILD);

        expect(await User.findOne({ userId: USER, guildId: GUILD })).toBeNull();
        expect(await Conversation.countDocuments({ userId: USER, guildId: GUILD })).toBe(0);
        expect(await Reminder.countDocuments({ userId: USER, guildId: GUILD })).toBe(0);

        // Another guild and another member are untouched.
        expect(await User.findOne({ userId: USER, guildId: OTHER_GUILD })).not.toBeNull();
        expect(await User.findOne({ userId: OTHER_USER, guildId: GUILD })).not.toBeNull();
    });

    test('retains active bans and pseudonymises moderation cases', async () => {
        await deleteUserData(USER, GUILD);

        // The ban survives intact — deleting it would be ban evasion.
        expect(await TempBan.countDocuments({ userId: USER, guildId: GUILD })).toBe(1);

        // The case survives, but the member's identity in it is scrubbed.
        const kase = await Case.findOne({ caseId: 1, guildId: GUILD }).lean();
        expect(kase).not.toBeNull();
        expect(kase.targetUserId).toBe(pseudonymize(USER));
        expect(kase.targetUserId).not.toBe(USER);
    });

    test('removes the member from a syndicate roster', async () => {
        await deleteUserData(USER, GUILD);
        const crew = await Syndicate.findOne({ syndicateId: 's1' }).lean();
        expect(crew.memberIds).not.toContain(USER);
        expect(crew.memberIds).toContain(OTHER_USER);
    });

    test('records the removed coins as a data-erasure transaction under a pseudonym', async () => {
        const { coinsRemoved } = await deleteUserData(USER, GUILD);
        expect(coinsRemoved).toBe(1000);

        // The member's own ledger is gone…
        expect(await Transaction.countDocuments({ userId: USER, guildId: GUILD })).toBe(0);
        // …but the accountability record remains, keyed to the pseudonym so it
        // survives both the ledger wipe and any re-run.
        const record = await Transaction.findOne({ type: ERASURE_TX_TYPE, guildId: GUILD }).lean();
        expect(record).not.toBeNull();
        expect(record.amount).toBe(-1000);
        expect(record.userId).toBe(pseudonymize(USER));
    });

    test('is idempotent: a second run changes nothing and writes no new record', async () => {
        await deleteUserData(USER, GUILD);
        const afterFirst = await Transaction.countDocuments({ type: ERASURE_TX_TYPE, guildId: GUILD });

        const second = await deleteUserData(USER, GUILD);
        expect(second.coinsRemoved).toBe(0);
        for (const result of second.results) {
            expect(result.changed).toBe(0);
        }
        const afterSecond = await Transaction.countDocuments({ type: ERASURE_TX_TYPE, guildId: GUILD });
        expect(afterSecond).toBe(afterFirst);
    });

    test('a member with no profile erases cleanly and writes no coin record', async () => {
        const stranger = '999999999999999999';
        const { coinsRemoved } = await deleteUserData(stranger, GUILD);
        expect(coinsRemoved).toBe(0);
        expect(await Transaction.countDocuments({ userId: pseudonymize(stranger) })).toBe(0);
    });
});
