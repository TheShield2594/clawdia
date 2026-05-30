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

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/login');
}

const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

function hasManagePermission(guild) {
    if (guild.owner === true) return true;
    try {
        const perms = BigInt(guild.permissions ?? 0);
        return (perms & ADMINISTRATOR) === ADMINISTRATOR
            || (perms & MANAGE_GUILD) === MANAGE_GUILD;
    } catch {
        return false;
    }
}

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

async function renderGuildSettings(req, res) {
    const { guildId } = req.params;
    const userGuilds = getManageableGuilds(req);

    if (!userGuilds.find(g => g.id === guildId)) {
        return res.status(403).send('You do not have permission to manage this guild.');
    }

    try {
        let guildSettings = await Guild.findOne({ guildId });
        const guild = req.client.guilds.cache.get(guildId);

        if (!guild) {
            return res.status(404).send('Guild not found');
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

        res.render('guild-settings', {
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
            mineItems
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Internal server error');
    }
}

router.get('/guild/:guildId', checkAuth, renderGuildSettings);

module.exports = router;