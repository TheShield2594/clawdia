'use strict';

// Guild-to-shard affinity, and the singleton gate (#732).
//
// #609 moved every piece of money-adjacent state into Mongo and left four live
// multiplayer rounds behind — crash lobbies, heist and syndicate heist
// sessions, and the raid join window — because a lobby is an object graph of
// timers and collectors, not a value. #732 asked whether that is safe under
// sharding, and the answer turns entirely on whether a guild is guaranteed to
// be handled by exactly one shard.
//
// It is, by Discord's own gateway routing. These tests hold that claim to the
// formula, hold the four stores to being keyed by something a guild determines,
// and hold the singleton gate to shard 0 — because the failure mode on the
// other side of that gate is every cron job firing once per shard, which for
// applyBankInterest means paying every account N times.

const fs   = require('fs');
const path = require('path');

const {
    shardIdForGuild,
    shardCount,
    shardId,
    isPrimaryShard,
    ownsGuild,
    assertGuildAffinity,
    shardTag,
} = require('../src/utils/sharding');

// Real-shaped snowflakes: a Discord id is a 64-bit integer whose top 42 bits are
// a millisecond timestamp, which is exactly the part the routing formula reads.
const SNOWFLAKES = [
    '81384788765712384',
    '222078108977594368',
    '613425648685547541',
    '1234567890123456789',
    '900000000000000000',
    '1099511627776',
];

const fakeClient = (id, count) => ({ shard: { ids: [id], count } });

afterEach(() => {
    delete process.env.SHARD_COUNT;
    delete process.env.SHARD_ID;
});

describe('the routing formula', () => {
    it('is Discord\'s own: (guildId >> 22) % shardCount', () => {
        for (const guildId of SNOWFLAKES) {
            for (const count of [1, 2, 3, 4, 8, 16]) {
                const expected = Number((BigInt(guildId) >> 22n) % BigInt(count));
                expect(shardIdForGuild(guildId, count)).toBe(expected);
            }
        }
    });

    it('computes in BigInt, because a snowflake does not fit in a double', () => {
        // The bug this exists to prevent: routing through a float rounds the low
        // bits away and lands on the wrong shard for a fraction of guilds —
        // rarely enough to ship, and impossible to reproduce from a bug report.
        // These two ids are ones where the float form really does diverge.
        for (const guildId of ['1000000000190578654', '1000000001067188197']) {
            expect(Number.isSafeInteger(Number(guildId))).toBe(false);
            const naive = Math.floor(Number(guildId) / 2 ** 22) % 4;
            const correct = shardIdForGuild(guildId, 4);
            expect(correct).toBe(Number((BigInt(guildId) >> 22n) % 4n));
            expect(naive).not.toBe(correct);
        }
    });

    it('always lands inside the shard range', () => {
        for (const guildId of SNOWFLAKES) {
            for (const count of [1, 2, 3, 5, 7, 16, 64]) {
                const id = shardIdForGuild(guildId, count);
                expect(Number.isInteger(id)).toBe(true);
                expect(id).toBeGreaterThanOrEqual(0);
                expect(id).toBeLessThan(count);
            }
        }
    });

    it('is stable: the same guild always routes to the same shard', () => {
        for (const guildId of SNOWFLAKES) {
            const first = shardIdForGuild(guildId, 8);
            for (let i = 0; i < 20; i++) expect(shardIdForGuild(guildId, 8)).toBe(first);
        }
    });

    it('puts everything on shard 0 when there is one shard', () => {
        for (const guildId of SNOWFLAKES) expect(shardIdForGuild(guildId, 1)).toBe(0);
    });

    it('refuses a shard count or a guild id it cannot route with', () => {
        expect(() => shardIdForGuild(SNOWFLAKES[0], 0)).toThrow(TypeError);
        expect(() => shardIdForGuild(SNOWFLAKES[0], -1)).toThrow(TypeError);
        expect(() => shardIdForGuild(SNOWFLAKES[0], 2.5)).toThrow(TypeError);
        expect(() => shardIdForGuild('not-a-snowflake', 4)).toThrow(TypeError);
    });
});

