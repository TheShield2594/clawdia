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
jest.mock('../src/services/casinoJackpotService', () => ({ reconcileJackpotClaims: jest.fn() }));
jest.mock('../src/games/casino/crashRefund', () => ({ reconcileCrashRefunds: jest.fn() }));

const { deployCommandsIfChanged } = require('../src/utils/commandDeployer');
const { startScheduler } = require('../src/services/scheduler');
const { reconcileJackpotClaims } = require('../src/services/casinoJackpotService');
const { reconcileCrashRefunds } = require('../src/games/casino/crashRefund');

const ready = require('../src/events/ready');

function makeClient() {
    return {
        user: { id: 'bot-1', tag: 'Clawdia#0001' },
        guilds: { cache: { size: 3 } },
        commands: new Map([['ping', { data: {} }]]),
    };
}

let logs;
let errors;

beforeEach(() => {
    jest.clearAllMocks();
    logs = jest.spyOn(console, 'log').mockImplementation(() => {});
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    deployCommandsIfChanged.mockResolvedValue({ deployed: true, count: 98, reason: 'command set changed' });
    reconcileJackpotClaims.mockResolvedValue({ reconciled: 0, failed: 0 });
    reconcileCrashRefunds.mockResolvedValue({ refunded: 0, failed: 0 });
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
    // The sweep itself lives in casinoJackpotService, where the claim marker and
    // the payout key it credits under are (#873). What startup owes it is a call
    // on every boot — the failure it exists for is a process that stopped
    // between claiming a pot and paying it, so there is no live caller left to
    // retry — and not letting it take the rest of startup down with it.

    it('settles anything the last process left unpaid, and says what it settled', async () => {
        reconcileJackpotClaims.mockResolvedValue({ reconciled: 2, failed: 0 });

        await ready.execute(makeClient());

        expect(reconcileJackpotClaims).toHaveBeenCalled();
        expect(logs).toHaveBeenCalledWith(expect.stringContaining('Reconciled 2 unpaid jackpot win(s)'));
    });

    it('stays quiet when there was nothing outstanding', async () => {
        await ready.execute(makeClient());

        expect(logs).not.toHaveBeenCalledWith(expect.stringContaining('jackpot'));
        expect(errors).not.toHaveBeenCalled();
    });

    it('reports the claims left for the next restart', async () => {
        reconcileJackpotClaims.mockResolvedValue({ reconciled: 0, failed: 1 });

        await ready.execute(makeClient());

        expect(errors).toHaveBeenCalledWith(expect.stringContaining('could not be settled'));
    });

    it('logs a sweep that blew up and carries on to the crash refunds', async () => {
        reconcileJackpotClaims.mockRejectedValue(new Error('mongo is down'));

        await ready.execute(makeClient());

        expect(errors).toHaveBeenCalledWith('[READY] Jackpot reconciliation failed:', expect.any(Error));
        expect(reconcileCrashRefunds).toHaveBeenCalled();
    });
});

// The sweep's own logic — the update it issues, the shard scoping, the race
// between two boots — is pinned in tests/crashRestartRefund.test.js, against the
// pipeline evaluator rather than a copy of the update. This only pins the wiring.
describe('crash refund sweep', () => {
    it('runs the sweep for this client and reports what it refunded', async () => {
        reconcileCrashRefunds.mockResolvedValue({ refunded: 2, failed: 0 });
        const client = makeClient();

        await ready.execute(client);

        expect(reconcileCrashRefunds).toHaveBeenCalledWith(client);
        expect(logs).toHaveBeenCalledWith('[READY] Refunded crash bets for 2 user(s)');
    });

    it('stays quiet when no bet is outstanding', async () => {
        await ready.execute(makeClient());

        expect(logs).not.toHaveBeenCalledWith(expect.stringContaining('crash bets'));
        expect(logs).toHaveBeenCalledWith('[READY] Background services started');
    });

    it('reports the refunds left for the next restart', async () => {
        reconcileCrashRefunds.mockResolvedValue({ refunded: 0, failed: 1 });

        await ready.execute(makeClient());

        expect(errors).toHaveBeenCalledWith(expect.stringContaining('left for the next restart'));
    });

    it('logs a failed sweep rather than aborting startup', async () => {
        reconcileCrashRefunds.mockRejectedValue(new Error('mongo is down'));

        await ready.execute(makeClient());

        expect(errors).toHaveBeenCalledWith('[READY] Crash refund sweep failed:', expect.any(Error));
        expect(logs).toHaveBeenCalledWith('[READY] Background services started');
    });
});
