// Locals for rendering views/guild-settings.ejs outside of Express, assembled
// the same way routes/dashboard.js assembles them.
const Guild = require('../../src/models/Guild');
const DEFAULT_JOBS = require('../../src/data/defaultJobs');
const DEFAULT_TIERS = require('../../src/data/defaultTiers');
const { ACHIEVEMENTS } = require('../../src/data/achievements');
const { ensureDefaultShopItems } = require('../../src/data/defaultShopItems');
const { ACTIVITY_ITEMS } = require('../../src/data/activityItems');
const { REGION_LIST } = require('../../src/data/exploreData');
const { SEASONAL_EVENTS } = require('../../src/data/seasonalEvents');
const { jsonForScript } = require('../../src/dashboard/lib/jsonForScript');
const { asset } = require('../../src/dashboard/lib/assets');
const { PANELS, DEFAULT_PANEL } = require('../../src/dashboard/lib/panels');

// The same shape routes/dashboard.js hands the panel: the catalog, with a flag
// per item saying whether this guild has uploaded an image. Read from the
// catalog rather than rebuilt from the game data — a fixture that lists the
// groups itself is a second catalog to keep in step, and it was already behind
// by the zones, locations and depths when the catches arrived.
const withImageFlags = groups => Object.fromEntries(
    Object.entries(groups).map(([group, items]) => [
        group,
        items.map(item => ({ ...item, hasImage: false })),
    ])
);

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
        huntItems: withImageFlags(ACTIVITY_ITEMS.hunt),
        fishItems: withImageFlags(ACTIVITY_ITEMS.fish),
        mineItems: withImageFlags(ACTIVITY_ITEMS.mine),
        materialItems: withImageFlags(ACTIVITY_ITEMS.material),
        explorationRegions: REGION_LIST.map(r => ({
            id: r.id,
            emoji: r.emoji,
            name: r.name,
            seasonal: r.seasonalEventId ? (SEASONAL_EVENTS[r.seasonalEventId]?.name ?? r.seasonalEventId) : false,
        })),

        // Which panels the page stubs out, and which one ships with it.
        panels: PANELS,
        activePanel: DEFAULT_PANEL,

        // Supplied by the dashboard's response-header middleware.
        cspNonce: 'test-nonce',
        jsonForScript,
        asset,
        ...overrides,
    };
}

/**
 * The same locals, with every array-backed list holding a row.
 *
 * A fresh Guild document has all of them empty, so each panel's `forEach`
 * renders nothing and a sweep over the default fixture never sees a single
 * repeater row — which is how a level-reward row shipped with two unnamed
 * controls under a suite asserting that every control has a name.
 *
 * Ids here have to be ones the fixture's `roles` and `channels` actually
 * contain: several panels look the id up and skip the row when it is missing.
 */
function populatedGuildSettingsLocals(overrides = {}) {
    const base = guildSettingsLocals();
    const s = base.settings;
    const ROLE = '40';
    const CHANNEL = '10';
    const USER = '900000000000000001';

    s.levelRoles = [{ level: 5, roleId: ROLE }, { level: 10, roleId: '41' }];
    s.leveling = { ...s.leveling, noXpRoleIds: [ROLE], noXpChannelIds: [CHANNEL] };
    s.season = { ...s.season, tierRewards: [{ tier: 1, coins: 100, roleId: ROLE, label: 'Bronze' }] };
    s.commandPolicies = {
        ...s.commandPolicies,
        exceptions: { roleIds: [ROLE], userIds: [USER] },
        rules: [{ command: 'ban', effect: 'deny', roleIds: [ROLE], channelIds: [CHANNEL] }],
        cooldowns: [{ command: 'work', roleId: ROLE, seconds: 30 }],
    };
    s.antiNuke = { ...s.antiNuke, whitelistUserIds: [USER] };
    s.autoRoles = [ROLE];
    s.reactionRoles = [{ messageId: '1', channelId: CHANNEL, emoji: '👍', roleId: ROLE }];
    s.rssFeeds = [{ url: 'https://example.com/feed.xml', channelId: CHANNEL }];
    s.moderation = {
        ...s.moderation,
        customBadWords: ['badword'],
        immunityRoleIds: [ROLE],
        inviteAllowlist: ['discord.gg/example'],
        linkAllowlist: ['example.com'],
    };
    s.exploration = { ...s.exploration, disabledRegions: ['forest'] };
    s.ai = { ...s.ai, dailyDigest: { ...(s.ai && s.ai.dailyDigest), sourceChannelIds: [CHANNEL] } };

    return { ...base, ...overrides };
}

module.exports = { guildSettingsLocals, populatedGuildSettingsLocals };
