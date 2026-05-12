const Transaction = require('../models/Transaction');

/**
 * Fire-and-forget transaction log. Never throws — a logging failure must
 * never break the economy command that triggered it.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.guildId
 * @param {string} opts.type       - e.g. 'transfer_send', 'daily', 'deposit'
 * @param {number} opts.amount     - positive = credit, negative = debit
 * @param {number} opts.balance    - wallet balance AFTER the transaction
 * @param {number} [opts.bank]     - bank balance AFTER (if changed)
 * @param {string} [opts.relatedUserId]
 * @param {string} [opts.note]
 */
function logTransaction(opts) {
    Transaction.create(opts).catch(err =>
        console.error('[Transaction] Failed to write audit log:', err.message)
    );
}

module.exports = { logTransaction };