describe('shard identity', () => {
    it('reads the client first, then the environment, then falls back to unsharded', () => {
        expect(shardCount(fakeClient(2, 8))).toBe(8);
        expect(shardId(fakeClient(2, 8))).toBe(2);

        process.env.SHARD_COUNT = '4';
        process.env.SHARD_ID = '3';
        expect(shardCount()).toBe(4);
        expect(shardId()).toBe(3);

        delete process.env.SHARD_COUNT;
        delete process.env.SHARD_ID;
        expect(shardCount()).toBe(1);
        expect(shardId()).toBe(0);
    });

    it('ignores a malformed environment rather than spawning NaN shards', () => {
        for (const bad of ['', 'auto', '0', '-2', '1.5']) {
            process.env.SHARD_COUNT = bad;
            expect(shardCount()).toBe(1);
        }
    });
});

describe('the singleton gate', () => {
    it('is true unsharded, so nothing changes for a single-process deployment', () => {
        expect(isPrimaryShard()).toBe(true);
        expect(shardTag()).toBe('');
    });

    it('is true on exactly one shard when sharded', () => {
        const primaries = [0, 1, 2, 3, 4, 5, 6, 7].filter(id => isPrimaryShard(fakeClient(id, 8)));
        expect(primaries).toEqual([0]);
    });

    it('tags log lines only when there is more than one process to tell apart', () => {
        expect(shardTag(fakeClient(0, 1))).toBe('');
        expect(shardTag(fakeClient(3, 8))).toBe('[shard 3/8] ');
    });
});

describe('ownership partitions every guild exactly once', () => {
    it('assigns each guild to one shard and no other', () => {
        const count = 8;
        for (const guildId of SNOWFLAKES) {
            const owners = [];
            for (let id = 0; id < count; id++) {
                if (ownsGuild(guildId, fakeClient(id, count))) owners.push(id);
            }
            expect(owners).toHaveLength(1);
        }
    });

    it('claims everything when unsharded', () => {
        for (const guildId of SNOWFLAKES) expect(ownsGuild(guildId)).toBe(true);
    });

    it('does not claim a guild it cannot route, and does not throw doing it', () => {
        expect(ownsGuild('not-a-snowflake', fakeClient(1, 4))).toBe(false);
    });
});

