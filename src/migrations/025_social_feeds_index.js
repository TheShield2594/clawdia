const mongoose = require('mongoose');

// Social-media notifications add a `socialFeeds` array to guild documents, and
// socialService.checkSocialFeeds sweeps for the few guilds that have one with
// `Guild.find({ 'socialFeeds.0': { $exists: true } })`. The schema declares the
// matching sparse index (idx_guilds_socialfeeds) so a fresh database gets it
// from autoIndex; this builds it under the same name for a deployment that
// already exists, exactly as 001 did for idx_guilds_rssfeeds.
//
// Same ensureIndex helper as 001: if an index with this key already exists under
// a different (auto-generated) name it is dropped so the named version can be
// created. Safe to re-run.
async function ensureIndex(collection, keys, options) {
    let existing = [];
    try {
        existing = await collection.indexes();
    } catch (err) {
        // NamespaceNotFound (26): collection does not exist yet — createIndex
        // below creates it implicitly.
        if (err && err.code !== 26) throw err;
    }

    if (existing.find(i => i.name === options.name)) return;

    const conflict = existing.find(i => {
        const ik = Object.keys(i.key);
        const kk = Object.keys(keys);
        return ik.length === kk.length && ik.every((k, idx) => k === kk[idx] && String(i.key[k]) === String(keys[k]));
    });
    if (conflict) await collection.dropIndex(conflict.name);

    await collection.createIndex(keys, options);
}

module.exports = {
    name: '025_social_feeds_index',

    // An index build makes an existing query faster and is load-bearing for
    // nothing; refusing to boot over a slow build trades a slow bot for no bot.
    // Left unrecorded on failure, so the next boot retries.
    optional: true,

    async up() {
        const db = mongoose.connection.db;
        await ensureIndex(
            db.collection('guilds'),
            { 'socialFeeds.0': 1 },
            { name: 'idx_guilds_socialfeeds', sparse: true }
        );
    },

    async down() {
        const db = mongoose.connection.db;
        await db.collection('guilds').dropIndex('idx_guilds_socialfeeds').catch(err => {
            // Already gone, or the collection was never created.
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });
    },
};
