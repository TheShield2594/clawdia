'use strict';

/**
 * #629. Migrations executed, rather than described.
 *
 * `tests/migrationIndexes.test.js` greps the migration sources with a regex and
 * `tests/migrationRunner.test.js` drives the runner against a mocked
 * `MigrationRecord`. Between them they check that the files say what they are
 * supposed to say and that the runner's control flow branches where it should —
 * neither of which is the thing that goes wrong with a migration. What goes
 * wrong is a server decision: a `partialFilterExpression` MongoDB refuses, an
 * index it will not build, an aggregation `$merge` that needs a unique key that
 * is not there yet, a pipeline `updateMany` the deployed server is too old for.
 * A mock says yes to all of them.
 *
 * `tests/integration/guildIndexMigration.test.js` was the first file to run any
 * migration against a real mongod — two of them, 001 and 015. This runs the
 * whole sequence, in order, against real documents, and then goes back over the
 * runner's own contract — ordering, idempotency, partial failure, rollback —
 * with fixture migrations on disk, because those cases cannot be provoked with
 * the shipped ones.
 *
 * Migrations auto-run at boot and have no rollback path beyond `down()` and the
 * pre-migration backup, so "it applied cleanly against a server" is not a
 * detail these tests could reasonably leave to production.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');

const { useMongo } = require('../helpers/mongo');

useMongo();

const {
    runMigrations, rollbackMigration, pendingMigrationNames, waitForMigrations,
} = require('../../src/migrations/runner');
const MigrationRecord = require('../../src/models/MigrationRecord');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'migrations');

/** Shipped migrations, in the order the runner will apply them. */
function shippedMigrations() {
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.js') && f !== 'runner.js')
        .sort()
        .map(file => require(path.join(MIGRATIONS_DIR, file)));
}

/** Recorded migration names, oldest first. ObjectIds order by creation. */
async function appliedInOrder() {
    return (await MigrationRecord.find({}).sort({ _id: 1 }).lean()).map(r => r.name);
}

const db = () => mongoose.connection.db;
const indexNames = async collection => (await db().collection(collection).indexes()).map(i => i.name).sort();

// ── Fixture migrations on disk ───────────────────────────────────────────────
//
// The runner discovers migrations with readdirSync + require, so provoking a
// failure, an ordering question or a rollback needs real files. They report
// what they did through a global the test reads back, which is the only way to
// see the *order* the runner chose rather than the order it recorded.

const tmpDirs = [];

function migrationSource({ name, body = '', extra = '', down = true }) {
    return `'use strict';
module.exports = {
    name: ${JSON.stringify(name)},
${extra}    async up(options) {
        globalThis.__migrationRuns.push(${JSON.stringify(name)});
        globalThis.__migrationBudgets[${JSON.stringify(name)}] = options?.timeoutMs ?? null;
        ${body}
    },
${down ? `    async down() { globalThis.__migrationRuns.push(${JSON.stringify(name)} + ':down'); },\n` : ''}};
`;
}

/** Writes migration files into a throwaway directory and returns its path. */
function migrationsDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-migrations-'));
    tmpDirs.push(dir);
    for (const [file, source] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, file), source);
    }
    return dir;
}

const savedEnv = {};

beforeAll(() => {
    for (const key of ['MIGRATION_BACKUP', 'MIGRATION_TIMEOUT_MS']) savedEnv[key] = process.env[key];
    // Five of the shipped migrations are irreversible, which is what triggers
    // the pre-migration mongodump. A test run must neither spawn one nor depend
    // on whether this machine has the tool.
    process.env.MIGRATION_BACKUP = 'skip';
    delete process.env.MIGRATION_TIMEOUT_MS;
});

afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    globalThis.__migrationRuns = [];
    globalThis.__migrationBudgets = {};
    globalThis.__migrationFails = new Set();
    // The runner narrates every migration it applies, skips and defers. Useful
    // at boot, noise here — and console.error is asserted on where it matters.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    jest.restoreAllMocks();
    // useMongo clears the collections its models know about; migrations create
    // theirs through the driver, so those are not among them.
    await mongoose.connection.db.dropDatabase();
});

// ── The shipped sequence, end to end ─────────────────────────────────────────

