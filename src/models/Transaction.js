const { Schema, model } = require('mongoose');

// Audit log for all economy balance changes.
// Records every credit and debit so suspicious activity can be investigated
// and fraudulent transactions can be identified or rolled back by admins.
const transactionSchema = new Schema({
    userId:    { type: String, required: true },
    guildId:   { type: String, required: true },
    type:      { type: String, required: true }, // 'transfer_send', 'transfer_receive', 'daily', 'work', 'rob', 'duel_win', 'duel_loss', 'gamble', 'shop_buy', 'deposit', 'withdraw', etc.
    amount:    { type: Number, required: true }, // positive = credit, negative = debit
    balance:   { type: Number, required: true }, // wallet balance AFTER the transaction
    bank:      { type: Number, default: null  }, // bank balance AFTER the transaction (null if unchanged)
    relatedUserId: { type: String, default: null }, // e.g. recipient on transfer, opponent on duel
    note:      { type: String, default: null  }, // human-readable detail
    createdAt: { type: Date,   default: Date.now, index: true }
});

transactionSchema.index({ userId: 1, guildId: 1 });
transactionSchema.index({ guildId: 1, createdAt: -1 });

// TTL: auto-delete records older than 90 days to keep collection lean
transactionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = model('Transaction', transactionSchema);
