const express = require('express');
const router = express.Router();
const Guild = require('../../models/Guild');
const ItemImage = require('../../models/ItemImage');
const DEFAULT_JOBS = require('../../data/defaultJobs');
const DEFAULT_TIERS = require('../../data/defaultTiers');
const { ACHIEVEMENTS } = require('../../data/achievements');
const { ensureDefaultShopItems } = require('../../data/defaultShopItems');
const { WEAPON_TIERS, AMMO_PACKS, CONSUMABLES: HUNT_CONSUMABLES, WEAPON_UPGRADES } = require('../../data/huntData');
const { ROD_TIERS, BAIT_PACKS, CONSUMABLES: FISH_CONSUMABLES, ROD_UPGRADES } = require('../../data/fishData');
const { PICKAXE_TIERS, BLAST_PACKS, CONSUMABLES: MINE_CONSUMABLES, PICKAXE_UPGRADES } = require('../../data/mineData');
const { REGION_LIST } = require('../../data/exploreData');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/login');
}

const { hasManagePermission } = require('../lib/permissions');
const { PANELS, DEFAULT_PANEL, isPanel } = require('../lib/panels');

function getManageableGuilds(req) {
    const botGuilds = req.client.guilds.cache;
    return req.user.guilds
        .filter(hasManagePermission)
        .map(guild => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon,
            owner: guild.owner === true,
            botPresent: botGuilds.has(guild.id)
        }));
}

function buildInviteUrl(guildId) {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) return null;
    const query = [
        `client_id=${encodeURIComponent(clientId)}`,
        `permissions=8`,
        `scope=${encodeURIComponent('bot applications.commands')}`,
        `guild_id=${encodeURIComponent(guildId)}`,
        `disable_guild_select=true`
    ].join('&');
    return `https://discord.com/oauth2/authorize?${query}`;
}

router.get('/', checkAuth, (req, res) => {
    const guilds = getManageableGuilds(req).map(g => ({
        ...g,
        inviteUrl: buildInviteUrl(g.id)
    }));
    res.render('dashboard', { user: req.user, guilds });
});

/**
 * Everything views/guild-settings.ejs and its panel partials read.
 *
 * The page and the panel fragment endpoint both need the full set — a panel
 * fetched on its own still renders channel pickers, role pickers and the guild's
 * saved settings — so the two share this.
 *
 * @returns {Promise<{status: number, message: string} | {locals: object}>}
 */
