const express = require('express');
const router = express.Router();
const Guild = require('../../models/Guild');
const ItemImage = require('../../models/ItemImage');
const DEFAULT_JOBS = require('../../data/defaultJobs');
const DEFAULT_TIERS = require('../../data/defaultTiers');
const { ACHIEVEMENTS } = require('../../data/achievements');
const { ensureDefaultShopItems } = require('../../data/defaultShopItems');
const { ACTIVITY_ITEMS } = require('../../data/activityItems');
const { REGION_LIST } = require('../../data/exploreData');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');

// A shop item's image is served by /api/item-image/shop/:guildId/:itemId, never
// inlined into the settings page, so the guild-settings read excludes both
// fields. Up to 35 items x 512 KB of Buffer per guild that would otherwise be
// pulled off the wire and deep-copied by toObject() only to be dropped again.
const SHOP_IMAGES_EXCLUDED = '-shop.imageData -shop.imageType';

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/login');
}

const { hasManagePermission, verifyLiveGuildAccess } = require('../lib/permissions');
const { CHANNEL_TYPES } = require('../../bot/gateway');
const { PANELS, DEFAULT_PANEL, isPanel } = require('../lib/panels');

function getManageableGuilds(req) {
    return req.user.guilds
        .filter(hasManagePermission)
        .map(guild => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon,
            owner: guild.owner === true,
            botPresent: req.bot.hasGuild(guild.id)
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

    // The session's guild list is a snapshot from OAuth time, so the panel asks
    // Discord whether it is still true before rendering a guild's settings
    // (#558) — the same second opinion the API middleware takes, and for the
    // same reason: without it a demoted or kicked admin keeps reading this page
    // until their cookie expires. The guild *list* on /dashboard is still drawn
    // from the snapshot: it is the guild names the session already holds, and
    // checking it would mean a member fetch per card.
    if (await verifyLiveGuildAccess(req.bot, guildId, req.user.id) === false) {
        return { status: 403, message: 'You do not have permission to manage this guild.' };
    }

    let guildSettings = await Guild.findOne({ guildId }, SHOP_IMAGES_EXCLUDED);
    let shopIsProjected = true;
    const guild = req.bot.getGuild(guildId);

    if (!guild) {
        return { status: 404, message: 'Guild not found' };
    }

    if (!guildSettings) {
        guildSettings = await Guild.create({
            guildId: guild.id,
            name: guild.name
        });
        shopIsProjected = false;
    }

    // Seeding is a rare backfill: a guild the bot joined before a shop category
    // existed. Running it against the projection keeps the new items on the page
    // being rendered, but the *write* goes through a fully selected document.
    // ensureDefaultShopItems only ever appends, so a save here would in practice
    // emit `$push`; re-reading rather than trusting that is cheap on a path that
    // runs once per guild, and the alternative failure — a whole guild's shop
    // images replaced with nothing — is not one worth a judgement call.
    if (ensureDefaultShopItems(guildSettings)) {
        if (!shopIsProjected) {
            await guildSettings.save();
        } else {
            const fullSettings = await Guild.findOne({ guildId });
            if (fullSettings && ensureDefaultShopItems(fullSettings)) {
                await fullSettings.save();
            }
        }
    }

    const allChannels = req.bot.listChannels(guildId) || [];
    const ofType = type => allChannels.filter(c => c.type === type).map(c => ({ id: c.id, name: c.name }));

    const channels = ofType(CHANNEL_TYPES.TEXT);
    const voiceChannels = ofType(CHANNEL_TYPES.VOICE);
    const stageChannels = ofType(CHANNEL_TYPES.STAGE);
    const categories = ofType(CHANNEL_TYPES.CATEGORY);

    const roles = (req.bot.listRoles(guildId) || [])
        .filter(r => r.name !== '@everyone')
        .map(r => ({ id: r.id, name: r.name }));

    const builtinAchievements = ACHIEVEMENTS.map(a => ({
        id: a.id, name: a.name, description: a.description,
        emoji: a.emoji, category: a.category,
        xpReward: a.xpReward, coinReward: a.coinReward
    }));

    // imageData/imageType are already projected out above for an existing guild;
    // the map still runs because a freshly created document is unprojected.
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
    // template can skip rendering <img> tags that would otherwise 404. Scoped to
    // this guild plus the shared pre-#561 rows, which is exactly what the image
    // route will serve back for these ids.
    const uploadedImageDocs = await ItemImage.find(
        { guildId: { $in: [guildId, null] } },
        { itemId: 1 },
    ).lean();
    const uploadedImageIds = new Set(uploadedImageDocs.map(d => d.itemId));

    // The item list itself comes from data/activityItems.js, which is also what
    // the upload route validates against — one catalog, so the panel cannot
    // offer an id the route would refuse.
    const withImageFlags = groups => Object.fromEntries(
        Object.entries(groups).map(([group, items]) => [
            group,
            items.map(item => ({ ...item, hasImage: uploadedImageIds.has(item.id) })),
        ])
    );

    const huntItems = withImageFlags(ACTIVITY_ITEMS.hunt);
    const fishItems = withImageFlags(ACTIVITY_ITEMS.fish);
    const mineItems = withImageFlags(ACTIVITY_ITEMS.mine);
    // Materials are grouped by the system that drops them rather than owned by
    // one, so they get their own tab instead of a fourth section inside each.
    const materialItems = withImageFlags(ACTIVITY_ITEMS.material);

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
            materialItems,
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