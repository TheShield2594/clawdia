'use strict';

// The one list of every collection that holds a member's data, and the one
// place that knows how to hand it back (`/mydata export`) or take it away
// (`/mydata delete`, `scripts/delete-user-data.js`, the dashboard button).
//
// A self-hosted operator in the EU or UK is the controller for everything the
// bot stores about a member, and has a month to answer an access or erasure
// request (#1013). That answer used to be a Mongo shell session across a dozen
// collections that nobody would run correctly twice; it is now the export and
// the delete below, and both walk *this* list — so a new collection is covered
// by both the moment it is registered here, and by neither until it is.
//
// The registration is not optional. tests/userDataRegistryDrift.test.js scans
// src/models for any schema with a top-level `userId` path and fails when one is
// not accounted for here (the same guard tests/envExampleDrift.test.js puts on
// `.env.example`): a model that stores member data cannot be added without a
// deliberate decision about what export and erasure do with it.
//
// ── The three behaviours ────────────────────────────────────────────────────
//
//   delete        the row is the member's; erasure removes it outright.
//   pseudonymise  the row is the server's and must survive, but the member's
//                 identity inside it is scrubbed. Moderation cases are the
//                 example the issue names: the case is the server's record, and
//                 the person in it is replaced by an opaque token rather than
//                 the case being dropped.
//   retain        the row is the server's and must survive intact, identity and
//                 all, because deleting or scrubbing it would break something
//                 the bot is obliged to keep doing — an active ban is the one
//                 that would otherwise become an erasure-shaped ban evasion.
//
// Every entry is exported regardless of its erasure behaviour: an access request
// is answered with everything keyed to the member, including the records erasure
// leaves in place, and the export says which those are.
//
// ── Idempotence ─────────────────────────────────────────────────────────────
//
// Every `remove` is written so that running it twice is a no-op: `deleteMany`
// and `$pull` match nothing on the second pass, and a pseudonymise filters on
// the field still holding the real id, which the first pass cleared. There are
// no multi-document transactions — this codebase removed them (#520) and the
// test harness runs a standalone mongod — so each collection stands on its own,
// and the accountability the money needs is a record written the moment the
// profile is claimed rather than a rollback around it (see deleteUserData).

const crypto = require('crypto');

const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Transaction = require('../models/Transaction');
const Reminder = require('../models/Reminder');
const GrindProfile = require('../models/GrindProfile');
const BigWin = require('../models/BigWin');
const AiQuest = require('../models/AiQuest');
const WeeklyChampion = require('../models/WeeklyChampion');
const AuditLog = require('../models/AuditLog');
const TempBan = require('../models/TempBan');
const Case = require('../models/Case');
const MarketListing = require('../models/MarketListing');
const Syndicate = require('../models/Syndicate');
const DmSession = require('../models/DmSession');
const FishingTournament = require('../models/FishingTournament');
const SeasonRecord = require('../models/SeasonRecord');

// The Transaction `type` the accountability record below carries. Kept next to
// the registry rather than inline so the ledger tooling and the tests name the
// same string.
const ERASURE_TX_TYPE = 'data_erasure';

// A member's id, replaced by something non-reversible and — because it is not a
// Discord snowflake — impossible to collide with a real member.
//
// It is an HMAC, not a bare hash, on purpose (#1013 review): a Discord id is a
// public, enumerable value, so a plain `sha256(userId)` can be reversed by
// hashing every member id an attacker already knows (CWE-760). Keying the hash
// with something the reader of the database does not have closes that — the
// token is one-way and no longer a dictionary away from the id it stands for.
//
// The key is randomised per process, not configured. Erasure never needs the
// token to mean anything after the fact — only to not be the id and not be
// guessable — so a key that lives for the life of the process is enough, and it
// means there is no extra secret to store or leak. Every call within a run
// shares this key, so a member's redacted rows still tie together.
const PSEUDONYM_KEY = crypto.randomBytes(32);
const REDACTED_PREFIX = 'erased:';
function pseudonymize(userId) {
    return REDACTED_PREFIX
        + crypto.createHmac('sha256', PSEUDONYM_KEY).update(String(userId)).digest('hex').slice(0, 16);
}

