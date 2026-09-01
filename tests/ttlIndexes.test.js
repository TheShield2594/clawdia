'use strict';

/**
 * #867, and the note it ends on: review every TTL index as a set rather than
 * patching the one that was found.
 *
 * A TTL index is a delete nobody wrote and nobody watches. It fires no Mongoose
 * hook, so a `pre('remove')` cannot compensate for it, and it leaves nothing in
 * the logs. That is fine for a row that is only a record of something that
 * already happened, and it is data loss for a row that some job still has to
 * act on — which is exactly what marketlistings was: a zero-second TTL racing a
 * ten-minute sweep for the document that said a seller was owed their items.
 * The TTL monitor won, and the items ceased to exist.
 *
 * Two properties separate the safe ones from that, and both are checked here
 * over whatever indexes the models happen to declare, so a TTL added later is
 * caught by a test rather than by a player.
 */

const fs = require('fs');
const path = require('path');

const MODELS = path.join(__dirname, '..', 'src', 'models');

/**
 * Every TTL index the models declare, as { model, key, seconds, partial }.
 *
 * Read off the compiled schemas rather than grepped, so an index built from a
 * field-level `expires` or assembled at require time counts the same as a
 * literal `expireAfterSeconds:` in the source.
 */
function ttlIndexes() {
    return fs.readdirSync(MODELS)
        .filter(file => file.endsWith('.js'))
        .flatMap(file => {
            const model = require(path.join(MODELS, file));
            return (model.schema?.indexes?.() ?? [])
                .filter(([, options]) => options?.expireAfterSeconds !== undefined)
                .map(([key, options]) => ({
                    model: file.replace(/\.js$/, ''),
                    key: Object.keys(key).join(','),
                    seconds: options.expireAfterSeconds,
                    partial: options.partialFilterExpression ?? null,
                }));
        });
}

/**
 * The TTLs allowed to delete the instant their field comes due.
 *
 * A zero-grace TTL is only safe where expiry means the row is *already* dead to
 * the code — where nothing is owed, nothing has to run first, and the code does
 * not rely on the TTL for correctness because it compares the timestamp itself.
 * Both entries here are that: a lock is taken over by comparing `expiresAt` at
 * acquire time (utils/activeGameLock.js), and an expired OAuth state is refused
 * on the same comparison. In both cases MongoDB is only reclaiming space behind
 * code that already treats the row as gone.
 *
 * The list is a statement, not a waiver: adding to it means having made that
 * argument for the new row.
 */
const ZERO_GRACE_BY_DESIGN = new Set(['ActiveLock:expiresAt', 'McpOAuthState:expiresAt']);

/**
 * The longest interval any sweep that has to beat a TTL runs at, in seconds.
 * `returnExpiredMarketListings` is the one that does, at every ten minutes.
 */
const SWEEP_INTERVAL_SECONDS = 10 * 60;

describe('every TTL index in the models', () => {
    const indexes = ttlIndexes();

    test('there are some, so a broken enumeration cannot pass silently', () => {
        expect(indexes.length).toBeGreaterThanOrEqual(8);
        expect(indexes.map(i => i.model)).toContain('MarketListing');
    });

    test.each(ttlIndexes().map(i => [`${i.model}:${i.key}`, i]))(
        '%s deletes rows nothing is still waiting to act on',
        (id, index) => {
            if (ZERO_GRACE_BY_DESIGN.has(id)) {
                expect(index.seconds).toBe(0);
                return;
            }

            // Everything else is a retention window. It has to clear the
            // interval of any job that reads the row before it can be deleted,
            // and clear it by enough to survive a backlog or an outage rather
            // than by a single tick — the margin marketlistings had none of.
            expect(index.seconds).toBeGreaterThan(100 * SWEEP_INTERVAL_SECONDS);
        },
    );

    test('the market listing TTL outlives the sweep that returns the items', () => {
        // The regression itself. This was 0 while the sweep ran every ten
        // minutes, so MongoDB destroyed the listing — and with it the only
        // record that the seller was owed anything — first, on the ordinary
        // expiry path.
        const listings = indexes.find(i => i.model === 'MarketListing');
        expect(listings.key).toBe('expiresAt');
        expect(listings.seconds).toBeGreaterThan(SWEEP_INTERVAL_SECONDS);
    });

    test('the failed-job TTL still expires only settled records', () => {
        // #896's fix, pinned here alongside the rest of the set: `exhausted` is
        // an outstanding debt a human has to settle, and an outstanding debt
        // does not expire. Only `resolved` — paid, and now history — does.
        const failedJobs = indexes.find(i => i.model === 'FailedJob');
        expect(failedJobs.partial).toEqual({ status: 'resolved' });
    });
});
