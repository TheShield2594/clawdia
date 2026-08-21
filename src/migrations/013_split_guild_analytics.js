const mongoose = require('mongoose');

/**
 * Moves the `analytics` subdocument (memberEvents, commandUsage) out of every
 * Guild document into the new GuildAnalytics collection, one document per
 * guild, then removes the field from the source.
 *
 * The Guild document is configuration read on every message via the settings
 * cache; the analytics arrays are append-heavy telemetry that grew to 3000
 * entries per guild and dominated the size of every uncached read and the
 * write contention on `guild.save()`. The writers and dashboard readers were
 * repointed at GuildAnalytics in the same change — after this runs, nothing
 * reads or writes `analytics` on the Guild document.
 *
 * Guilds that already have a GuildAnalytics document (a fresh install that
 * wrote telemetry before this migration ran on an old dump, or a re-run after
 * a partial failure) are not overwritten: the copy is insert-only, and the
 * $unset is applied regardless so the stale source data is dropped either way.
 */
module.exports = {
    name: '013_split_guild_analytics',

    // A scan of every guild document that still carries analytics data, and
    // one insert per match. Small compared to 005/010, but give it the same
    // headroom on grown installs.
    timeoutMs: 120_000,

    async up({ timeoutMs } = {}) {
        const guilds = mongoose.connection.db.collection('guilds');
        // Resolve the target collection through the model so the name cannot
        // drift from what the runtime reads and writes.
        const analyticsCollection = require('../models/GuildAnalytics').collection;

        const bounded = timeoutMs > 0 ? { maxTimeMS: timeoutMs } : {};

        const cursor = guilds.find(
            {
                $or: [
                    { 'analytics.memberEvents.0': { $exists: true } },
                    { 'analytics.commandUsage.0': { $exists: true } },
                ],
            },
            { projection: { guildId: 1, analytics: 1 }, ...bounded },
        );

        let copied = 0;
        for await (const doc of cursor) {
            if (!doc.guildId) continue;
            try {
                await analyticsCollection.insertOne({
                    guildId: doc.guildId,
                    memberEvents: doc.analytics?.memberEvents || [],
                    commandUsage: doc.analytics?.commandUsage || [],
                });
                copied++;
            } catch (err) {
                // Duplicate key: this guild already has a GuildAnalytics
                // document (live writers beat the migration, or a re-run).
                // Keep the newer live data and just drop the stale source.
                if (err?.code !== 11000) throw err;
            }
        }

        const unsetResult = await guilds.updateMany(
            { analytics: { $exists: true } },
            { $unset: { analytics: '' } },
        );

        console.log(
            `[MIGRATIONS] 013: copied analytics for ${copied} guild(s), ` +
            `removed the field from ${unsetResult.modifiedCount} document(s)`
        );
    },
};
