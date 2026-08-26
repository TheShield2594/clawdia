'use strict';

/**
 * #784. `processExpiredBans` runs on a cron with no user in the loop, and it is
 * the only thing that lifts a temporary ban — a ban it fails to lift stays in
 * place until the banned user complains.
 *
 * 8b35886 fixed a real bug in it: `guild.bans.fetch(...).catch(() => null)` read
 * *any* failure as "there is no ban", so a missing Ban Members permission or a
 * transient 500 deleted the TempBan record while the ban stayed on forever, and
 * bypassed the failure count so the sweep still reported healthy. That fix
 * shipped with no test and the file was at 0%.
 *
 * These pin the three behaviours it turns on: which failure retires a record,
 * which failure keeps it, and that a sweep with failures is loud.
 */

jest.mock('../src/models/TempBan', () => ({ find: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../src/services/moderationLogService', () => ({ logModeration: jest.fn() }));

const TempBan = require('../src/models/TempBan');
const { logModeration } = require('../src/services/moderationLogService');
const { processExpiredBans } = require('../src/services/tempBanService');

const UNKNOWN_BAN = 10026;

function discordError(code) {
    const err = new Error(`DiscordAPIError[${code}]`);
    err.code = code;
    return err;
}

/**
 * A client whose guild either resolves a ban, or fails the fetch with `banError`.
 * `unbanError` fails the unban itself, which is the missing-permission case that
 * only shows up after the fetch has succeeded.
 */
function fakeClient({ guildId = 'g1', ban = { user: { id: 'u1' } }, banError = null, unbanError = null } = {}) {
    const calls = { unbanned: [], fetched: [] };
    const guild = {
        bans: {
            fetch: jest.fn(async userId => {
                calls.fetched.push(userId);
                if (banError) throw banError;
                return ban;
            }),
        },
        members: {
            unban: jest.fn(async (userId, reason) => {
                if (unbanError) throw unbanError;
                calls.unbanned.push([userId, reason]);
            }),
        },
    };
    return {
        calls,
        guild,
        client: {
            user: { id: 'bot' },
            guilds: { cache: new Map(guildId ? [[guildId, guild]] : []) },
        },
    };
}

function entry(over = {}) {
    return { _id: 'rec1', guildId: 'g1', userId: 'u1', expiresAt: new Date(0), ...over };
}

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    TempBan.deleteOne.mockResolvedValue({ deletedCount: 1 });
    logModeration.mockResolvedValue(undefined);
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('processExpiredBans', () => {
    test('sweeps only bans whose expiry has passed', async () => {
        TempBan.find.mockResolvedValue([]);

        await processExpiredBans(fakeClient().client);

        const [filter] = TempBan.find.mock.calls[0];
        expect(Object.keys(filter)).toEqual(['expiresAt']);
        expect(filter.expiresAt.$lte).toBeInstanceOf(Date);
        // A `$gte` here would sweep the bans that have *not* expired yet.
        expect(filter.expiresAt.$lte.getTime()).toBeLessThanOrEqual(Date.now());
    });

    test('lifts an expired ban, logs it, and retires the record', async () => {
        TempBan.find.mockResolvedValue([entry()]);
        const { client, calls } = fakeClient();

        await expect(processExpiredBans(client)).resolves.toBeUndefined();

        expect(calls.unbanned).toEqual([['u1', 'Temporary ban expired']]);
        expect(logModeration).toHaveBeenCalledWith('g1', 'unban', { id: 'u1' }, client.user, 'Temporary ban expired');
        expect(TempBan.deleteOne).toHaveBeenCalledWith({ _id: 'rec1' });
    });

    test('an Unknown Ban clears the record — the ban is already gone', async () => {
        // Someone unbanned by hand, or a previous tick lifted it and died before
        // the delete. Either way the record has done its job; keeping it would
        // mean retrying a ban that does not exist, forever.
        TempBan.find.mockResolvedValue([entry()]);
        const { client, guild } = fakeClient({ banError: discordError(UNKNOWN_BAN) });

        await expect(processExpiredBans(client)).resolves.toBeUndefined();

        expect(guild.members.unban).not.toHaveBeenCalled();
        expect(logModeration).not.toHaveBeenCalled();
        expect(TempBan.deleteOne).toHaveBeenCalledWith({ _id: 'rec1' });
    });

    test.each([
        ['a missing Ban Members permission', 50013],
        ['a transient server error',         500],
        ['a plain failure with no code',     undefined],
    ])('%s keeps the record and fails the sweep', async (_label, code) => {
        // This is the regression 8b35886 fixed. Deleting here strands the ban:
        // the record is the only thing that would ever lift it again.
        TempBan.find.mockResolvedValue([entry()]);
        const { client, guild } = fakeClient({ banError: code === undefined ? new Error('boom') : discordError(code) });

        await expect(processExpiredBans(client)).rejects.toThrow(/could not be lifted/);

        expect(TempBan.deleteOne).not.toHaveBeenCalled();
        expect(guild.members.unban).not.toHaveBeenCalled();
    });

    test('an unban that fails after a successful fetch also keeps the record', async () => {
        TempBan.find.mockResolvedValue([entry()]);
        const { client } = fakeClient({ unbanError: discordError(50013) });

        await expect(processExpiredBans(client)).rejects.toThrow(/1 of 1/);

        expect(TempBan.deleteOne).not.toHaveBeenCalled();
    });

    test('a guild the bot is no longer in retires the record instead of retrying forever', async () => {
        TempBan.find.mockResolvedValue([entry({ guildId: 'gone' })]);
        const { client } = fakeClient({ guildId: 'g1' });

        await expect(processExpiredBans(client)).resolves.toBeUndefined();

        expect(TempBan.deleteOne).toHaveBeenCalledWith({ _id: 'rec1' });
    });

    test('one ban that will not lift does not strand the rest of the sweep', async () => {
        TempBan.find.mockResolvedValue([
            entry({ _id: 'bad',  userId: 'u1' }),
            entry({ _id: 'good', userId: 'u2' }),
        ]);
        const { client, guild } = fakeClient();
        guild.bans.fetch.mockImplementation(async userId => {
            if (userId === 'u1') throw discordError(50013);
            return { user: { id: userId } };
        });

        await expect(processExpiredBans(client)).rejects.toThrow(/1 of 2/);

        // The healthy entry was still lifted and retired, and only it.
        expect(guild.members.unban).toHaveBeenCalledWith('u2', 'Temporary ban expired');
        expect(TempBan.deleteOne.mock.calls).toEqual([[{ _id: 'good' }]]);
    });

    test('throws so runJob files a dead letter — a silent sweep is the failure mode', async () => {
        // Returning normally here is what let every unban in a sweep fail while
        // /health still showed a healthy run. The entries are left alone, so the
        // next tick retries them.
        TempBan.find.mockResolvedValue([entry({ _id: 'a' }), entry({ _id: 'b', userId: 'u2' })]);
        const { client, guild } = fakeClient();
        guild.bans.fetch.mockRejectedValue(discordError(50013));

        await expect(processExpiredBans(client)).rejects.toThrow('2 of 2 expired ban(s) could not be lifted');

        expect(TempBan.deleteOne).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledTimes(2);
    });

    test('an empty sweep is a success, not a failure', async () => {
        TempBan.find.mockResolvedValue([]);

        await expect(processExpiredBans(fakeClient().client)).resolves.toBeUndefined();

        expect(TempBan.deleteOne).not.toHaveBeenCalled();
    });
});
