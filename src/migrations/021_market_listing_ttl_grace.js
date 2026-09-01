const mongoose = require('mongoose');

// Kept in step with `EXPIRED_LISTING_GRACE_SECONDS` in models/MarketListing.js
// by tests/migrationIndexes.test.js — a migration that sets a different grace
// from the one the model declares would be undone by the next createIndex.
const GRACE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Gives the marketlistings TTL a grace period, so the sweep that returns items
 * to sellers gets to run before MongoDB destroys the listing.
 *
 * `expiresAt_1` was built with `expireAfterSeconds: 0` (#867). MongoDB's TTL
 * monitor wakes roughly once a minute, so an expired listing was hard-deleted
 * within about a minute. `returnExpiredMarketListings` — which returns the
 * seller's items and is the only thing that does — runs every ten minutes. The
 * TTL monitor won that race for nearly every expiry, and a TTL delete fires no
 * Mongoose hook: no items back, no owed-payout record, nothing in the logs. On
 * the *normal* expiry path, sellers lost their stock silently.
 *
 * collMod rather than drop-and-recreate. `expireAfterSeconds` is the one index
 * option MongoDB can change in place, it is the only thing changing here, and
 * doing it in place means there is never an instant with no TTL on the
 * collection and never an index rebuild over every listing. The index keeps its
 * name and key, so the model's declaration matches it afterwards and autoIndex
 * has nothing to reconcile.
 *
 * Listings already deleted are gone and are not recoverable from here; this
 * stops the next ones going.
 */
module.exports = {
    name: '021_market_listing_ttl_grace',

    async up() {
        const db = mongoose.connection.db;

        // A fresh install has no marketlistings collection — the first `/market
        // list` creates it, and the model's declaration builds the index with
        // the grace already on it. Nothing to convert.
        const [existing] = await db.listCollections({ name: 'marketlistings' }).toArray();
        if (!existing) return;

        const listings = db.collection('marketlistings');
        const before = (await listings.indexes()).find(i => i.name === 'expiresAt_1');

        if (!before) {
            // The collection exists but the index does not — a database that
            // predates it, or one where it was dropped by hand. Build it here
            // rather than leave it to autoIndex, which runs unawaited in the
            // background and would leave the sweep's `expiresAt` query
            // unindexed in the meantime.
            await listings.createIndex({ expiresAt: 1 }, { expireAfterSeconds: GRACE_SECONDS });
        } else if (before.expireAfterSeconds !== GRACE_SECONDS) {
            await db.command({
                collMod: 'marketlistings',
                index: { name: 'expiresAt_1', expireAfterSeconds: GRACE_SECONDS },
            });
        }

        // A TTL still at zero after this would keep deleting listings out from
        // under the sweep, which is the entire reason the migration exists — so
        // it fails the boot rather than reporting a swap that did not happen.
        const after = (await listings.indexes()).find(i => i.name === 'expiresAt_1');
        if (after?.expireAfterSeconds !== GRACE_SECONDS) {
            throw new Error(
                `marketlistings expiresAt_1 still expires after ${after?.expireAfterSeconds}s, not ${GRACE_SECONDS}s — ` +
                'expired listings would be destroyed before their items are returned, so startup must not continue.',
            );
        }
    },

    // The inverse is the zero-grace index this replaces. It is a rollback to a
    // state that loses items, which is what a rollback to the previous release
    // is: the code being rolled back to is the code that shipped the zero.
    async down() {
        const db = mongoose.connection.db;

        const [existing] = await db.listCollections({ name: 'marketlistings' }).toArray();
        if (!existing) return;

        const listings = db.collection('marketlistings');
        if (!(await listings.indexes()).some(i => i.name === 'expiresAt_1')) return;

        await db.command({
            collMod: 'marketlistings',
            index: { name: 'expiresAt_1', expireAfterSeconds: 0 },
        });
    },
};
