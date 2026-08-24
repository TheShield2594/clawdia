'use strict';

/**
 * #631. Every Mongoose model in this suite was stubbed — 60 `jest.mock` calls,
 * and not one `mongoose` or `connect` anywhere under tests/ — so nothing
 * verified that the schemas validate what they say they validate, that the
 * unique indexes are unique, or that the aggregation-pipeline updates the
 * economy is built on compute what they are meant to.
 *
 * These run against a real mongod (see tests/helpers/mongo.js). They cover the
 * five models the issue named, which are the ones carrying money and moderation
 * state: User, Guild, Transaction, Case and TempBan.
 *
 * What belongs here rather than in a stubbed test: anything the *server*
 * decides. A stub can be told that a duplicate insert throws; only a server can
 * tell you whether the index that would throw exists. A stub can be told what
 * a pipeline update returns; only a server can evaluate the pipeline.
 */

const mongoose = require('mongoose');

const { useMongo, buildIndexes, indexesByName } = require('../helpers/mongo');

useMongo();

const User = require('../../src/models/User');
const Guild = require('../../src/models/Guild');
const Transaction = require('../../src/models/Transaction');
const Case = require('../../src/models/Case');
const TempBan = require('../../src/models/TempBan');

const { debitUpTo } = require('../../src/utils/balanceDebit');

const GUILD = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';

/** The duplicate-key error code, which is how a unique index refuses a write. */
const DUPLICATE_KEY = 11000;

// ── User ────────────────────────────────────────────────────────────────────

describe('User', () => {
    beforeEach(() => buildIndexes(User));

    test('is keyed on the member, not the account: one row per guild', async () => {
        await User.create({ userId: MEMBER, guildId: GUILD });
        await User.create({ userId: MEMBER, guildId: '999999999999999999' });

        expect(await User.countDocuments({ userId: MEMBER })).toBe(2);
    });

    // The index that makes the above true, and makes a second row in the same
    // guild impossible. Every economy write assumes one document per member per
    // guild; two would split a balance in half silently.
    test('refuses a second row for the same member in the same guild', async () => {
        await User.create({ userId: MEMBER, guildId: GUILD });

        await expect(User.create({ userId: MEMBER, guildId: GUILD }))
            .rejects.toMatchObject({ code: DUPLICATE_KEY });
    });

    test('starts a member at zero, not undefined', async () => {
        const user = await User.create({ userId: MEMBER, guildId: GUILD });

        expect(user.balance).toBe(0);
        expect(user.bank).toBe(0);
        expect(user.level).toBe(0);
        expect(user.xp).toBe(0);
    });

    test('requires both halves of the key', async () => {
        await expect(User.create({ userId: MEMBER })).rejects.toThrow(mongoose.Error.ValidationError);
        await expect(User.create({ guildId: GUILD })).rejects.toThrow(mongoose.Error.ValidationError);
    });

    // The two halves of what src/models/User.js says about `min: 0` — that it
    // catches a read-modify-save going negative and nothing else. Both are
    // server behaviour, and neither is observable through a stub.
    describe('the `min: 0` backstop on balance', () => {
        test('rejects a negative balance on save()', async () => {
            const user = await User.create({ userId: MEMBER, guildId: GUILD, balance: 100 });
            user.balance = -1;

            await expect(user.save()).rejects.toThrow(mongoose.Error.ValidationError);
        });

        // This is why the guarded debit and src/utils/balanceDebit.js exist at
        // all. If Mongoose validated bare updates, neither would be needed —
        // so a test that only asserted the happy half would be describing a
        // codebase this is not.
        test('does not run on a bare $inc, which is why the debit guards exist', async () => {
            await User.create({ userId: MEMBER, guildId: GUILD, balance: 10 });

            await User.updateOne({ userId: MEMBER, guildId: GUILD }, { $inc: { balance: -100 } });

            const after = await User.findOne({ userId: MEMBER, guildId: GUILD });
            expect(after.balance).toBe(-90);
        });
    });
});

// ── The money paths, evaluated by a server ──────────────────────────────────

