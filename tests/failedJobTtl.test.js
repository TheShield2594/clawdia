'use strict';

// #896: the dead-letter queue's TTL deleted `exhausted` records alongside
// `resolved` ones.
//
// An owed payout that burns through its three attempts is marked `exhausted`
// and left for a human — scripts/replay-owed-payouts.js says so, and
// claimableFilter means the replay itself will not touch one. Nothing else in
// the codebase pays it. So the TTL was, thirty days on, the only thing that
// acted on those records, and what it did was delete them: a player owed coins
// by a failed payout lost the claim with nothing logged and nothing left to
// find.
//
// The index is read off the compiled schema rather than described, so this
// cannot pass on a filter that is written down but malformed, and the migration
// that swaps the old index for it is checked against the same spec — the two
// have to agree or a deployment ends up with one of them.

const fs = require('fs');
const path = require('path');

const failedJobSchema = require('../src/models/FailedJob').schema;
const migration = require('../src/migrations/020_narrow_failed_job_ttl');

const TTL_NAME = 'idx_failedjob_resolved_ttl';
const THIRTY_DAYS = 30 * 24 * 60 * 60;

/** Every declared index as [keys, options], excluding the _id index. */
const declared = failedJobSchema.indexes();
const ttl = declared.find(([, opts]) => opts?.expireAfterSeconds !== undefined);

describe('the failedjobs TTL', () => {
    test('is declared once, on updatedAt, under an explicit name', () => {
        const expiring = declared.filter(([, opts]) => opts?.expireAfterSeconds !== undefined);
        expect(expiring).toHaveLength(1);
        expect(ttl[0]).toEqual({ updatedAt: 1 });
        expect(ttl[1].name).toBe(TTL_NAME);
        expect(ttl[1].expireAfterSeconds).toBe(THIRTY_DAYS);
    });

    // The assertion this file exists for. `{ status: { $in: [...] } }` matching
    // more than one status is how the old one read, and an `$in` that happens
    // to list only 'resolved' would pass a looser check while being one edit
    // away from the bug again.
    test('expires resolved records and nothing else', () => {
        expect(ttl[1].partialFilterExpression).toEqual({ status: 'resolved' });
    });

    // Every other status is an unsettled claim on the bot: pending and retrying
    // are work not yet done, exhausted is a debt waiting for a human.
    test('covers no status that still owes someone something', () => {
        const covered = ttl[1].partialFilterExpression.status;
        for (const status of ['pending', 'retrying', 'exhausted']) {
            expect([status, covered === status]).toEqual([status, false]);
        }
    });

    test('the schema still knows the statuses the filter reasons about', () => {
        expect(failedJobSchema.path('status').enumValues)
            .toEqual(expect.arrayContaining(['pending', 'retrying', 'exhausted', 'resolved']));
    });
});

describe('020_narrow_failed_job_ttl', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'migrations', '020_narrow_failed_job_ttl.js'), 'utf8');

    // Mongoose never drops an index it no longer declares, so a deployment that
    // only got the model change would keep the old TTL and go on deleting
    // exhausted records — the model edit is inert without this drop.
    test('drops the unnamed index Mongoose built from the old declaration', () => {
        expect(source).toContain("dropIndex('updatedAt_1')");
    });

    test('creates the index under the name and options the model declares', () => {
        expect(source).toContain(`name: '${TTL_NAME}'`);
        expect(source).toContain("partialFilterExpression: { status: 'resolved' }");
    });

    test('swallows IndexNotFound so a fresh database is not a failure', () => {
        expect(source).toContain("codeName !== 'IndexNotFound'");
    });

    test('is reversible, and its rollback restores the index it replaced', () => {
        expect(typeof migration.down).toBe('function');
        expect(source).toContain("name: 'updatedAt_1'");
    });

    test('is not optional — a TTL left half-swapped is not something to boot past', () => {
        expect(migration.optional).toBeUndefined();
    });
});
