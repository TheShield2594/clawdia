// itemId is the canonical snake_case identifier stored in user.inventory.
// name is the display label shown to users in /shop view.
// lore is short flavor text (1-2 sentences) shown in shop detail / inventory.
// rarity: Common → Uncommon → Rare → Epic → Mythic
// category: 'standard' (default) | 'prestige' (aspiration/high-cost items)
const DEFAULT_SHOP_ITEMS = [
    { name: 'Padlock',            itemId: 'padlock',           rarity: 'Rare',     price: 5000,  description: '🔒 Protects your bank from /rob — only your wallet is at risk.', lore: "The combination is your deepest secret. Or 1234. One of those." },
    { name: 'Shield',             itemId: 'shield',            rarity: 'Mythic',   price: 10000, description: '🛡️ Blocks all /rob attempts against you for 12 hours.',          lore: "Dented in several suspicious places. Still works." },
    { name: 'Invisibility Cloak', itemId: 'invisibility_cloak',rarity: 'Epic',     price: 7500,  description: '🧥 Hides you from /rob targeting for 6 hours.',                   lore: "It only works if you believe in it. Robbers, inexplicably, do not." },
    { name: 'Knife',              itemId: 'knife',             rarity: 'Uncommon', price: 3000,  description: '🔪 +15% /rob success chance for 1 hour.',                          lore: "Not for cooking. Definitely not for cooking." },
    { name: 'Robbery Bag',        itemId: 'robbery_bag',       rarity: 'Uncommon', price: 3500,  description: '💼 +10% coins stolen on successful /rob attempts for 1 hour.',     lore: "Surprisingly roomy. Comes pre-stained with someone else's misfortune." },
    { name: 'Lifesaver',          itemId: 'lifesaver',         rarity: 'Rare',     price: 15000, description: '🛟 Absorbs the next /rob fine or /crime loss — one-time use.',     lore: "Inexplicably shows up right when you need it most. Nobody knows where it comes from." },
    { name: 'Lucky Charm',        itemId: 'lucky_charm',       rarity: 'Common',   price: 2000,  description: '🍀 2-hour luck boost across games and /crime (casino saves apply to bets up to 25k).',                    lore: "Found at the bottom of a leprechaun's pocket. Still faintly smells of gold." },
    { name: 'Streak Shield',      itemId: 'streak_shield',     rarity: 'Uncommon', price: 2500,  description: '🔥🛡️ Protects your message streak from one missed day.',          lore: "A small ember that refuses to go out, no matter how bad your week gets." },
    { name: '2x Coin Booster',    itemId: 'coin_booster_2x',   rarity: 'Uncommon', price: 2500,  description: '💰🚀 2x coin earnings from all sources for 1 hour.',               lore: "Temporarily rewires your brain to see money everywhere. Side effects may include greed." },
    { name: '2x XP Booster',      itemId: 'xp_booster_2x',    rarity: 'Uncommon', price: 2500,  description: '⭐🚀 2x XP from chat and activities for 1 hour.',                  lore: "A jolt of clarity disguised as a beverage. Caffeine for the soul." },
    { name: 'Lucky Streak',       itemId: 'lucky_streak',      rarity: 'Common',   price: 1500,  description: '🎯 +25% win chance on games for 30 minutes (casino saves apply to bets up to 25k).',                      lore: "The universe owes you one. This is collecting." },
    { name: 'Salary Raise',       itemId: 'salary_raise',      rarity: 'Rare',     price: 4000,  description: '📈 1.5x earnings on /work shifts for 2 hours.',                    lore: "A briefly forged memo your boss won't remember signing." },
    { name: 'Pet Food',           itemId: 'pet_food',          rarity: 'Common',   price: 250,   description: '🍖 Feeds any pet, restoring 10 hunger (use with /pet feed). Not a favorite food, so no bonus XP boost.', lore: "Generic, slightly bland, and always in stock. Pets prefer their favorites, but won't say no in a pinch." },

    // ── Prestige / Aspiration items ──────────────────────────────────────────
    { name: 'Custom Job Title',       itemId: 'custom_job_title',        rarity: 'Epic',   price: 75000,  category: 'prestige', description: '✏️ Set a custom job title shown on your /profile for 30 days.',     lore: "The business card says whatever you want. Nobody checks." },
    { name: 'VIP Badge',              itemId: 'vip_badge',               rarity: 'Epic',   price: 150000, category: 'prestige', description: '💎 Grants the server\'s VIP role for 30 days.',                        lore: "The velvet rope parts. You walk through." },
    { name: 'Golden Profile Frame',   itemId: 'golden_profile_frame',    rarity: 'Mythic', price: 250000, category: 'prestige', description: '🖼️ Gold border and accent color on your /profile for 30 days.',     lore: "Subtle enough to be classy. Loud enough to be noticed." },
    { name: 'Server Trophy',          itemId: 'server_trophy',           rarity: 'Mythic', price: 500000, category: 'prestige', description: '🏆 Your name displayed as Top Earner in a pinned embed for 7 days.', lore: "Seven days. Your name. The whole server looking." },
    { name: 'Zone Unlock Token',      itemId: 'zone_unlock_token',       rarity: 'Rare',   price: 80000,  category: 'prestige', description: '🗺️ Unlock any hunt/fish/mine zone regardless of level.',             lore: "The gatekeepers step aside. Turns out coin is the key." },
    { name: 'Pet Slot Expansion',     itemId: 'pet_slot_expansion',      rarity: 'Epic',   price: 60000,  category: 'prestige', description: '🐾 Allows owning one additional pet simultaneously (stackable ×3).', lore: "More companions. More chaos. Entirely worth it." },
    { name: 'Permanent Stamina +1',   itemId: 'permanent_stamina',       rarity: 'Mythic', price: 100000, category: 'prestige', description: '⚡ Permanently increases your max hunt/fish/mine stamina by 1.',     lore: "The grind never ends. At least now you last a little longer." },
    { name: 'Prestige Accelerator',   itemId: 'prestige_accelerator',    rarity: 'Mythic', price: 200000, category: 'prestige', description: '🚀 -20% XP required for your next prestige (one-time use).',         lore: "The shortcut nobody talks about. Until they use it." },

    // ── Endgame Cosmetics (high-value coin sinks, no gameplay advantage) ─────
    { name: 'Diamond Profile Frame',  itemId: 'diamond_profile_frame',  rarity: 'Mythic', price: 1_000_000,  category: 'endgame', description: '💎 Animated diamond border on your /profile for 30 days.',                    lore: "Cut from something rarer than stone. Harder to earn." },
    { name: 'Elite Title: Sovereign', itemId: 'title_sovereign',        rarity: 'Mythic', price: 5_000_000,  category: 'endgame', description: '👑 Displays the title "Sovereign" above your name in /profile for 30 days.',  lore: "The servers bow. Briefly. Then they keep grinding." },
    { name: 'Prestige Aura',          itemId: 'prestige_aura',          rarity: 'Mythic', price: 10_000_000, category: 'endgame', description: '✨ Glowing aura effect on your /profile embed for 30 days.',                   lore: "Not everyone can see it. Everyone can feel it." },
    { name: 'Grand Master Badge',     itemId: 'grand_master_badge',     rarity: 'Mythic', price: 25_000_000, category: 'endgame', description: '🏅 Permanent Grand Master badge shown on your /profile (no expiry).',          lore: "The number on your balance used to scare you. Now it just fuels you." },
    { name: 'Apex Legend Title',      itemId: 'title_apex_legend',      rarity: 'Mythic', price: 50_000_000, category: 'endgame', description: '🌟 Displays "Apex Legend" — the rarest title — on your /profile permanently.', lore: "There are Diamond-prestige players. Then there is you." },

    // ── Black Market (Prestige I+ only) ──────────────────────────────────────
    { name: 'Phantom Token',          itemId: 'phantom_token',           rarity: 'Mythic', price: 120000, category: 'black_market', description: '👻 Skip the next /rob fine you would owe — undetectable.',         lore: "It wasn't you. It was never you." },
    { name: 'Silvered Talisman',      itemId: 'silvered_talisman',       rarity: 'Mythic', price: 180000, category: 'black_market', description: '🪙 Doubles coin yield from your next 5 hunts, fishes, or mines.',   lore: "Pawned by a stranger. Repurchased by you. The cycle continues." },
    { name: 'Black Market Contract',  itemId: 'black_market_contract',   rarity: 'Mythic', price: 350000, category: 'black_market', description: '📜 Grants +1 permanent crime success roll bonus (stackable ×3).',    lore: "Don't ask who signed the other side." },
];