// Third-party identities in a shared record are replaced by this in an export —
// a plain marker rather than a pseudonym, because the person reading their own
// archive has no use for a stable token, only for not being handed someone
// else's id.
const REDACTED_THIRD_PARTY = '[redacted]';
const redactOther = (id, userId) => (!id || id === userId ? id : REDACTED_THIRD_PARTY);

// `lean()` everywhere: the export serialises to JSON and the counts only need
// numbers, so nothing here wants a hydrated Mongoose document.
const lean = query => query.lean();

/**
 * Every collection that holds member data, in a stable order. Each entry owns
 * its own read and its own erasure, because the shapes genuinely differ — a flat
 * row keyed by `userId`, a sub-document pulled out of an array, a case whose
 * identity is scrubbed in place — and a single generic filter would serve none
 * of them well.
 *
 * @typedef {object} RegistryEntry
 * @property {string} key      stable identifier, used as the export's field name
 * @property {string} label    human description, shown in the export and report
 * @property {import('mongoose').Model} model
 * @property {'delete'|'pseudonymize'|'retain'} behavior
 * @property {string} [reason] why a pseudonymise/retain keeps the row; required
 *                             for those two so the choice is never silent
 * @property {(userId: string, guildId: string) => Promise<object[]>} collect
 * @property {(userId: string, guildId: string) => Promise<number>} remove
 * @property {(userId: string) => Promise<string[]>} [guilds] distinct guild ids
 *           the member appears in for this collection. Defaults to a `userId`
 *           match; overridden where the member is keyed by another field so that
 *           guild discovery (scripts/delete-user-data.js) finds a member who has,
 *           say, a case but no economy profile in a guild.
 */

