const { Schema, model } = require('mongoose');

// Tracks each player's running total per guild+week+category for the weekly
// champion competition.
//
// This replaced a per-hour, single-leader row (`HourlyWinner`). Two things
// changed with it and they are related: the cadence, because an hourly
// announcement in four categories is four pings an hour in a server that may
// only have a handful of players; and the metric, because a week-long race
// decided by one lucky roll on Monday is not a race at all. So the row is now
// per *user* and accumulates — `total` is the sum of every qualifying run — and
// the champion is whoever tops it when the week closes.
//
// week format:  'YYYY-Www' — ISO-8601 week, UTC, Monday-start (see utils/weeklyChampion)
// category:     'fish' | 'mine' | 'hunt' | 'explore'
// total/best:   rarity score (fish) or payout coins (mine/hunt/explore)
const weeklyChampionSchema = new Schema({
    guildId:     { type: String, required: true },
    week:        { type: String, required: true },
    category:    { type: String, required: true },
    userId:      { type: String, required: true },
    username:    { type: String, required: true },
    total:       { type: Number, default: 0 },
    runs:        { type: Number, default: 0 },
    best:        { type: Number, default: 0 },
    bestDetails: { type: String, default: null },
    // Set on the one row that is crowned when the week is swept. It is the
    // payout claim, so it lives on the winning row rather than on the week.
    rewarded:    { type: Boolean, default: false },
    createdAt:   { type: Date, default: Date.now },
});

// One row per player per category per week — the upsert in
// `addWeeklyChampionProgress` relies on this to collapse concurrent runs into
// a single accumulating document rather than a pile of partial ones.
weeklyChampionSchema.index({ guildId: 1, week: 1, category: 1, userId: 1 }, { unique: true });
// Serves both the live leader footer and the end-of-week sweep, which read the
// same thing: the highest total in a guild's category for a given week.
weeklyChampionSchema.index({ guildId: 1, week: 1, category: 1, total: -1 });
weeklyChampionSchema.index({ week: 1 });
// Long enough that a week is still whole when the Monday sweep reads it, and
// that a sweep delayed by an outage has something left to read.
weeklyChampionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 21 * 24 * 3600 });

module.exports = model('WeeklyChampion', weeklyChampionSchema);
