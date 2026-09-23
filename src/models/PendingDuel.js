const { Schema, model } = require('mongoose');

/**
 * A duel whose stakes may be in escrow (#873, the duel restart sweep).
 *
 * Written when a challenge is accepted, before either stake is taken, so a
 * process that dies anywhere between the escrow and the settlement leaves this
 * behind. `services/duelEscrowSweep.js` reads it once it is older than any live
 * duel can be, checks whether the duel settled, and hands back the stakes of one
 * that did not. The settlement never has to remove it: the sweep checks every
 * entry against the duel's own payout, refund and owed records, and deletes the
 * ones that settled.
 *
 * It exists because nothing else names a duel in flight. The escrow is two keyed
 * debits on two user documents (`duel:{duelId}:escrow:{userId}` in
 * `spentDebits`), and finding those means scanning every user's debit keys;
 * this is the index into them, and it carries the stake a reversal needs.
 */
const pendingDuelSchema = new Schema({
    duelId:       { type: String, required: true },
    guildId:      { type: String, required: true },
    challengerId: { type: String, required: true },
    opponentId:   { type: String, required: true },
    amount:       { type: Number, required: true, min: 1 },
    createdAt:    { type: Date, default: Date.now },
});

pendingDuelSchema.index({ duelId: 1 }, { unique: true });
// Serves the sweep's age query, and is a backstop, not the schedule: the sweep deletes every entry it settles within
// minutes. What the TTL removes is what the sweep could not reach in a week, by
// which time the escrow keys it would have needed (kept for 24 hours) are gone.
pendingDuelSchema.index({ createdAt: 1 }, { name: 'pending_duel_ttl', expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = model('PendingDuel', pendingDuelSchema);