describe('debiting a balance', () => {
    beforeEach(() => buildIndexes(User));

    // The guarded form used across the codebase: all-or-nothing, and the filter
    // is what makes it atomic. tests/balanceDebitGuard.test.js checks that call
    // sites are written this way; this checks that written this way, it works.
    describe('the guarded debit — `balance: { $gte: cost }`', () => {
        test('takes the cost when the member can afford it', async () => {
            await User.create({ userId: MEMBER, guildId: GUILD, balance: 500 });

            const updated = await User.findOneAndUpdate(
                { userId: MEMBER, guildId: GUILD, balance: { $gte: 200 } },
                { $inc: { balance: -200 } },
                { new: true },
            );

            expect(updated.balance).toBe(300);
        });

        test('matches nothing when they cannot, leaving the balance alone', async () => {
            await User.create({ userId: MEMBER, guildId: GUILD, balance: 50 });

            const updated = await User.findOneAndUpdate(
                { userId: MEMBER, guildId: GUILD, balance: { $gte: 200 } },
                { $inc: { balance: -200 } },
                { new: true },
            );

            expect(updated).toBeNull();
            expect((await User.findOne({ userId: MEMBER, guildId: GUILD })).balance).toBe(50);
        });
    });

    // debitUpTo does its clamp *inside* the update, as an aggregation pipeline,
    // so the balance the subtraction reads is the balance being written. A stub
    // returns whatever it was handed; only a server evaluates `$max`/`$subtract`.
    describe('debitUpTo — take up to N, never more than they have', () => {
        const filter = () => ({ userId: MEMBER, guildId: GUILD });

        test('takes the full amount when it is there', async () => {
            await User.create({ userId: MEMBER, guildId: GUILD, balance: 500 });

            const result = await debitUpTo(User, filter(), 200);

            expect(result).toEqual({ taken: 200, balance: 300, matched: true });
            expect((await User.findOne(filter())).balance).toBe(300);
        });

        // The whole point of the helper: a fine is not all-or-nothing, and an
        // unguarded `$inc` would run straight past zero into a negative balance.
        test('floors at zero rather than going negative', async () => {
            await User.create({ userId: MEMBER, guildId: GUILD, balance: 30 });

            const result = await debitUpTo(User, filter(), 200);

            expect(result).toEqual({ taken: 30, balance: 0, matched: true });
            expect((await User.findOne(filter())).balance).toBe(0);
        });

        test('takes nothing from an empty wallet', async () => {
            await User.create({ userId: MEMBER, guildId: GUILD, balance: 0 });

            expect(await debitUpTo(User, filter(), 200)).toEqual({ taken: 0, balance: 0, matched: true });
        });

        test('reports a miss rather than creating the member', async () => {
            const result = await debitUpTo(User, filter(), 200);

            expect(result).toEqual({ taken: 0, balance: 0, matched: false });
            expect(await User.countDocuments({})).toBe(0);
        });

        test('commits extra fields in the same update as the debit', async () => {
            await User.create({ userId: MEMBER, guildId: GUILD, balance: 100, messages: 4 });

            await debitUpTo(User, filter(), 25, { messages: { $add: [{ $ifNull: ['$messages', 0] }, 1] } });

            const after = await User.findOne(filter());
            expect([after.balance, after.messages]).toEqual([75, 5]);
        });
    });
});

// ── Guild ───────────────────────────────────────────────────────────────────

