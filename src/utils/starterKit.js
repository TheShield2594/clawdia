const User = require('../models/User');
const { logTransaction } = require('./logTransaction');
const { inventoryAddStages } = require('./inventoryGrant');

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
    // `starterKitClaimed` still makes the whole update once-only; the items go in
    // through the shared merge expression so a kit handed to someone who already
    // picked up a lifesaver elsewhere bumps their slot instead of adding a second
    // one that every reader would then ignore.
    const updated = await User.findOneAndUpdate(
        { userId, guildId, 'onboarding.starterKitClaimed': { $ne: true } },
        [
            ...inventoryAddStages(STARTER_ITEMS),
            { $set: {
                balance: { $add: [{ $ifNull: ['$balance', 0] }, STARTER_COINS] },
                'onboarding.starterKitClaimed': true,
            } },
        ],
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