const ITEM_LORE_BY_ID = Object.fromEntries(
    DEFAULT_SHOP_ITEMS.filter(i => i.lore).map(i => [i.itemId, i.lore])
);

// Returns lore string for a given itemId, or empty string if unknown.
function getItemLore(itemId) {
    return ITEM_LORE_BY_ID[itemId] || '';
}

const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Mythic'];

// Returns the rarity tier for an item. Falls back to price-based bucketing for custom items.
function getItemRarity(itemId, price = 0) {
    const meta = DEFAULT_SHOP_ITEMS.find(i => i.itemId === itemId);
    if (meta?.rarity) return meta.rarity;
    if (price <= 2000)   return 'Common';
    if (price <= 3500)   return 'Uncommon';
    if (price <= 6000)   return 'Rare';
    if (price <= 9000)   return 'Epic';
    return 'Mythic';
}

// Returns true if the item is in the prestige/aspiration category.
function isPrestigeItem(itemId) {
    return DEFAULT_SHOP_ITEMS.find(i => i.itemId === itemId)?.category === 'prestige';
}

// Returns true if the item lives in the Black Market tab (unlocked at account prestige 1+).
function isBlackMarketItem(itemId) {
    return DEFAULT_SHOP_ITEMS.find(i => i.itemId === itemId)?.category === 'black_market';
}

