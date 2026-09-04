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


function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/login');
}

const { hasManagePermission, verifyLiveGuildAccess } = require('../lib/permissions');
const { CHANNEL_TYPES } = require('../../bot/gateway');
const { PANELS, DEFAULT_PANEL, isPanel } = require('../lib/panels');
const { groupReactionRolePanels } = require('../lib/reactionRolePanels');

async function getManageableGuilds(req) {
    const manageable = req.user.guilds.filter(hasManagePermission);
    // Batched: the facade may be another process, and this runs on every page
    // that renders the guild picker.
    const present = await req.bot.hasGuilds(manageable.map(g => g.id));
    return manageable.map(guild => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        owner: guild.owner === true,
        botPresent: present[guild.id] === true
    }));
}

const { INVITE_PERMISSIONS_BITFIELD } = require('../../config/invitePermissions');

function buildInviteUrl(guildId) {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) return null;
    const query = [
        `client_id=${encodeURIComponent(clientId)}`,
        `permissions=${INVITE_PERMISSIONS_BITFIELD}`,
        `scope=${encodeURIComponent('bot applications.commands')}`,
        `guild_id=${encodeURIComponent(guildId)}`,
        `disable_guild_select=true`
    ].join('&');
    return `https://discord.com/oauth2/authorize?${query}`;
}

router.get('/', checkAuth, async (req, res, next) => {
    try {
        const guilds = (await getManageableGuilds(req)).map(g => ({
            ...g,
            inviteUrl: buildInviteUrl(g.id)
        }));
        res.render('dashboard', { user: req.user, guilds });
    } catch (err) {
        // The facade may be another process (#876), so this can now fail for a
        // reason that is not this route's. Hand it to the error middleware
        // rather than letting it become an unhandled rejection.
        next(err);
    }
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
    const userGuilds = await getManageableGuilds(req);

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

    // Read unprojected. It used to exclude `shop.imageData`/`shop.imageType` —
    // up to 35 × 512 KB of Buffer per guild, pulled off the wire and deep-copied
    // by toObject() only to be dropped again (#605) — and #888 moved those
    // fields out of this document altogether, so there is nothing left to
    // exclude and no projection for a later read to forget.
    let guildSettings = await Guild.findOne({ guildId });
    const guild = await req.bot.getGuild(guildId);

    if (!guild) {
        return { status: 404, message: 'Guild not found' };
    }

    if (!guildSettings) {
        guildSettings = await Guild.create({
            guildId: guild.id,
            name: guild.name
        });
    }

    // Seeding is a rare backfill: a guild the bot joined before a shop category
    // existed. It used to re-read the document without the projection before
    // writing, because saving a partially selected shop array is how a guild's
    // images got replaced with nothing. With no projection above, the document
    // in hand is the fully selected one and the second read is gone with it.
    if (ensureDefaultShopItems(guildSettings)) {
        await guildSettings.save();
    }

    const allChannels = await req.bot.listChannels(guildId) || [];
    const ofType = type => allChannels.filter(c => c.type === type).map(c => ({ id: c.id, name: c.name }));

    const channels = ofType(CHANNEL_TYPES.TEXT);
    const voiceChannels = ofType(CHANNEL_TYPES.VOICE);
    const stageChannels = ofType(CHANNEL_TYPES.STAGE);
    const categories = ofType(CHANNEL_TYPES.CATEGORY);

    const roles = (await req.bot.listRoles(guildId) || [])
        .filter(r => r.name !== '@everyone')
        .map(r => ({ id: r.id, name: r.name }));

    const builtinAchievements = ACHIEVEMENTS.map(a => ({
        id: a.id, name: a.name, description: a.description,
        emoji: a.emoji, category: a.category,
        xpReward: a.xpReward, coinReward: a.coinReward
    }));

    const safeSettings = guildSettings.toObject();
    // MCP authorization tokens are write-only: the panel shows that a token
    // exists, never its value, so it must not be in the rendered page at all.
    if (Array.isArray(safeSettings.ai?.mcpServers)) {
        safeSettings.ai.mcpServers = safeSettings.ai.mcpServers.map(
            ({ authorizationToken, ...rest }) => ({ ...rest, hasToken: Boolean(authorizationToken) })
        );
    }

    // Pre-load the set of item images that actually exist so the template can
    // skip rendering <img> tags that would otherwise 404. Scoped to this guild
    // plus the shared pre-#561 rows, which is exactly what the image route will
    // serve back for these ids.
    //
    // Since #888 the same collection also holds the shop's images, under
    // `shop:<itemId>` keys; those are not what this set is for — the shop panel
    // renders its own <img> per item and hides it on a 404 — so they simply sit
    // in it unused, which is cheaper than a second query to exclude them.
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
            // Grouped here rather than in reactionroles.ejs (#689): the API
            // returns the same shape so the browser can re-render the list
            // after a create or delete without reloading the page, and two
            // groupings would be two things to keep in step.
            reactionRolePanels: groupReactionRolePanels(safeSettings.reactionRoles),
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