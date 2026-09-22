const { Schema, model } = require('mongoose');

// Recorded telemetry, split out of the Guild document (#612). Guild.js is the
// bot's configuration document and sits on the per-message read path via the
// settings cache; these arrays are append-heavy telemetry that nothing on that
// path reads. Keeping them here means a guild's settings read never pays for
// up to 3000 commandUsage entries, and the per-command metric write never
// contends with `guild.save()` from a settings writer.
//
// One document per guild, same array shapes the Guild document carried, so the
// dashboard's retention/usage computations are unchanged.
const guildAnalyticsSchema = new Schema({
    guildId: { type: String, required: true, unique: true },

    // Per-day join/leave counters, capped at 120 days by the writers' $slice.
    memberEvents: [{
        date: { type: String, required: true },
        joins: { type: Number, default: 0 },
        leaves: { type: Number, default: 0 }
    }],

    // One point-in-time snapshot per UTC day of the three overview KPIs that
    // have no event stream of their own (#1076): economy active-users, AI
    // request volume and the top member level. memberEvents gives Members a
    // week-over-week delta and sparkline because joins/leaves are recorded as
    // they happen; these three are aggregates with nothing to reconstruct a
    // history from, so the daily snapshot job (services/analyticsSnapshotService)
    // writes today's value here and the strip reads a short series back. Capped
    // at 90 days by the writer's $slice, the way memberEvents is capped at 120.
    metricSnapshots: [{
        date: { type: String, required: true },
        economyActiveUsers: { type: Number, default: 0 },
        aiRequests: { type: Number, default: 0 },
        topLevel: { type: Number, default: 0 }
    }],

    // One entry per slash command invocation, capped at 3000 by the writer's
    // $slice — the cap bounds the document the way a TTL would bound a
    // per-event collection.
    commandUsage: [{
        command: { type: String, required: true },
        channelId: { type: String, default: null },
        hour: { type: Number, required: true },
        // UTC day of week, 0 = Sunday … 6 = Saturday (#1015). Added so the
        // Insights weekday heatmap has a day dimension, not just the hour. Null
        // on entries written before this field existed — those cannot be
        // reconstructed (the day they ran is not recorded anywhere else), so the
        // heatmap reads a null weekday as an "unknown" row rather than guessing.
        weekday: { type: Number, default: null },
        success: { type: Boolean, default: true },
        reason: { type: String, default: null },
        createdAt: { type: Date, default: Date.now }
    }]
});

module.exports = model('GuildAnalytics', guildAnalyticsSchema);
