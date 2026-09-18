const { Schema, model } = require('mongoose');

/**
 * Per-system grind progression, split out of the User document.
 *
 * Fishing, hunting, mining, and exploration each store large nested state
 * (gear arrays, material maps, journals). Living inside the User document they
 * pushed heavy users toward MongoDB's 16MB document limit and made every
 * unrelated command pay to load them. Each system now lives in its own
 * document, loaded only by the commands that need it.
 *
 * `data` is intentionally schemaless (Mixed): each system owns its shape and
 * backfills defaults via its ensure*Data() initializer, exactly as it did when
 * the data lived on User. Callers must markModified('data') before save —
 * src/utils/grindProfile.js handles this.
 */
// Marker for a shop purchase's item grant (#1058). A gathering-shop purchase is
// a debit on User and a grant on this document with no shared key, so a grant
// that committed server-side but lost its response looked identical to one that
// never happened — and the refund ran on both, handing back the coins for an
// item the player kept. The grant now stamps the purchase's key here in the same
// write, so after a lost response the grant's own outcome can be read back
// (utils/shopGrant.js) and the refund gated on a grant that is confirmed absent.
// Bounded per document — a purchase records one, and only the last few need to
// survive to answer the read that follows immediately.
const grantKeySchema = new Schema({
    key: { type: String, required: true },
    at:  { type: Date, default: Date.now },
}, { _id: false });

const grindProfileSchema = new Schema({
    userId:    { type: String, required: true },
    guildId:   { type: String, required: true },
    system:    { type: String, required: true, enum: ['fishing', 'hunt', 'mining', 'exploration'] },
    data:      { type: Schema.Types.Mixed, default: undefined },
    grantKeys: { type: [grantKeySchema], default: undefined },
}, { timestamps: true, minimize: false });

grindProfileSchema.index({ guildId: 1, userId: 1, system: 1 }, { unique: true });
// Leaderboard / "top grinder" lookups
grindProfileSchema.index({ guildId: 1, system: 1, 'data.xp': -1 });
grindProfileSchema.index({ guildId: 1, system: 1, 'data.totalEarned': -1 });
// /hunt records boards — one index per sort path, matching the reads in
// executeRecords (hunt/profile.js). prestige and level share one compound index
// because they are always sorted together.
grindProfileSchema.index({ guildId: 1, system: 1, 'data.bestPayout': -1 });
grindProfileSchema.index({ guildId: 1, system: 1, 'data.legendaryKills': -1 });
grindProfileSchema.index({ guildId: 1, system: 1, 'data.eventKills': -1 });
grindProfileSchema.index({ guildId: 1, system: 1, 'data.prestige': -1, 'data.level': -1 });
grindProfileSchema.index({ guildId: 1, system: 1, 'data.totalHunts': -1 });
// All-time grind leaderboard (#1016): highest track level first, lifetime coins
// (`data.totalEarned`) as the tiebreak. Serves the bounded top-10 sort in
// utils/grindLeaderboard.js so the board is an index scan, not a collection sort.
grindProfileSchema.index({ guildId: 1, system: 1, 'data.level': -1, 'data.totalEarned': -1 });

module.exports = model('GrindProfile', grindProfileSchema);