// Returns true if the item is in the endgame cosmetics category.
function isEndgameItem(itemId) {
    return DEFAULT_SHOP_ITEMS.find(i => i.itemId === itemId)?.category === 'endgame';
}

// Idempotent: appends any default items missing from the guild's shop and flips
// the seeded flag so an admin can permanently remove items without them
// reappearing. Returns true if the shop was modified (caller should save).
//
// New top-level item categories (e.g. 'black_market' added with the prestige
// system) are backfilled even on already-seeded guilds so existing servers pick
// them up without a manual reseed.
function ensureDefaultShopItems(guildSettings) {
    if (!guildSettings) return false;
    if (!Array.isArray(guildSettings.shop)) guildSettings.shop = [];

    const existingIds   = new Set(guildSettings.shop.map(i => (i.itemId || '').toLowerCase()));
    const existingNames = new Set(guildSettings.shop.map(i => i.name.toLowerCase()));
    const ALWAYS_BACKFILL_CATEGORIES = new Set(['black_market', 'endgame']);
    const ALWAYS_BACKFILL_ITEM_IDS   = new Set(['pet_food']);
    let changed = false;

    if (!guildSettings.shopDefaultsSeeded) {
        for (const item of DEFAULT_SHOP_ITEMS) {
            // Match either canonical itemId or display name — an admin-created
            // item that shares the canonical id must not be duplicated even
            // when its display name differs.
            const id = (item.itemId || '').toLowerCase();
            if (existingIds.has(id) || existingNames.has(item.name.toLowerCase())) continue;
            guildSettings.shop.push({ ...item, roleId: null, stock: -1, imageUrl: '' });
            existingIds.add(id);
            existingNames.add(item.name.toLowerCase());
            changed = true;
        }
        guildSettings.shopDefaultsSeeded = true;
        return true;
    }

    // For seeded guilds, only top up categories that are new to the schema.
    for (const item of DEFAULT_SHOP_ITEMS) {
        if (!ALWAYS_BACKFILL_CATEGORIES.has(item.category) && !ALWAYS_BACKFILL_ITEM_IDS.has(item.itemId)) continue;
        if (existingIds.has(item.itemId.toLowerCase()) || existingNames.has(item.name.toLowerCase())) continue;
        guildSettings.shop.push({ ...item, roleId: null, stock: -1, imageUrl: '' });
        changed = true;
    }
    return changed;
}

module.exports = { DEFAULT_SHOP_ITEMS, ensureDefaultShopItems, getItemLore, getItemRarity, isPrestigeItem, isBlackMarketItem, isEndgameItem, RARITY_ORDER };