describe('the affinity assertion', () => {
    it('passes silently for a guild this shard owns', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const guildId = SNOWFLAKES[0];
        const owner = shardIdForGuild(guildId, 4);
        expect(assertGuildAffinity(guildId, 'test', fakeClient(owner, 4))).toBe(true);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('warns rather than throws when affinity is violated', () => {
        // A mid-round throw would strand players in a lobby whose stakes are
        // already debited, which is worse than the duplicate being warned about.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const guildId = SNOWFLAKES[0];
        const owner = shardIdForGuild(guildId, 4);
        const wrong = (owner + 1) % 4;
        expect(() => assertGuildAffinity(guildId, 'crash lobby', fakeClient(wrong, 4))).not.toThrow();
        expect(assertGuildAffinity(guildId, 'crash lobby', fakeClient(wrong, 4))).toBe(false);
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toContain('crash lobby');
        warn.mockRestore();
    });

    it('warns without throwing for an id it cannot route at all', () => {
        // `ownsGuild` returns false for an unroutable id as well as for one that
        // belongs elsewhere, and resolving the destination for the warning is
        // exactly what throws on an unroutable one. The "warns, never throws"
        // contract has to hold for both.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => assertGuildAffinity('not-a-snowflake', 'crash lobby', fakeClient(1, 4))).not.toThrow();
        expect(assertGuildAffinity('not-a-snowflake', 'crash lobby', fakeClient(1, 4))).toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('never fires unsharded', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        for (const guildId of SNOWFLAKES) expect(assertGuildAffinity(guildId, 'test')).toBe(true);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('the four process-bound session stores are covered by affinity', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

    // Each of these holds a live round in a Map. That is only correct while one
    // process sees all of one guild's events, so each one says so at the point
    // it makes the assumption.
    const STORES = [
        ['utils/crashLobby.js',          'crash lobby'],
        ['services/heistService.js',     'heist lobby'],
        ['services/syndicateService.js', 'syndicate heist lobby'],
        ['services/raidService.js',      'raid join window'],
    ];

    it.each(STORES)('%s asserts affinity when it opens a round', (rel, label) => {
        const code = read(rel);
        expect(code).toContain('assertGuildAffinity');
        expect(code).toContain(label);
    });

    it('keys every store by something one guild determines', () => {
        // heist, syndicate and raid are keyed by guildId outright; crash is
        // keyed by channelId, and a channel belongs to exactly one guild — which
        // is why it carries the guild id along purely for this check.
        expect(read('services/heistService.js')).toContain('activeHeists.set(guildId,');
        expect(read('services/syndicateService.js')).toContain('activeSyndicateHeists.set(guildId,');
        expect(read('services/raidService.js')).toContain('joinLog.set(guildId,');
        expect(read('utils/crashLobby.js')).toContain('lobbies.set(channelId,');
    });
});

describe('singleton work is gated, not merely documented', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

    it('starts the dashboard only on the primary shard', () => {
        // N processes binding one TCP port is the first thing that breaks.
        const code = read('index.js');
        expect(code).toMatch(/isPrimaryShard\(client\)[\s\S]{0,400}dashboard/i);
    });

    it('runs migrations on the primary shard and makes the others wait', () => {
        // Not "skip and carry on": serving traffic against a half-migrated
        // database is what the ordering exists to prevent.
        const code = read('index.js');
        expect(code).toContain('waitForMigrations');
        expect(code).toMatch(/isPrimaryShard\(client\)[\s\S]{0,200}runMigrations\(\)/);
    });

    it('schedules cron jobs on the primary shard only', () => {
        // jobRunner's overlap guard is a process-local Set, so it cannot see a
        // second process running the same job — applyBankInterest paying every
        // account twice is the shape of getting this wrong.
        const code = read('services/scheduler/index.js');
        expect(code).toContain('isPrimaryShard');
        const gateIndex = code.indexOf('if (!isPrimaryShard(client))');
        expect(gateIndex).toBeGreaterThan(-1);
        expect(code.indexOf('for (const job of JOBS)')).toBeGreaterThan(gateIndex);
        expect(code.indexOf('runStarters(STARTERS, client)')).toBeGreaterThan(gateIndex);
    });

    it('still sets presence on every shard', () => {
        // Presence belongs to a gateway connection, not to the deployment: a
        // shard that skipped it would show no activity to the guilds it serves.
        const code = read('services/scheduler/index.js');
        const presenceIndex = code.indexOf('setPresence(client);');
        const gateIndex = code.indexOf('if (!isPrimaryShard(client))');
        expect(presenceIndex).toBeGreaterThan(-1);
        expect(presenceIndex).toBeLessThan(gateIndex);
    });

    it('warms this process\'s own caches on every shard', () => {
        // Same reasoning as presence, applied to the MCP connection pool: it is
        // per-process, so a shard behind the gate would serve every guild it
        // owns a cold cache on the first message after a restart.
        const code = read('services/scheduler/index.js');
        const shardStarters = code.indexOf('runStarters(SHARD_STARTERS, client)');
        const gateIndex = code.indexOf('if (!isPrimaryShard(client))');
        expect(shardStarters).toBeGreaterThan(-1);
        expect(shardStarters).toBeLessThan(gateIndex);
    });
});

describe('the sharded entry point', () => {
    it('exists and spawns index.js under a ShardingManager', () => {
        const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'shard.js'), 'utf8');
        expect(code).toContain('ShardingManager');
        expect(code).toContain("path.join(__dirname, 'index.js')");
    });

    it('is wired to an npm script, so it is reachable without knowing the path', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        expect(pkg.scripts['start:sharded']).toBe('node src/shard.js');
        // The unsharded path stays the default: nothing about this turns
        // sharding on for an existing deployment.
        expect(pkg.scripts.start).toBe('node src/index.js');
    });
});
