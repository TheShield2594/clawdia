const { Schema, model } = require('mongoose');

/**
 * A wagered member pet battle whose stakes may be in escrow (#1184).
 *
 * The pet-battle stakes are guarded debits rather than keyed ones, so nothing
 * on the user documents says a stake was taken for a battle. Each stake is
 * added to `stakes` the moment its debit lands, and
 * `services/petBattleEscrowSweep.js` reads the entries older than any live
 * battle can be. A battle that settled — a payout, a refund or an owed record
 * under its `pet:battle:{battleId}:` keys — is deleted; one that did not has
 * every recorded stake handed back through the keyed refund, which cannot pay
 * twice.
 *
 * A normal settlement deletes its own entry; the sweep is for the process that
 * died mid-battle, during the stance rounds that hold the stakes.
 */
const pendingPetBattleSchema = new Schema({
    battleId:     { type: String, required: true },
    guildId:      { type: String, required: true },
    challengerId: { type: String, required: true },
    opponentId:   { type: String, required: true },
    amount:       { type: Number, required: true, min: 1 },
    // The user ids whose stake debit landed.
    stakes:       { type: [String], default: [] },
    createdAt:    { type: Date, default: Date.now },
});

pendingPetBattleSchema.index({ battleId: 1 }, { unique: true });
// The sweep's age query, and a backstop for entries it could never settle.
pendingPetBattleSchema.index({ createdAt: 1 }, { name: 'pending_pet_battle_ttl', expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = model('PendingPetBattle', pendingPetBattleSchema);
