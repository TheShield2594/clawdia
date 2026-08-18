// The failure path writes a dead-letter record; without a Mongo connection
// mongoose would buffer that write forever, so stub the model out.
jest.mock('../src/models/FailedJob', () => ({ create: jest.fn().mockResolvedValue({}) }));

const { runJob } = require('../src/utils/jobRunner');
const { getStatus } = require('../src/health');

/** Resolves once `release()` is called. */
function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}

describe('runJob overlap protection', () => {
    let warn;

    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
    });

    it('skips a tick that arrives while the same job is still running', async () => {
        const g = gate();
        let runs = 0;
        const fn = async () => { runs++; await g.promise; };

        const first = runJob('overlapSvc', 'tick', fn);
        const second = await runJob('overlapSvc', 'tick', fn);

        expect(second).toBe(false);
        expect(runs).toBe(1);

        g.release();
        expect(await first).toBe(true);
        expect(runs).toBe(1);
    });

    it('lets the next tick run once the previous one finishes', async () => {
        let runs = 0;
        const fn = async () => { runs++; };

        expect(await runJob('sequentialSvc', 'tick', fn)).toBe(true);
        expect(await runJob('sequentialSvc', 'tick', fn)).toBe(true);
        expect(runs).toBe(2);
    });

    it('releases the lock when the job throws', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('boom'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await runJob('throwingSvc', 'tick', fn);
        await runJob('throwingSvc', 'tick', fn);

        expect(fn).toHaveBeenCalledTimes(2);
        error.mockRestore();
    });

    it('scopes the lock per guild so two guilds do not block each other', async () => {
        const g = gate();
        let runs = 0;
        const fn = async () => { runs++; await g.promise; };

        const a = runJob('perGuildSvc', 'tick', fn, { guildId: 'guild-a' });
        const b = runJob('perGuildSvc', 'tick', fn, { guildId: 'guild-b' });
        const dupA = await runJob('perGuildSvc', 'tick', fn, { guildId: 'guild-a' });

        expect(dupA).toBe(false);
        expect(runs).toBe(2);

        g.release();
        await Promise.all([a, b]);
    });

    it('counts skips on the health report without marking the service unhealthy', async () => {
        const g = gate();
        const fn = async () => { await g.promise; };

        const first = runJob('healthSvc', 'tick', fn);
        await runJob('healthSvc', 'tick', fn);
        g.release();
        await first;

        const svc = getStatus().services.healthSvc;
        expect(svc.skippedCount).toBe(1);
        expect(svc.healthy).toBe(true);
    });
});
