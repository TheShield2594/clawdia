'use strict';

// ready.js is startup orchestration: it is the only place slash commands are
// deployed, the only place the scheduler starts, and the only place the two
// crash-recovery sweeps run. None of it had a test, so nothing noticed if the
// scheduler call went away — the bot would come up, log in, look completely
// healthy and never run another scheduled job.
//
// So this pins the wiring rather than re-testing the deployer and the scheduler:
// that each of the four steps happens, that a failure in any one of them is
// logged rather than aborting the rest of startup, and — for the reconciliation
// loops, which are the only real logic here — that a credited win is cleared
// and a failed credit is left for the next restart to retry.

jest.mock('../src/utils/commandDeployer', () => ({ deployCommandsIfChanged: jest.fn() }));
jest.mock('../src/services/scheduler', () => ({ startScheduler: jest.fn() }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/Transaction', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { deployCommandsIfChanged } = require('../src/utils/commandDeployer');
const { startScheduler } = require('../src/services/scheduler');
const { logTransaction } = require('../src/utils/logTransaction');
const Guild = require('../src/models/Guild');
const Transaction = require('../src/models/Transaction');
const User = require('../src/models/User');

const ready = require('../src/events/ready');

const GUILD_ID = '111222333444555666';

function makeClient() {
    return {
        user: { id: 'bot-1', tag: 'Clawdia#0001' },
        guilds: { cache: { size: 3 } },
        commands: new Map([['ping', { data: {} }]]),
    };
}

/** Resolves the jackpot sweep's find-and-claim loop once, then ends it. */
function jackpotOnce(doc) {
    Guild.findOneAndUpdate.mockResolvedValueOnce(doc).mockResolvedValue(null);
}

function jackpotDoc(overrides = {}) {
    return {
        _id: 'doc-1',
        guildId: GUILD_ID,
        casinoJackpot: { lastWinnerId: 'user-1', lastWonAmount: 5000, lastWonAt: new Date('2026-01-01T00:00:00Z') },
        ...overrides,
    };
}

let logs;
let errors;

beforeEach(() => {
    jest.clearAllMocks();
    logs = jest.spyOn(console, 'log').mockImplementation(() => {});
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    deployCommandsIfChanged.mockResolvedValue({ deployed: true, count: 98, reason: 'command set changed' });
    Guild.findOneAndUpdate.mockResolvedValue(null);
    Guild.updateOne.mockResolvedValue({});
    Transaction.findOne.mockReturnValue({ lean: async () => null });
    User.find.mockReturnValue({ lean: async () => [] });
    User.findOneAndUpdate.mockResolvedValue(null);
});

afterEach(() => {
    logs.mockRestore();
    errors.mockRestore();
});

describe('registration', () => {
    it('runs once, on clientReady', () => {
        // `ready` was renamed to `clientReady` in discord.js v14.16; the old
        // name silently never fires.
        expect(ready.name).toBe('clientReady');
        expect(ready.once).toBe(true);
    });
});

describe('startup steps', () => {
    it('deploys the commands the process already loaded, and starts the scheduler', async () => {
        const client = makeClient();

        await ready.execute(client);

        // The loaded command set, not a second walk of src/commands — that is
        // what keeps the registered set and the running set the same set.
        const [botId, , commands] = deployCommandsIfChanged.mock.calls[0];
        expect(botId).toBe('bot-1');
        expect([...commands]).toEqual([...client.commands.values()]);
        expect(startScheduler).toHaveBeenCalledWith(client);
    });

    it('starts the scheduler even when the command deploy throws', async () => {
        // The bot is already connected and the previously registered commands
        // still work; refusing to finish startup here would take a working bot
        // down over a stale command description.
        deployCommandsIfChanged.mockRejectedValue(new Error('401 Unauthorized'));

        await ready.execute(makeClient());

        expect(errors).toHaveBeenCalledWith('[READY] Failed to deploy slash commands:', expect.any(Error));
        expect(startScheduler).toHaveBeenCalled();
    });

    it('says so when the deploy was skipped as unchanged', async () => {
        deployCommandsIfChanged.mockResolvedValue({ deployed: false, count: 98, reason: 'unchanged' });

        await ready.execute(makeClient());

        expect(logs).toHaveBeenCalledWith(expect.stringContaining('deploy skipped: unchanged'));
    });
});

describe('jackpot reconciliation', () => {
    it('credits a win the crash left unpaid, then clears the recovery fields', async () => {
        jackpotOnce(jackpotDoc());
        User.findOneAndUpdate.mockResolvedValue({ userId: 'user-1', balance: 12000 });

        await ready.execute(makeClient());

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'user-1', guildId: GUILD_ID },
            { $inc: { balance: 5000 } },
            { new: true }
        );
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-1', guildId: GUILD_ID, type: 'casino_jackpot', amount: 5000, balance: 12000,
        }));
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { _id: 'doc-1' },
            { $set: { 'casinoJackpot.lastWinnerId': null, 'casinoJackpot.lastWonAmount': null, 'casinoJackpot.claimToken': null } }
        );
    });

    it('does not pay twice when the transaction log already shows the credit', async () => {
        jackpotOnce(jackpotDoc());
        Transaction.findOne.mockReturnValue({ lean: async () => ({ _id: 'txn-1' }) });

        await ready.execute(makeClient());

        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        // Still cleared: the money is out, so leaving the fields set would make
        // every future restart look at the same already-paid win.
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { _id: 'doc-1' },
            expect.objectContaining({ $set: expect.objectContaining({ 'casinoJackpot.lastWinnerId': null }) })
        );
    });

    it('releases the claim without clearing the win when the credit fails', async () => {
        jackpotOnce(jackpotDoc());
        // No matching user document, so nobody was credited.
        User.findOneAndUpdate.mockResolvedValue(null);

        await ready.execute(makeClient());

        // Only the lock is dropped; the winner and amount stay for the next
        // restart to retry.
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { _id: 'doc-1' },
            { $set: { 'casinoJackpot.claimToken': null } }
        );
    });

    it('stops after a failing guild rather than spinning on it', async () => {
        // Every call would hand back the same unpayable guild if the loop kept
        // going, which is a startup that never finishes.
        Guild.findOneAndUpdate.mockResolvedValue(jackpotDoc());
        User.findOneAndUpdate.mockResolvedValue(null);

        await ready.execute(makeClient());

        expect(Guild.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('logs a sweep that blew up and carries on to the crash refunds', async () => {
        Guild.findOneAndUpdate.mockRejectedValue(new Error('mongo is down'));

        await ready.execute(makeClient());

        expect(errors).toHaveBeenCalledWith('[READY] Jackpot reconciliation failed:', expect.any(Error));
        expect(User.find).toHaveBeenCalled();
    });
});

describe('crash refund sweep', () => {
    it('returns each pending bet and logs the refund', async () => {
        User.find.mockReturnValue({
            lean: async () => [{ _id: 'u1', userId: 'user-1', guildId: GUILD_ID, balance: 100, pendingCrashRefund: 250 }],
        });

        await ready.execute(makeClient());

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'u1' },
            [{ $inc: { balance: '$pendingCrashRefund' } }, { $set: { pendingCrashRefund: 0 } }]
        );
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'crash_refund', amount: 250, balance: 350,
        }));
    });

    it('writes nothing when no bet is outstanding', async () => {
        await ready.execute(makeClient());

        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(logs).toHaveBeenCalledWith('[READY] Background services started');
    });

    it('logs a failed sweep rather than aborting startup', async () => {
        User.find.mockReturnValue({ lean: async () => { throw new Error('mongo is down'); } });

        await ready.execute(makeClient());

        expect(errors).toHaveBeenCalledWith('[READY] Crash refund sweep failed:', expect.any(Error));
        expect(logs).toHaveBeenCalledWith('[READY] Background services started');
    });
});