describe('every shipped migration, against a real server', () => {
    test('the whole sequence applies cleanly and records what it applied', async () => {
        const expected = shippedMigrations().map(m => m.name);

        await runMigrations({ dir: MIGRATIONS_DIR });

        // Not a subset and not a set: the order recorded is the order applied,
        // and later migrations undo what earlier ones built.
        expect(await appliedInOrder()).toEqual(expected);
        // An optional migration that fails is deliberately left unrecorded, so
        // a missing name here is a migration a real mongod refused.
        expect(console.error).not.toHaveBeenCalled();
    }, 60_000);

    test('running the sequence twice applies nothing the second time', async () => {
        await runMigrations({ dir: MIGRATIONS_DIR });
        const first = await MigrationRecord.find({}).sort({ _id: 1 }).lean();

        await runMigrations({ dir: MIGRATIONS_DIR });
        const second = await MigrationRecord.find({}).sort({ _id: 1 }).lean();

        // Same documents, not merely the same names: a re-applied migration
        // would write a new record with a new _id and a new appliedAt.
        expect(second.map(r => String(r._id))).toEqual(first.map(r => String(r._id)));
        expect(second.map(r => r.appliedAt.getTime())).toEqual(first.map(r => r.appliedAt.getTime()));
    }, 60_000);

    // Ordering, observed from the outside. 002 and 003 build seven indexes on
    // `users` and 009 drops them; 001 builds `idx_giveaways_active` on `guilds`
    // and 015 drops it. Run in the wrong order every one of those would survive,
    // because the drops would find nothing and the builds would come after.
    test('later migrations undo the earlier ones, which only works in order', async () => {
        await db().collection('users').insertOne({ userId: 'u1', guildId: 'g1' });
        await db().collection('guilds').insertOne({ guildId: 'g1' });

        await runMigrations({ dir: MIGRATIONS_DIR });

        const users = await indexNames('users');
        for (const stale of [
            'idx_hunt_stamina_regen', 'idx_hunt_leaderboard_earned', 'idx_hunt_leaderboard_legendary',
            'idx_fishing_stamina_regen', 'idx_fishing_leaderboard_earned',
            'idx_fishing_leaderboard_legendary', 'idx_fishing_last_cast',
        ]) {
            expect(users).not.toContain(stale);
        }
        expect(await indexNames('guilds')).not.toContain('idx_giveaways_active');
    }, 60_000);

    // The one index a correctness argument rests on: the action lock's
    // "already held" signal is the server rejecting a duplicate insert.
    test('012 leaves an activelocks key index the server will actually enforce', async () => {
        await runMigrations({ dir: MIGRATIONS_DIR });

        await db().collection('activelocks').insertOne({ key: 'g1:u1:fish', expiresAt: new Date(Date.now() + 60_000) });

        await expect(
            db().collection('activelocks').insertOne({ key: 'g1:u1:fish', expiresAt: new Date(Date.now() + 60_000) }),
        ).rejects.toMatchObject({ code: 11000 });
    }, 60_000);

    test('014 leaves itemimages keyed per guild, so two guilds can hold the same item', async () => {
        await runMigrations({ dir: MIGRATIONS_DIR });
        const images = db().collection('itemimages');

        await images.insertOne({ guildId: 'g1', itemId: 'sword', imageData: Buffer.from('a') });
        await images.insertOne({ guildId: 'g2', itemId: 'sword', imageData: Buffer.from('b') });

        await expect(
            images.insertOne({ guildId: 'g1', itemId: 'sword', imageData: Buffer.from('c') }),
        ).rejects.toMatchObject({ code: 11000 });
    }, 60_000);
});

// ── The shipped sequence, over documents that predate it ─────────────────────

