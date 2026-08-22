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
const grindProfileSchema = new Schema({
    userId:  { type: String, required: true },
    guildId: { type: String, required: true },
    system:  { type: String, required: true, enum: ['fishing', 'hunt', 'mining', 'exploration'] },
    data:    { type: Schema.Types.Mixed, default: undefined },
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

module.exports = model('GrindProfile', grindProfileSchema);