async function buildGuildSettingsLocals(req) {
    const { guildId } = req.params;
    const userGuilds = getManageableGuilds(req);

    if (!userGuilds.find(g => g.id === guildId)) {
        return { status: 403, message: 'You do not have permission to manage this guild.' };
    }

    let guildSettings = await Guild.findOne({ guildId });
    const guild = req.client.guilds.cache.get(guildId);

    if (!guild) {
        return { status: 404, message: 'Guild not found' };
    }

    if (!guildSettings) {
        guildSettings = await Guild.create({
            guildId: guild.id,
            name: guild.name
        });
    }

    if (ensureDefaultShopItems(guildSettings)) {
        await guildSettings.save();
    }

    const channels = guild.channels.cache
        .filter(c => c.type === 0)
        .map(c => ({ id: c.id, name: c.name }));

    const voiceChannels = guild.channels.cache
        .filter(c => c.type === 2)
        .map(c => ({ id: c.id, name: c.name }));

    const stageChannels = guild.channels.cache
        .filter(c => c.type === 13)
        .map(c => ({ id: c.id, name: c.name }));

    const categories = guild.channels.cache
        .filter(c => c.type === 4)
        .map(c => ({ id: c.id, name: c.name }));

    const roles = guild.roles.cache
        .filter(r => r.name !== '@everyone')
        .map(r => ({ id: r.id, name: r.name }));

    const builtinAchievements = ACHIEVEMENTS.map(a => ({
        id: a.id, name: a.name, description: a.description,
        emoji: a.emoji, category: a.category,
        xpReward: a.xpReward, coinReward: a.coinReward
    }));

    const safeSettings = guildSettings.toObject();
    if (Array.isArray(safeSettings.shop)) {
        safeSettings.shop = safeSettings.shop.map(({ imageData, imageType, ...rest }) => rest);
    }
    // MCP authorization tokens are write-only: the panel shows that a token
    // exists, never its value, so it must not be in the rendered page at all.
    if (Array.isArray(safeSettings.ai?.mcpServers)) {
        safeSettings.ai.mcpServers = safeSettings.ai.mcpServers.map(
            ({ authorizationToken, ...rest }) => ({ ...rest, hasToken: Boolean(authorizationToken) })
        );
    }

    // Pre-load the set of activity item images that actually exist so the
    // template can skip rendering <img> tags that would otherwise 404.
    const uploadedImageDocs = await ItemImage.find({}, { itemId: 1 }).lean();
    const uploadedImageIds = new Set(uploadedImageDocs.map(d => d.itemId));

    const toItem = (ns, item, idField = 'id') => {
        const id = `${ns}:${item[idField]}`;
        return { id, label: item.name, emoji: item.emoji || '📦', hasImage: uploadedImageIds.has(id) };
    };

    const huntItems = {
        weapons:     WEAPON_TIERS.map(w => toItem('hunt', w, 'slug')),
        upgrades:    Object.values(WEAPON_UPGRADES).map(u => toItem('hunt', u)),
        ammo:        AMMO_PACKS.map(a => toItem('hunt', a)),
        consumables: Object.values(HUNT_CONSUMABLES).map(c => toItem('hunt', c))
    };
    const fishItems = {
        rods:        ROD_TIERS.map(r => toItem('fish', r, 'slug')),
        upgrades:    Object.values(ROD_UPGRADES).map(u => toItem('fish', u)),
        bait:        BAIT_PACKS.map(b => toItem('fish', b)),
        consumables: Object.values(FISH_CONSUMABLES).map(c => toItem('fish', c))
    };
    const mineItems = {
        pickaxes:    PICKAXE_TIERS.map(p => toItem('mine', p, 'slug')),
        upgrades:    Object.values(PICKAXE_UPGRADES).map(u => toItem('mine', u)),
        blasts:      BLAST_PACKS.map(b => toItem('mine', b)),
        consumables: Object.values(MINE_CONSUMABLES).map(c => toItem('mine', c))
    };

    // Canonical exploration region catalog for the dashboard panel —
    // derived from exploreData so the template never drifts from the game data.
    const explorationRegions = REGION_LIST.map(r => ({
        id: r.id,
        emoji: r.emoji,
        name: r.name,
        seasonal: r.seasonalEventId ? (SEASONAL_EVENTS[r.seasonalEventId]?.name ?? r.seasonalEventId) : false,
    }));

    return {
        locals: {
            user: req.user,
            guild: { id: guild.id, name: guild.name, icon: guild.icon, ownerId: guild.ownerId, owner: req.user.id === guild.ownerId },
            settings: safeSettings,
            channels: channels,
            voiceChannels: voiceChannels,
            stageChannels: stageChannels,
            categories: categories,
            roles: roles,
            defaultJobs: DEFAULT_JOBS,
            defaultTiers: DEFAULT_TIERS,
            builtinAchievements,
            huntItems,
            fishItems,
            mineItems,
            explorationRegions
        }
    };
}

async function renderGuildSettings(req, res) {
    try {
        const result = await buildGuildSettingsLocals(req);
        if (result.message) return res.status(result.status).send(result.message);

        // The page carries this guild's settings and is reachable only by its
        // managers; no shared cache has any business holding a copy.
        res.set('Cache-Control', 'private, no-store');
        res.render('guild-settings', {
            ...result.locals,
            panels: PANELS,
            activePanel: DEFAULT_PANEL,
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Internal server error');
    }
}

/**
 * One settings panel as a bare HTML fragment.
 *
 * The page ships only the default panel; every other one is fetched here the
 * first time its tab is opened, which keeps roughly 200 KB of markup out of the
 * initial response for a user who only ever looks at one or two panels.
 */
async function renderGuildPanel(req, res) {
    const { panel } = req.params;
    if (!isPanel(panel)) return res.status(404).send('Unknown panel');

    try {
        const result = await buildGuildSettingsLocals(req);
        if (result.message) return res.status(result.status).send(result.message);

        // Fragments are per-user and per-guild; never let a shared cache hold one.
        res.set('Cache-Control', 'private, no-store');
        res.render(`partials/panels/${panel}`, result.locals);
    } catch (error) {
        console.error('Dashboard panel error:', error);
        res.status(500).send('Internal server error');
    }
}

router.get('/guild/:guildId', checkAuth, renderGuildSettings);
router.get('/guild/:guildId/panel/:panel', checkAuth, renderGuildPanel);

module.exports = router;