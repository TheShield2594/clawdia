// Locals for rendering views/guild-settings.ejs outside of Express, assembled
// the same way routes/dashboard.js assembles them.
const Guild = require('../../src/models/Guild');
const DEFAULT_JOBS = require('../../src/data/defaultJobs');
const DEFAULT_TIERS = require('../../src/data/defaultTiers');
const { ACHIEVEMENTS } = require('../../src/data/achievements');
const { ensureDefaultShopItems } = require('../../src/data/defaultShopItems');
const { WEAPON_TIERS, AMMO_PACKS, CONSUMABLES: HUNT_CONSUMABLES, WEAPON_UPGRADES } = require('../../src/data/huntData');
const { ROD_TIERS, BAIT_PACKS, CONSUMABLES: FISH_CONSUMABLES, ROD_UPGRADES } = require('../../src/data/fishData');
const { PICKAXE_TIERS, BLAST_PACKS, CONSUMABLES: MINE_CONSUMABLES, PICKAXE_UPGRADES } = require('../../src/data/mineData');
const { REGION_LIST } = require('../../src/data/exploreData');
const { SEASONAL_EVENTS } = require('../../src/data/seasonalEvents');
const { jsonForScript } = require('../../src/dashboard/lib/jsonForScript');
const { asset } = require('../../src/dashboard/lib/assets');

const toItem = (ns, item, idField = 'id') => ({
    id: `${ns}:${item[idField]}`,
    label: item.name,
    emoji: item.emoji || '📦',
    hasImage: false,
});

function guildSettingsLocals(overrides = {}) {
    const doc = new Guild({ guildId: '123456789012345678', name: 'Test Guild' });
    ensureDefaultShopItems(doc);

    return {
        user: { id: '1', username: 'tester' },
        guild: { id: '123456789012345678', name: 'Test Guild', icon: null, ownerId: '1', owner: true },
        settings: doc.toObject(),
        channels: [{ id: '10', name: 'general' }, { id: '11', name: 'off-topic' }],
        voiceChannels: [{ id: '20', name: 'Voice' }],
        stageChannels: [{ id: '21', name: 'Stage' }],
        categories: [{ id: '30', name: 'Category' }],
        roles: [{ id: '40', name: 'Member' }, { id: '41', name: "Bob's crew" }],
        defaultJobs: DEFAULT_JOBS,
        defaultTiers: DEFAULT_TIERS,
        builtinAchievements: ACHIEVEMENTS.map(a => ({
            id: a.id, name: a.name, description: a.description,
            emoji: a.emoji, category: a.category,
            xpReward: a.xpReward, coinReward: a.coinReward,
        })),
        huntItems: {
            weapons: WEAPON_TIERS.map(w => toItem('hunt', w, 'slug')),
            upgrades: Object.values(WEAPON_UPGRADES).map(u => toItem('hunt', u)),
            ammo: AMMO_PACKS.map(a => toItem('hunt', a)),
            consumables: Object.values(HUNT_CONSUMABLES).map(c => toItem('hunt', c)),
        },
        fishItems: {
            rods: ROD_TIERS.map(r => toItem('fish', r, 'slug')),
            upgrades: Object.values(ROD_UPGRADES).map(u => toItem('fish', u)),
            bait: BAIT_PACKS.map(b => toItem('fish', b)),
            consumables: Object.values(FISH_CONSUMABLES).map(c => toItem('fish', c)),
        },
        mineItems: {
            pickaxes: PICKAXE_TIERS.map(p => toItem('mine', p, 'slug')),
            upgrades: Object.values(PICKAXE_UPGRADES).map(u => toItem('mine', u)),
            blasts: BLAST_PACKS.map(b => toItem('mine', b)),
            consumables: Object.values(MINE_CONSUMABLES).map(c => toItem('mine', c)),
        },
        explorationRegions: REGION_LIST.map(r => ({
            id: r.id,
            emoji: r.emoji,
            name: r.name,
            seasonal: r.seasonalEventId ? (SEASONAL_EVENTS[r.seasonalEventId]?.name ?? r.seasonalEventId) : false,
        })),

        // Supplied by the dashboard's response-header middleware.
        cspNonce: 'test-nonce',
        jsonForScript,
        asset,
        ...overrides,
    };
}

module.exports = { guildSettingsLocals };