describe('Guild', () => {
    beforeEach(() => buildIndexes(Guild));

    test('refuses a second document for the same guild', async () => {
        await Guild.create({ guildId: GUILD, name: 'One' });

        await expect(Guild.create({ guildId: GUILD, name: 'Two' }))
            .rejects.toMatchObject({ code: DUPLICATE_KEY });
    });

    // #576. `createIndexes` is the only place a malformed partialFilterExpression
    // or an illegal parallel-array compound index is ever rejected — a schema
    // can declare either and nothing complains until a server is asked to build
    // it. That is exactly what this repo had no way to find out.
    describe('the indexes it declares (#576)', () => {
        test('all build against a real server', async () => {
            const built = await indexesByName(Guild);

            expect(Object.keys(built)).toEqual(expect.arrayContaining([
                '_id_',
                'guildId_1',
                'idx_guilds_giveaways',
                'idx_guilds_rssfeeds',
                'idx_guilds_tempvoice_active',
                'idx_guilds_dynamic_pricing',
                'idx_guilds_district_active',
            ]));
        });

        test('keep the partial filters the schema declares', async () => {
            const built = await indexesByName(Guild);

            expect(built.idx_guilds_tempvoice_active.partialFilterExpression)
                .toEqual({ 'tempVoice.enabled': true });
            expect(built.idx_guilds_dynamic_pricing.partialFilterExpression)
                .toEqual({ 'dynamicPricing.enabled': true });
            expect(built.idx_guilds_giveaways.sparse).toBe(true);
            expect(built.idx_guilds_rssfeeds.sparse).toBe(true);
        });
    });

    // Each of these is the filter a scheduled sweep issues, run against guilds
    // that should and should not match. An index that is present but wrong for
    // the query would pass the test above and fail these.
    describe('the sweeps the indexes exist for return the right guilds', () => {
        test('the giveaway sweep finds only guilds holding a giveaway', async () => {
            await Guild.create({
                guildId: GUILD, name: 'Has one',
                giveaways: [{
                    messageId: 'm1', channelId: 'c1', prize: 'A nice hat',
                    endsAt: new Date(Date.now() + 3_600_000), hostId: OTHER,
                }],
            });
            await Guild.create({ guildId: OTHER, name: 'Has none' });

            const found = await Guild.find({ 'giveaways.0': { $exists: true } });

            expect(found.map(g => g.guildId)).toEqual([GUILD]);
        });

        test('the temp voice sweep skips guilds with the feature off', async () => {
            await Guild.create({
                guildId: GUILD, name: 'On',
                tempVoice: { enabled: true, activeChannels: ['c1'] },
            });
            await Guild.create({
                guildId: OTHER, name: 'Off',
                tempVoice: { enabled: false, activeChannels: ['c2'] },
            });

            const found = await Guild.find({
                'tempVoice.enabled': true,
                'tempVoice.activeChannels.0': { $exists: true },
            });

            expect(found.map(g => g.guildId)).toEqual([GUILD]);
        });

        test('the temp voice sweep skips an enabled guild with no channels open', async () => {
            await Guild.create({ guildId: GUILD, name: 'On, idle', tempVoice: { enabled: true, activeChannels: [] } });

            const found = await Guild.find({
                'tempVoice.enabled': true,
                'tempVoice.activeChannels.0': { $exists: true },
            });

            expect(found).toEqual([]);
        });

        test('the dynamic pricing sweep finds only guilds with it enabled', async () => {
            await Guild.create({ guildId: GUILD, name: 'On', dynamicPricing: { enabled: true } });
            await Guild.create({ guildId: OTHER, name: 'Off', dynamicPricing: { enabled: false } });

            const found = await Guild.find({ 'dynamicPricing.enabled': true });

            expect(found.map(g => g.guildId)).toEqual([GUILD]);
        });

        test('the bank district payout matches on both fields of one element', async () => {
            const future = new Date(Date.now() + 3_600_000);
            const past = new Date(Date.now() - 3_600_000);

            await Guild.create({ guildId: GUILD, name: 'Active', districts: [{ districtId: 'bank', activeUntil: future }] });
            await Guild.create({ guildId: OTHER, name: 'Expired', districts: [{ districtId: 'bank', activeUntil: past }] });
            // The reason it is an $elemMatch: without one, a guild holding a
            // *different* district that is still active and an expired bank
            // would match on the two halves separately.
            await Guild.create({
                guildId: '444444444444444444', name: 'Split',
                districts: [
                    { districtId: 'bank', activeUntil: past },
                    { districtId: 'market', activeUntil: future },
                ],
            });

            const found = await Guild.find({
                districts: { $elemMatch: { districtId: 'bank', activeUntil: { $gt: new Date() } } },
            });

            expect(found.map(g => g.guildId)).toEqual([GUILD]);
        });
    });
});

