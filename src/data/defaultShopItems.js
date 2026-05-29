// itemId is the canonical snake_case identifier stored in user.inventory.
// name is the display label shown to users in /shop view.
const DEFAULT_SHOP_ITEMS = [
    { name: 'Padlock',            itemId: 'padlock',           price: 5000,  description: '🔒 Protects your bank from /rob — only your wallet is at risk.' },
    { name: 'Shield',             itemId: 'shield',            price: 10000, description: '🛡️ Blocks all /rob attempts against you for 12 hours.' },
    { name: 'Invisibility Cloak', itemId: 'invisibility_cloak',price: 7500,  description: '🧥 Hides you from /rob targeting for 6 hours.' },
    { name: 'Knife',              itemId: 'knife',             price: 3000,  description: '🔪 +15% /rob success chance for 1 hour.' },
    { name: 'Robbery Bag',        itemId: 'robbery_bag',       price: 3500,  description: '💼 +10% coins stolen on successful /rob attempts for 1 hour.' },
    { name: 'Lifesaver',          itemId: 'lifesaver',         price: 4000,  description: '🛟 Absorbs the next /rob fine or /crime loss — one-time use.' },
    { name: 'Lucky Charm',        itemId: 'lucky_charm',       price: 2000,  description: '🍀 2-hour luck boost across games and /crime.' },
    { name: 'Streak Shield',      itemId: 'streak_shield',     price: 2500,  description: '🔥🛡️ Protects your message streak from one missed day.' },
    { name: '2x Coin Booster',    itemId: 'coin_booster_2x',   price: 2500,  description: '💰🚀 2x coin earnings from all sources for 1 hour.' },
    { name: '2x XP Booster',      itemId: 'xp_booster_2x',    price: 2500,  description: '⭐🚀 2x XP from chat and activities for 1 hour.' },
    { name: 'Lucky Streak',       itemId: 'lucky_streak',      price: 1500,  description: '🎯 +25% win chance on games for 30 minutes.' },
    { name: 'Salary Raise',       itemId: 'salary_raise',      price: 4000,  description: '📈 1.5x earnings on /work shifts for 2 hours.' },
];

// Idempotent: appends any default items missing from the guild's shop and flips
// the seeded flag so an admin can permanently remove items without them
// reappearing. Returns true if the shop was modified (caller should save).
function ensureDefaultShopItems(guildSettings) {
    if (!guildSettings || guildSettings.shopDefaultsSeeded) return false;

    if (!Array.isArray(guildSettings.shop)) guildSettings.shop = [];
    const existingNames = new Set(guildSettings.shop.map(i => i.name.toLowerCase()));
    let added = false;
    for (const item of DEFAULT_SHOP_ITEMS) {
        if (existingNames.has(item.name.toLowerCase())) continue;
        guildSettings.shop.push({ ...item, roleId: null, stock: -1, imageUrl: '' });
        added = true;
    }
    guildSettings.shopDefaultsSeeded = true;
    return added || true;
}

module.exports = { DEFAULT_SHOP_ITEMS, ensureDefaultShopItems };