describe('the data migrations, over pre-migration documents', () => {
    // Seeded through the driver rather than the models on purpose: these are
    // shapes the current schemas no longer describe, so Mongoose would strip
    // exactly the fields the migration exists to deal with.
    async function seed() {
        await db().collection('users').insertMany([
            {
                userId: 'u1', guildId: 'g1', balance: -50, bank: -10,
                lastWheelSpin: new Date('2024-01-01T00:00:00Z'),
                fishing: { xp: 10, totalEarned: 500, gear: ['rod'] },
                hunt:    { xp: 3, totalEarned: 20 },
                pets: [{ petId: 'cat', lastFed: new Date('2024-01-01T00:00:00Z'), starvingStartAt: new Date('2024-01-02T00:00:00Z') }],
                inventory: [
                    { itemId: 'sword', quantity: 1 },
                    { itemId: 'shield', quantity: 4 },
                    { itemId: 'sword', quantity: 2 },
                ],
            },
            { userId: 'u2', guildId: 'g1', balance: 25, bank: 0, inventory: [{ itemId: 'potion', quantity: 1 }] },
        ]);

        await db().collection('guilds').insertOne({
            guildId: 'g1',
            economy: { wheelEnabled: true, wheelCooldownHours: 6, wheelExtraSpinCost: 100, currency: '💰' },
            analytics: {
                memberEvents: [{ date: '2024-01-01', joins: 2, leaves: 1 }],
                commandUsage: [{ command: 'fish', hour: 3, success: true }],
            },
        });

        // The pre-#561 shape: no guildId, and the single-field unique index
        // Mongoose built from `unique: true` on itemId.
        await db().collection('itemimages').insertOne({ itemId: 'sword', imageData: Buffer.from('a') });
        await db().collection('itemimages').createIndex({ itemId: 1 }, { name: 'itemId_1', unique: true });

        // The single-field index 016 exists to drop.
        await db().collection('fishingtournaments').insertOne({ guildId: 'g1', status: 'ended' });
        await db().collection('fishingtournaments').createIndex({ guildId: 1 }, { name: 'guildId_1' });
    }

    const user = id => db().collection('users').findOne({ userId: id });

    test('005 moves grind state into its own collection and clears the source', async () => {
        await seed();

        await runMigrations({ dir: MIGRATIONS_DIR });

        const moved = await user('u1');
        expect(moved.fishing).toBeUndefined();
        expect(moved.hunt).toBeUndefined();

        const profiles = await db().collection('grindprofiles')
            .find({ userId: 'u1' }).sort({ system: 1 }).toArray();
        expect(profiles.map(p => p.system)).toEqual(['fishing', 'hunt']);
        expect(profiles[0].data).toEqual({ xp: 10, totalEarned: 500, gear: ['rod'] });
        expect(profiles[0].guildId).toBe('g1');
    }, 60_000);

    // $merge with whenMatched: 'keepExisting' is the whole idempotency claim,
    // and it needs the unique index the migration builds first.
    test('005 leaves a profile written since the move alone on a re-run', async () => {
        await seed();
        await runMigrations({ dir: MIGRATIONS_DIR });

        await db().collection('grindprofiles').updateOne(
            { userId: 'u1', system: 'fishing' },
            { $set: { 'data.xp': 999 } },
        );
        await db().collection('users').updateOne({ userId: 'u1' }, { $set: { fishing: { xp: 1 } } });
        await require('../../src/migrations/005_grind_profiles').up({ timeoutMs: 30_000 });

        const profile = await db().collection('grindprofiles').findOne({ userId: 'u1', system: 'fishing' });
        expect(profile.data.xp).toBe(999);
        expect((await user('u1')).fishing).toBeUndefined();
    }, 60_000);

    test('006 drops the wheel fields from both collections', async () => {
        await seed();

        await runMigrations({ dir: MIGRATIONS_DIR });

        expect((await user('u1')).lastWheelSpin).toBeUndefined();
        const guild = await db().collection('guilds').findOne({ guildId: 'g1' });
        expect(guild.economy.wheelEnabled).toBeUndefined();
        expect(guild.economy.wheelCooldownHours).toBeUndefined();
        expect(guild.economy.wheelExtraSpinCost).toBeUndefined();
        // Only the wheel fields: the rest of the economy settings stay.
        expect(guild.economy.currency).toBe('💰');
    }, 60_000);

    test('008 gives every existing pet a decay cursor and clears its starvation clock', async () => {
        await seed();
        const before = Date.now();

        await runMigrations({ dir: MIGRATIONS_DIR });

        const [pet] = (await user('u1')).pets;
        expect(pet.lastDecayAt).toBeInstanceOf(Date);
        expect(pet.lastDecayAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(pet.starvingStartAt).toBeNull();
    }, 60_000);

    test('010 folds duplicate inventory slots together without losing quantity', async () => {
        await seed();

        await runMigrations({ dir: MIGRATIONS_DIR });

        const { inventory } = await user('u1');
        // One slot per itemId, in the order the slots first appeared, carrying
        // the summed quantity — the second sword slot was unspendable, since
        // every reader takes the first match.
        expect(inventory.map(i => [i.itemId, i.quantity])).toEqual([['sword', 3], ['shield', 4]]);
        // A document with no duplicates is not rewritten at all.
        expect((await user('u2')).inventory).toEqual([{ itemId: 'potion', quantity: 1 }]);
    }, 60_000);

    test('011 raises negative balances to zero and leaves healthy ones alone', async () => {
        await seed();

        await runMigrations({ dir: MIGRATIONS_DIR });

        expect(await user('u1')).toMatchObject({ balance: 0, bank: 0 });
        expect(await user('u2')).toMatchObject({ balance: 25, bank: 0 });
    }, 60_000);

    test('013 moves guild analytics into their own collection', async () => {
        await seed();

        await runMigrations({ dir: MIGRATIONS_DIR });

        expect((await db().collection('guilds').findOne({ guildId: 'g1' })).analytics).toBeUndefined();
        const analytics = await db().collection('guildanalytics').findOne({ guildId: 'g1' });
        expect(analytics.memberEvents).toEqual([{ date: '2024-01-01', joins: 2, leaves: 1 }]);
        expect(analytics.commandUsage).toEqual([{ command: 'fish', hour: 3, success: true }]);
    }, 60_000);

    test('014 re-keys the shared item images and drops the index that blocked it', async () => {
        await seed();

        await runMigrations({ dir: MIGRATIONS_DIR });

        // Left as the shared fallback rather than assigned to a guild: nothing
        // records who uploaded it.
        expect(await db().collection('itemimages').findOne({ itemId: 'sword' })).toMatchObject({ guildId: null });
        const names = await indexNames('itemimages');
        expect(names).not.toContain('itemId_1');
        expect(names).toContain('idx_itemimage_guild_item');
    }, 60_000);

    test('016 swaps the tournament index for the compound one', async () => {
        await seed();

        await runMigrations({ dir: MIGRATIONS_DIR });

        const names = await indexNames('fishingtournaments');
        expect(names).not.toContain('guildId_1');
        expect(names).toContain('idx_tournament_guild_status');
    }, 60_000);

    // The claim every one of the above rests on: applying twice is applying
    // once. Here the second pass is forced past the MigrationRecord skip, so
    // the migrations themselves have to be idempotent rather than merely
    // unreachable.
    test('re-applying every migration over its own output changes nothing', async () => {
        await seed();
        await runMigrations({ dir: MIGRATIONS_DIR });

        const snapshot = async () => ({
            // 008 stamps every pet's `lastDecayAt` with the time it runs, on
            // purpose — a pet last fed six months ago must not be retroactively
            // starved — so that one field is expected to move under a forced
            // second pass. Its MigrationRecord is what stops that happening for
            // real; everything else here has to be idempotent on its own.
            users: (await db().collection('users').find({}).sort({ userId: 1 }).toArray())
                .map(u => ({ ...u, pets: (u.pets ?? []).map(({ lastDecayAt, ...pet }) => pet) })),
            guilds: await db().collection('guilds').find({}).toArray(),
            profiles: await db().collection('grindprofiles').find({}).sort({ system: 1 }).toArray(),
            analytics: await db().collection('guildanalytics').find({}).toArray(),
            images: await db().collection('itemimages').find({}).toArray(),
        });

        const before = await snapshot();
        await MigrationRecord.deleteMany({});
        await runMigrations({ dir: MIGRATIONS_DIR });

        expect(await snapshot()).toEqual(before);
        expect(console.error).not.toHaveBeenCalled();
    }, 60_000);
});

// ── The runner's own contract ────────────────────────────────────────────────

describe('ordering', () => {
    test('applies by filename, not by directory order', async () => {
        // Written out of order, and readdirSync is free to hand them back in
        // this order — the sort in loadMigrations is the only thing that makes
        // 002 a promise about what has already run.
        const dir = migrationsDir({
            '030_c.js': migrationSource({ name: 'c' }),
            '002_a.js': migrationSource({ name: 'a' }),
            '010_b.js': migrationSource({ name: 'b' }),
        });

        await runMigrations({ dir });

        expect(globalThis.__migrationRuns).toEqual(['a', 'b', 'c']);
        expect(await appliedInOrder()).toEqual(['a', 'b', 'c']);
    });

    test('a migration already recorded is not run again', async () => {
        const dir = migrationsDir({
            '001_a.js': migrationSource({ name: 'a' }),
            '002_b.js': migrationSource({ name: 'b' }),
        });
        await MigrationRecord.create({ name: 'a' });

        await runMigrations({ dir });

        expect(globalThis.__migrationRuns).toEqual(['b']);
    });

    test('a file that does not export { name, up } is skipped, not recorded', async () => {
        const dir = migrationsDir({
            '001_a.js': migrationSource({ name: 'a' }),
            '002_junk.js': "'use strict';\nmodule.exports = { name: 'junk' };\n",
        });

        await runMigrations({ dir });

        expect(await appliedInOrder()).toEqual(['a']);
        // And pendingMigrationNames has to agree, or every non-primary shard
        // waits for a migration that will never be recorded.
        expect(await pendingMigrationNames({ dir })).toEqual([]);
    });

    test('an empty directory is not an error', async () => {
        await expect(runMigrations({ dir: migrationsDir({}) })).resolves.toBeUndefined();
        expect(await appliedInOrder()).toEqual([]);
    });
});

describe('failure recovery', () => {
    test('a failed migration aborts the run, keeps what applied, and resumes next time', async () => {
        const dir = migrationsDir({
            '001_a.js': migrationSource({ name: 'a' }),
            '002_b.js': migrationSource({ name: 'b', body: "if (globalThis.__migrationFails.has('b')) throw new Error('boom');" }),
            '003_c.js': migrationSource({ name: 'c' }),
        });
        globalThis.__migrationFails.add('b');

        await expect(runMigrations({ dir })).rejects.toThrow('boom');

        // c never ran: booting on a half-applied schema is the thing the throw
        // is protecting against, so nothing after the failure is attempted.
        expect(globalThis.__migrationRuns).toEqual(['a', 'b']);
        expect(await appliedInOrder()).toEqual(['a']);
        expect(await pendingMigrationNames({ dir })).toEqual(['b', 'c']);

        globalThis.__migrationFails.delete('b');
        globalThis.__migrationRuns = [];

        await runMigrations({ dir });

        // a is not re-run — the record is what makes a resumed boot safe.
        expect(globalThis.__migrationRuns).toEqual(['b', 'c']);
        expect(await appliedInOrder()).toEqual(['a', 'b', 'c']);
    });

    test('an optional migration that fails is left unrecorded and retried on the next run', async () => {
        const dir = migrationsDir({
            '001_a.js': migrationSource({ name: 'a' }),
            '002_b.js': migrationSource({
                name: 'b', extra: '    optional: true,\n',
                body: "if (globalThis.__migrationFails.has('b')) throw new Error('index build refused');",
            }),
            '003_c.js': migrationSource({ name: 'c' }),
        });
        globalThis.__migrationFails.add('b');

        // A performance index is not worth refusing to boot over.
        await expect(runMigrations({ dir })).resolves.toBeUndefined();

        expect(globalThis.__migrationRuns).toEqual(['a', 'b', 'c']);
        expect(await appliedInOrder()).toEqual(['a', 'c']);
        // Not pending, though: another shard must not refuse to start over an
        // index the bot is merely faster with.
        expect(await pendingMigrationNames({ dir })).toEqual([]);

        globalThis.__migrationRuns = [];
        await runMigrations({ dir });

        expect(globalThis.__migrationRuns).toEqual(['b']);
        expect(await appliedInOrder()).toEqual(['a', 'c']);

        globalThis.__migrationFails.delete('b');
        globalThis.__migrationRuns = [];
        await runMigrations({ dir });

        expect(await appliedInOrder()).toEqual(['a', 'c', 'b']);
    });

    test('a migration that hangs past its budget fails rather than holding the boot open', async () => {
        const dir = migrationsDir({
            '001_a.js': migrationSource({ name: 'a' }),
            '002_slow.js': migrationSource({ name: 'slow', body: 'await new Promise(() => {});' }),
        });
        process.env.MIGRATION_TIMEOUT_MS = '60';

        try {
            await expect(runMigrations({ dir })).rejects.toThrow(/Timed out after 60ms: slow/);
        } finally {
            delete process.env.MIGRATION_TIMEOUT_MS;
        }

        expect(await appliedInOrder()).toEqual(['a']);
    });

    test('the budget in force is handed to the migration, so it can bound its own queries', async () => {
        const dir = migrationsDir({
            '001_a.js': migrationSource({ name: 'a' }),
            // Declares more than the operator asked for; the larger wins, or
            // raising the env var would be powerless against the migration
            // that is timing out.
            '002_heavy.js': migrationSource({ name: 'heavy', extra: '    timeoutMs: 90_000,\n' }),
        });
        process.env.MIGRATION_TIMEOUT_MS = '45000';

        try {
            await runMigrations({ dir });
        } finally {
            delete process.env.MIGRATION_TIMEOUT_MS;
        }

        expect(globalThis.__migrationBudgets).toEqual({ a: 45_000, heavy: 90_000 });
    });
});

describe('rollback, against a real server', () => {
    const reversiblePair = () => migrationsDir({
        '001_a.js': migrationSource({ name: 'a' }),
        '002_b.js': migrationSource({ name: 'b' }),
    });

    test('unwinds the most recent migration and forgets it', async () => {
        const dir = reversiblePair();
        await runMigrations({ dir });
        globalThis.__migrationRuns = [];

        await rollbackMigration('b', { dir });

        expect(globalThis.__migrationRuns).toEqual(['b:down']);
        expect(await appliedInOrder()).toEqual(['a']);
    });

    test('the next run re-applies what was rolled back', async () => {
        const dir = reversiblePair();
        await runMigrations({ dir });
        await rollbackMigration('b', { dir });
        globalThis.__migrationRuns = [];

        await runMigrations({ dir });

        expect(globalThis.__migrationRuns).toEqual(['b']);
        expect(await appliedInOrder()).toEqual(['a', 'b']);
    });

    // Later migrations may build on what an earlier one wrote, so the chain
    // unwinds in reverse, one invocation at a time.
    test('refuses anything but the most recent', async () => {
        const dir = reversiblePair();
        await runMigrations({ dir });

        await expect(rollbackMigration('a', { dir })).rejects.toThrow(/roll back b first/);
        expect(await appliedInOrder()).toEqual(['a', 'b']);
    });

    test('refuses a migration that was never applied', async () => {
        const dir = reversiblePair();

        await expect(rollbackMigration('a', { dir })).rejects.toThrow(/not recorded as applied/);
    });

    test('refuses a name no file declares', async () => {
        await expect(rollbackMigration('nope', { dir: reversiblePair() })).rejects.toThrow(/No migration named/);
    });

    // The way back from one of these is the pre-migration backup, which is why
    // declaring it is what makes the runner take one.
    test('refuses an irreversible migration and leaves it applied', async () => {
        const dir = migrationsDir({
            '001_a.js': migrationSource({ name: 'a' }),
            '002_gone.js': migrationSource({ name: 'gone', extra: '    irreversible: true,\n', down: false }),
        });
        await runMigrations({ dir });

        await expect(rollbackMigration('gone', { dir })).rejects.toThrow(/irreversible/);
        expect(await appliedInOrder()).toEqual(['a', 'gone']);
    });
});

describe('waiting for another process to migrate', () => {
    test('reports the shipped migrations as pending until they are applied', async () => {
        // Optional ones are excluded by design: they are left unrecorded when
        // they fail, so a shard waiting on one would wait forever.
        const expected = shippedMigrations().filter(m => !m.optional).map(m => m.name);

        expect(await pendingMigrationNames({ dir: MIGRATIONS_DIR })).toEqual(expected);

        await runMigrations({ dir: MIGRATIONS_DIR });

        expect(await pendingMigrationNames({ dir: MIGRATIONS_DIR })).toEqual([]);
    }, 60_000);

    test('returns as soon as everything is recorded', async () => {
        const dir = migrationsDir({ '001_a.js': migrationSource({ name: 'a' }) });
        await runMigrations({ dir });

        await expect(waitForMigrations({ dir, timeoutMs: 5_000, pollMs: 10 })).resolves.toBe(true);
    });

    test('gives up rather than blocking a boot forever', async () => {
        const dir = migrationsDir({ '001_a.js': migrationSource({ name: 'a' }) });

        await expect(waitForMigrations({ dir, timeoutMs: 50, pollMs: 10 })).resolves.toBe(false);
        expect(console.error.mock.calls.flat().join(' ')).toContain('Gave up');
    });
});
