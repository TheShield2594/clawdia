const User = require('../models/User');
const { logTransaction } = require('./logTransaction');

const STARTER_COINS = 500;
const STARTER_ITEMS = [
    { itemId: 'lifesaver',    quantity: 1 },
    { itemId: 'lucky_charm',  quantity: 1 },
];

/**
 * Atomically claims the starter kit for a new user.
 * Returns { coins } on success, or null if already claimed.
 */
async function claimStarterKit(userId, guildId) {
    const updated = await User.findOneAndUpdate(
        { userId, guildId, 'onboarding.starterKitClaimed': { $ne: true } },
        {
            $inc: { balance: STARTER_COINS },
            $set: { 'onboarding.starterKitClaimed': true },
            $push: { inventory: { $each: STARTER_ITEMS } },
        },
        { new: true }
    );

    if (!updated) return null;

    logTransaction({
        userId,
        guildId,
        type: 'starter_kit',
        amount: STARTER_COINS,
        balance: updated.balance,
        note: 'new user starter kit: 500 coins + lifesaver + lucky_charm',
    });

    return { coins: STARTER_COINS };
}

module.exports = { claimStarterKit };
