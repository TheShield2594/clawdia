// itemId is the canonical snake_case identifier stored in user.inventory.
// name is the display label shown to users in /shop view.
// lore is short flavor text (1-2 sentences) shown in shop detail / inventory.
const DEFAULT_SHOP_ITEMS = [
    { name: 'Padlock',            itemId: 'padlock',           price: 5000,  description: '🔒 Protects your bank from /rob — only your wallet is at risk.', lore: "The combination is your deepest secret. Or 1234. One of those." },
    { name: 'Shield',             itemId: 'shield',            price: 10000, description: '🛡️ Blocks all /rob attempts against you for 12 hours.',          lore: "Dented in several suspicious places. Still works." },
    { name: 'Invisibility Cloak', itemId: 'invisibility_cloak',price: 7500,  description: '🧥 Hides you from /rob targeting for 6 hours.',                   lore: "It only works if you believe in it. Robbers, inexplicably, do not." },
    { name: 'Knife',              itemId: 'knife',             price: 3000,  description: '🔪 +15% /rob success chance for 1 hour.',                          lore: "Not for cooking. Definitely not for cooking." },
    { name: 'Robbery Bag',        itemId: 'robbery_bag',       price: 3500,  description: '💼 +10% coins stolen on successful /rob attempts for 1 hour.',     lore: "Surprisingly roomy. Comes pre-stained with someone else's misfortune." },
    { name: 'Lifesaver',          itemId: 'lifesaver',         price: 4000,  description: '🛟 Absorbs the next /rob fine or /crime loss — one-time use.',     lore: "Inexplicably shows up right when you need it most. Nobody knows where it comes from." },
    { name: 'Lucky Charm',        itemId: 'lucky_charm',       price: 2000,  description: '🍀 2-hour luck boost across games and /crime.',                    lore: "Found at the bottom of a leprechaun's pocket. Still faintly smells of gold." },
    { name: 'Streak Shield',      itemId: 'streak_shield',     price: 2500,  description: '🔥🛡️ Protects your message streak from one missed day.',          lore: "A small ember that refuses to go out, no matter how bad your week gets." },
    { name: '2x Coin Booster',    itemId: 'coin_booster_2x',   price: 2500,  description: '💰🚀 2x coin earnings from all sources for 1 hour.',               lore: "Temporarily rewires your brain to see money everywhere. Side effects may include greed." },
    { name: '2x XP Booster',      itemId: 'xp_booster_2x',     price: 2500,  description: '⭐🚀 2x XP from chat and activities for 1 hour.',                  lore: "A jolt of clarity disguised as a beverage. Caffeine for the soul." },
    { name: 'Lucky Streak',       itemId: 'lucky_streak',      price: 1500,  description: '🎯 +25% win chance on games for 30 minutes.',                      lore: "The universe owes you one. This is collecting." },
    { name: 'Salary Raise',       itemId: 'salary_raise',      price: 4000,  description: '📈 1.5x earnings on /work shifts for 2 hours.',                    lore: "A briefly forged memo your boss won't remember signing." },
];

const ITEM_LORE_BY_ID = Object.fromEntries(
    DEFAULT_SHOP_ITEMS.filter(i => i.lore).map(i => [i.itemId, i.lore])
);

// Returns lore string for a given itemId, or empty string if unknown.
function getItemLore(itemId) {
    return ITEM_LORE_BY_ID[itemId] || '';
}

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

module.exports = { DEFAULT_SHOP_ITEMS, ensureDefaultShopItems, getItemLore };