/** @type {RegistryEntry[]} */
const USER_DATA_ENTRIES = [
    {
        key: 'profile',
        label: 'Economy profile (balances, inventory, levels, timezone, streaks)',
        model: User,
        behavior: 'delete',
        collect: (userId, guildId) => lean(User.find({ userId, guildId })),
        remove: async (userId, guildId) =>
            (await User.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'conversations',
        label: 'AI conversation history and pinned memories',
        model: Conversation,
        behavior: 'delete',
        collect: (userId, guildId) => lean(Conversation.find({ userId, guildId })),
        remove: async (userId, guildId) =>
            (await Conversation.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'transactions',
        label: 'Economy transaction ledger',
        model: Transaction,
        behavior: 'delete',
        collect: (userId, guildId) => lean(Transaction.find({ userId, guildId })),
        // The accountability record deleteUserData writes afterwards is keyed by
        // the pseudonym, not the real id, so it is never matched by this filter —
        // not on this run and not on a re-run.
        remove: async (userId, guildId) =>
            (await Transaction.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'reminders',
        label: 'Reminders',
        model: Reminder,
        behavior: 'delete',
        collect: (userId, guildId) => lean(Reminder.find({ userId, guildId })),
        remove: async (userId, guildId) =>
            (await Reminder.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'grindProfiles',
        label: 'Fishing/hunting/mining progression',
        model: GrindProfile,
        behavior: 'delete',
        collect: (userId, guildId) => lean(GrindProfile.find({ userId, guildId })),
        remove: async (userId, guildId) =>
            (await GrindProfile.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'bigWins',
        label: 'Big-win feed entries',
        model: BigWin,
        behavior: 'delete',
        collect: (userId, guildId) => lean(BigWin.find({ userId, guildId })),
        remove: async (userId, guildId) =>
            (await BigWin.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'aiQuests',
        label: 'AI-generated quests',
        model: AiQuest,
        behavior: 'delete',
        collect: (userId, guildId) => lean(AiQuest.find({ userId, guildId })),
        remove: async (userId, guildId) =>
            (await AiQuest.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'weeklyChampions',
        label: 'Weekly champion standings',
        model: WeeklyChampion,
        behavior: 'delete',
        collect: (userId, guildId) => lean(WeeklyChampion.find({ userId, guildId })),
        remove: async (userId, guildId) =>
            (await WeeklyChampion.deleteMany({ userId, guildId })).deletedCount || 0,
    },
    {
        key: 'marketListings',
        label: 'Open market listings',
        model: MarketListing,
        behavior: 'delete',
        collect: (userId, guildId) => lean(MarketListing.find({ sellerId: userId, guildId })),
        remove: async (userId, guildId) =>
            (await MarketListing.deleteMany({ sellerId: userId, guildId })).deletedCount || 0,
        guilds: userId => MarketListing.distinct('guildId', { sellerId: userId }),
    },
    {
        key: 'dmSessions',
        label: 'Dungeon-master campaign characters',
        model: DmSession,
        behavior: 'delete',
        // A campaign is shared, so the export returns only the member's own
        // character and their relationship to the session — never the other
        // players' characters or the shared story log, which are someone else's
        // data in the same document (#1013 review).
        collect: async (userId, guildId) => {
            const docs = await lean(DmSession.find(
                { guildId, $or: [{ hostId: userId }, { 'players.userId': userId }] }));
            return docs.map(doc => ({
                _id: doc._id,
                sessionId: doc.sessionId,
                channelId: doc.channelId,
                isHost: doc.hostId === userId,
                character: (doc.players || []).find(p => p.userId === userId) || null,
            }));
        },
        guilds: userId =>
            DmSession.distinct('guildId', { $or: [{ hostId: userId }, { 'players.userId': userId }] }),
        // Erasure removes the member's own character, and a session the member
        // hosts is theirs to take with them.
        remove: async (userId, guildId) => {
            const hosted = await DmSession.deleteMany({ guildId, hostId: userId });
            const left = await DmSession.updateMany(
                { guildId, 'players.userId': userId },
                { $pull: { players: { userId } } },
            );
            return (hosted.deletedCount || 0) + (left.modifiedCount || 0);
        },
    },
    {
        key: 'fishingTournaments',
        label: 'Fishing-tournament entries',
        model: FishingTournament,
        behavior: 'delete',
        collect: async (userId, guildId) => {
            const docs = await lean(FishingTournament.find({ guildId, 'entries.userId': userId }));
            // Only the member's own entries, not the whole tournament board.
            return docs.map(doc => ({
                _id: doc._id,
                endsAt: doc.endsAt,
                entries: (doc.entries || []).filter(e => e.userId === userId),
            })).filter(doc => doc.entries.length);
        },
        remove: async (userId, guildId) => {
            const pulled = await FishingTournament.updateMany(
                { guildId, 'entries.userId': userId },
                { $pull: { entries: { userId } } },
            );
            return pulled.modifiedCount || 0;
        },
        guilds: userId => FishingTournament.distinct('guildId', { 'entries.userId': userId }),
    },
    {
        key: 'seasonRecords',
        label: 'Ended-season leaderboard placements',
        model: SeasonRecord,
        behavior: 'delete',
        collect: async (userId, guildId) => {
            const docs = await lean(SeasonRecord.find({ guildId, 'top10.userId': userId }));
            return docs.map(doc => ({
                _id: doc._id,
                seasonId: doc.seasonId,
                endedAt: doc.endedAt,
                placements: (doc.top10 || []).filter(e => e.userId === userId),
            })).filter(doc => doc.placements.length);
        },
        remove: async (userId, guildId) => {
            const pulled = await SeasonRecord.updateMany(
                { guildId, 'top10.userId': userId },
                { $pull: { top10: { userId } } },
            );
            return pulled.modifiedCount || 0;
        },
        guilds: userId => SeasonRecord.distinct('guildId', { 'top10.userId': userId }),
    },
    {
        key: 'syndicates',
        label: 'Crime-syndicate membership',
        model: Syndicate,
        behavior: 'pseudonymize',
        reason: 'a syndicate is the server\'s shared entity; the member is removed '
            + 'from its rosters, and a syndicate they lead keeps its history under a '
            + 'redacted leader rather than being deleted out from under the others.',
        // The export returns the member's relationship to the syndicate, not its
        // full roster or pending-invite list — those are other members' ids
        // (#1013 review).
        collect: async (userId, guildId) => {
            const docs = await lean(Syndicate.find(
                { guildId, $or: [{ leaderId: userId }, { memberIds: userId }, { pendingInvites: userId }] }));
            return docs.map(doc => ({
                _id: doc._id,
                syndicateId: doc.syndicateId,
                name: doc.name,
                tag: doc.tag,
                isLeader: doc.leaderId === userId,
                isMember: (doc.memberIds || []).includes(userId),
                invitePending: (doc.pendingInvites || []).includes(userId),
            }));
        },
        guilds: userId => Syndicate.distinct('guildId',
            { $or: [{ leaderId: userId }, { memberIds: userId }, { pendingInvites: userId }] }),
        remove: async (userId, guildId) => {
            const pulled = await Syndicate.updateMany(
                { guildId, $or: [{ memberIds: userId }, { pendingInvites: userId }] },
                { $pull: { memberIds: userId, pendingInvites: userId } },
            );
            const led = await Syndicate.updateMany(
                { guildId, leaderId: userId },
                { $set: { leaderId: pseudonymize(userId) } },
            );
            return (pulled.modifiedCount || 0) + (led.modifiedCount || 0);
        },
    },
    {
        key: 'cases',
        label: 'Moderation cases (as subject or moderator)',
        model: Case,
        behavior: 'pseudonymize',
        reason: 'a case is the server\'s moderation record; the identities inside it '
            + 'are redacted so the account can be forgotten without the server losing '
            + 'the history it is entitled to keep.',
        // The export returns the case as it concerns the member, with the other
        // parties' ids redacted and the moderator notes and evidence — which can
        // name or quote other people — left out entirely (#1013 review). What
        // remains is what the subject of a case is entitled to see: that it
        // exists, its type, reason and outcome.
        collect: async (userId, guildId) => {
            const docs = await lean(Case.find(
                { guildId, $or: [{ targetUserId: userId }, { moderatorId: userId }, { assignedModId: userId }] }));
            return docs.map(doc => ({
                _id: doc._id,
                caseId: doc.caseId,
                type: doc.type,
                reason: doc.reason,
                duration: doc.duration,
                status: doc.status,
                createdAt: doc.createdAt,
                role: doc.targetUserId === userId ? 'subject' : 'moderator',
                targetUserId: redactOther(doc.targetUserId, userId),
                moderatorId: redactOther(doc.moderatorId, userId),
                assignedModId: redactOther(doc.assignedModId, userId),
            }));
        },
        guilds: userId => Case.distinct('guildId',
            { $or: [{ targetUserId: userId }, { moderatorId: userId }, { assignedModId: userId }] }),
        remove: async (userId, guildId) => {
            const token = pseudonymize(userId);
            let changed = 0;
            for (const field of ['targetUserId', 'moderatorId', 'assignedModId']) {
                const res = await Case.updateMany(
                    { guildId, [field]: userId },
                    { $set: { [field]: token } },
                );
                changed += res.modifiedCount || 0;
            }
            // Case notes carry their own author id.
            const notes = await Case.updateMany(
                { guildId, 'notes.moderatorId': userId },
                { $set: { 'notes.$[note].moderatorId': token } },
                { arrayFilters: [{ 'note.moderatorId': userId }] },
            );
            return changed + (notes.modifiedCount || 0);
        },
    },
    {
        key: 'auditLog',
        label: 'Dashboard audit log',
        model: AuditLog,
        behavior: 'retain',
        reason: 'the audit log is the server\'s security record of who changed what '
            + 'in the dashboard; it is kept intact, and its IP-bearing rows already '
            + 'expire on their own retention clock (AUDIT_LOG_RETENTION_DAYS).',
        collect: (userId, guildId) => lean(AuditLog.find({ userId, guildId })),
        remove: async () => 0,
    },
    {
        key: 'tempBans',
        label: 'Active temporary bans',
        model: TempBan,
        behavior: 'retain',
        reason: 'a temporary ban is active enforcement; deleting it on request would '
            + 'turn erasure into ban evasion, so the row is kept until it expires on '
            + 'its own.',
        // The ban is the member's own record, but the moderator who set it is a
        // third party, redacted like the moderator on a case (#1013 review).
        collect: async (userId, guildId) => {
            const bans = await lean(TempBan.find({ userId, guildId }));
            return bans.map(ban => ({
                _id: ban._id,
                userId: ban.userId,
                guildId: ban.guildId,
                reason: ban.reason,
                expiresAt: ban.expiresAt,
                createdAt: ban.createdAt,
                moderatorId: redactOther(ban.moderatorId, userId),
            }));
        },
        remove: async () => 0,
    },
];

/**
 * Everything the bot stores about a member in one guild, for an access request.
 *
 * @param {string} userId
 * @param {string} guildId
 * @returns {Promise<{generatedAt: string, userId: string, guildId: string,
 *   collections: Object<string, {label: string, behavior: string, retained: boolean,
 *   reason?: string, records: object[]}>}>}
 */
async function exportUserData(userId, guildId) {
    const collections = {};
    for (const entry of USER_DATA_ENTRIES) {
        const records = await entry.collect(userId, guildId);
        collections[entry.key] = {
            label: entry.label,
            behavior: entry.behavior,
            // What erasure would do with this collection, so the archive doubles
            // as a plain statement of what `/mydata delete` keeps and why.
            retained: entry.behavior !== 'delete',
            ...(entry.reason ? { reason: entry.reason } : {}),
            records,
        };
    }
    return {
        generatedAt: new Date().toISOString(),
        userId,
        guildId,
        collections,
    };
}

/** Every guild a member has any registered data in, across all collections. */
async function guildIdsForUser(userId) {
    const perEntry = await Promise.all(USER_DATA_ENTRIES.map(entry =>
        entry.guilds ? entry.guilds(userId) : entry.model.distinct('guildId', { userId })));
    // Distinct across collections, and never a null/undefined guild id.
    return [...new Set(perEntry.flat().filter(Boolean))];
}

/**
 * Erase a member's data in one guild, keeping the records the bot must keep and
 * recording the coins removed so the guild's supply stays reconcilable.
 *
 * The profile is claimed with an atomic `findOneAndDelete`, which does the read
 * and the delete in one operation. That is what makes the coin accounting both
 * exactly-once and recoverable (#1013 review):
 *
 *   - Two erasures racing on the same member cannot both see the balance —
 *     only the one whose delete actually removed the document gets it back, so
 *     only that one writes the accountability record.
 *   - The record is written the moment the profile is claimed, before the other
 *     collections are cleared. If a later deletion fails, the coins are already
 *     accounted for and a retry — which finds no profile, so writes no second
 *     record — simply finishes the remaining (idempotent) deletions.
 *
 * The record is keyed by the member's pseudonym, so the ledger wipe below never
 * matches it, on this run or a re-run.
 *
 * @param {string} userId
 * @param {string} guildId
 * @param {object} [deps]
 * @param {import('mongoose').Model} [deps.Transaction] injectable for the tests.
 * @returns {Promise<{userId: string, guildId: string, coinsRemoved: number,
 *   results: Array<{key: string, label: string, behavior: string, changed: number}>}>}
 */
async function deleteUserData(userId, guildId, { Transaction: TxModel = Transaction } = {}) {
    const profile = await User.findOneAndDelete(
        { userId, guildId }, { projection: { balance: 1, bank: 1 } }).lean();
    const coinsRemoved = (profile?.balance || 0) + (profile?.bank || 0);

    if (coinsRemoved > 0) {
        // Awaited, not fire-and-forget: the accountability of the coin supply is
        // the whole point of this record. Written before the rest of the
        // deletions so a partial failure cannot strand the removed coins.
        await TxModel.create({
            userId: pseudonymize(userId),
            guildId,
            type: ERASURE_TX_TYPE,
            amount: -coinsRemoved,
            balance: 0,
            bank: 0,
            note: 'Balance removed by data-erasure request',
        });
    }

    const results = [];
    for (const entry of USER_DATA_ENTRIES) {
        // The profile row was already removed atomically above; its entry stays
        // in the list for export and the drift guard, and re-running its
        // (idempotent) remove here would just delete nothing.
        const changed = entry.model === User
            ? (profile ? 1 : 0)
            : await entry.remove(userId, guildId);
        results.push({ key: entry.key, label: entry.label, behavior: entry.behavior, changed });
    }

    return { userId, guildId, coinsRemoved, results };
}

/** Model names the registry covers, for the drift test. */
const REGISTERED_MODELS = new Set(USER_DATA_ENTRIES.map(e => e.model.modelName));

module.exports = {
    USER_DATA_ENTRIES,
    REGISTERED_MODELS,
    exportUserData,
    deleteUserData,
    guildIdsForUser,
    pseudonymize,
    REDACTED_PREFIX,
    ERASURE_TX_TYPE,
};