// ── Transaction ─────────────────────────────────────────────────────────────

describe('Transaction', () => {
    beforeEach(() => buildIndexes(Transaction));

    const entry = over => ({
        userId: MEMBER, guildId: GUILD, type: 'daily', amount: 250, balance: 250, ...over,
    });

    test('records a credit with the balance it left behind', async () => {
        const tx = await Transaction.create(entry());

        expect([tx.amount, tx.balance, tx.bank]).toEqual([250, 250, null]);
    });

    test('takes a negative amount, which is how a debit is recorded', async () => {
        const tx = await Transaction.create(entry({ type: 'shop_buy', amount: -75, balance: 175 }));

        expect(tx.amount).toBe(-75);
    });

    test.each(['userId', 'guildId', 'type', 'amount', 'balance'])(
        'refuses an entry with no %s — an audit row with a hole is not an audit row',
        async field => {
            const incomplete = entry();
            delete incomplete[field];

            await expect(Transaction.create(incomplete)).rejects.toThrow(mongoose.Error.ValidationError);
        },
    );

    // The TTL is the only thing keeping this collection from growing without
    // bound, and it is a property of the built index rather than of the schema
    // object — a server is the only thing that can confirm it is there.
    test('expires entries after 90 days', async () => {
        const built = await indexesByName(Transaction);
        const ttl = Object.values(built).find(i => i.expireAfterSeconds !== undefined);

        expect(ttl.key).toEqual({ createdAt: 1 });
        expect(ttl.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
    });
});

// ── Case ────────────────────────────────────────────────────────────────────

describe('Case', () => {
    beforeEach(() => buildIndexes(Case));

    const openCase = over => ({
        caseId: 1, guildId: GUILD, targetUserId: MEMBER, moderatorId: OTHER,
        type: 'warn', reason: 'Spam', ...over,
    });

    test('opens a case with the status it defaults to', async () => {
        const c = await Case.create(openCase());

        expect([c.status, c.duration, c.resolvedAt]).toEqual(['open', null, null]);
    });

    test('numbers cases per guild, so two guilds can both have case 1', async () => {
        await Case.create(openCase({ caseId: 1, guildId: GUILD }));
        await Case.create(openCase({ caseId: 1, guildId: OTHER }));

        expect(await Case.countDocuments({ caseId: 1 })).toBe(2);
    });

    test('refuses a second case 1 in the same guild', async () => {
        await Case.create(openCase({ caseId: 1 }));

        await expect(Case.create(openCase({ caseId: 1 })))
            .rejects.toMatchObject({ code: DUPLICATE_KEY });
    });

    // Case id 0 is falsy, and a `if (!caseId)` somewhere upstream is how it
    // stops being a valid case. The model's own position on it is that it is an
    // ordinary number, which is what this pins.
    test('treats case 0 as an ordinary case id', async () => {
        await Case.create(openCase({ caseId: 0 }));

        const found = await Case.findOne({ guildId: GUILD, caseId: 0 });
        expect(found.caseId).toBe(0);
    });

    test.each(['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'note', 'appeal'])(
        'accepts the `%s` type the moderation commands write',
        async type => {
            const c = await Case.create(openCase({ type }));
            expect(c.type).toBe(type);
        },
    );

    test('refuses a type outside the enum', async () => {
        await expect(Case.create(openCase({ type: 'shadowban' })))
            .rejects.toThrow(mongoose.Error.ValidationError);
    });

    test('refuses a status outside the enum', async () => {
        await expect(Case.create(openCase({ status: 'pending' })))
            .rejects.toThrow(mongoose.Error.ValidationError);
    });

    test('requires a reason — a case nobody can read is not a record', async () => {
        const noReason = openCase();
        delete noReason.reason;

        await expect(Case.create(noReason)).rejects.toThrow(mongoose.Error.ValidationError);
    });

    test('appends moderator notes, stamping each one', async () => {
        const c = await Case.create(openCase());
        c.notes.push({ moderatorId: OTHER, content: 'Second offence' });
        await c.save();

        const found = await Case.findOne({ guildId: GUILD, caseId: 1 });
        expect(found.notes).toHaveLength(1);
        expect(found.notes[0].content).toBe('Second offence');
        expect(found.notes[0].createdAt).toBeInstanceOf(Date);
    });

    // The filter behind the SLA sweep and the dashboard's case list.
    test('finds the open cases past their SLA deadline, and only those', async () => {
        const overdue = new Date(Date.now() - 3_600_000);
        const later = new Date(Date.now() + 3_600_000);

        await Case.create(openCase({ caseId: 1, status: 'open', slaDeadline: overdue }));
        await Case.create(openCase({ caseId: 2, status: 'open', slaDeadline: later }));
        await Case.create(openCase({ caseId: 3, status: 'closed', slaDeadline: overdue }));

        const breached = await Case.find({ guildId: GUILD, status: 'open', slaDeadline: { $lte: new Date() } });

        expect(breached.map(c => c.caseId)).toEqual([1]);
    });
});

// ── TempBan ─────────────────────────────────────────────────────────────────

describe('TempBan', () => {
    beforeEach(() => buildIndexes(TempBan));

    const ban = over => ({
        guildId: GUILD, userId: MEMBER, moderatorId: OTHER,
        expiresAt: new Date(Date.now() + 86_400_000), ...over,
    });

    test('bans a member with a default reason', async () => {
        const t = await TempBan.create(ban());

        expect(t.reason).toBe('Temporary ban');
    });

    // Without an expiry a temp ban is a permanent one that nothing will ever
    // lift, because the sweep that lifts them is keyed on this field.
    test('requires an expiry', async () => {
        const noExpiry = ban();
        delete noExpiry.expiresAt;

        await expect(TempBan.create(noExpiry)).rejects.toThrow(mongoose.Error.ValidationError);
    });

    // Re-banning someone already temp-banned has to update the existing row,
    // not add a second one — two rows would mean the first sweep to run lifts
    // the ban while the second still thinks it is in force.
    test('refuses a second ban for the same member in the same guild', async () => {
        await TempBan.create(ban());

        await expect(TempBan.create(ban())).rejects.toMatchObject({ code: DUPLICATE_KEY });
    });

    test('upserting the same member extends the existing ban rather than adding one', async () => {
        const later = new Date(Date.now() + 7 * 86_400_000);
        await TempBan.create(ban());

        await TempBan.findOneAndUpdate(
            { guildId: GUILD, userId: MEMBER },
            { $set: { expiresAt: later } },
            { upsert: true },
        );

        const rows = await TempBan.find({ guildId: GUILD, userId: MEMBER });
        expect(rows).toHaveLength(1);
        expect(rows[0].expiresAt.getTime()).toBe(later.getTime());
    });

    test('the same member can be temp-banned in two guilds at once', async () => {
        await TempBan.create(ban({ guildId: GUILD }));
        await TempBan.create(ban({ guildId: OTHER }));

        expect(await TempBan.countDocuments({ userId: MEMBER })).toBe(2);
    });

    // The sweep that lifts them. It is not a TTL index: the bot has to call
    // Discord to unban, so the row has to still be there when it runs.
    test('finds the bans that are due, and only those', async () => {
        await TempBan.create(ban({ userId: MEMBER, expiresAt: new Date(Date.now() - 1_000) }));
        await TempBan.create(ban({ userId: OTHER, expiresAt: new Date(Date.now() + 86_400_000) }));

        const due = await TempBan.find({ expiresAt: { $lte: new Date() } });

        expect(due.map(b => b.userId)).toEqual([MEMBER]);
    });

    test('expiry is a deadline the database enforces nothing about', async () => {
        const built = await indexesByName(TempBan);
        const onExpiry = Object.values(built).find(i => JSON.stringify(i.key) === '{"expiresAt":1}');

        // A TTL here would delete the row before anything unbanned anyone.
        expect(onExpiry).toBeDefined();
        expect(onExpiry.expireAfterSeconds).toBeUndefined();
    });
});
