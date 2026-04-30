const express = require('express');
const router = express.Router();
const Guild = require('../../models/Guild');

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

router.get('/guild/:guildId', checkAuth, async (req, res) => {
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

        const channels = guild.channels.cache
            .filter(c => c.type === 0)
            .map(c => ({ id: c.id, name: c.name }));

        const voiceChannels = guild.channels.cache
            .filter(c => c.type === 2)
            .map(c => ({ id: c.id, name: c.name }));

        const categories = guild.channels.cache
            .filter(c => c.type === 4)
            .map(c => ({ id: c.id, name: c.name }));

        const roles = guild.roles.cache
            .filter(r => r.name !== '@everyone')
            .map(r => ({ id: r.id, name: r.name }));

        res.render('guild-settings', {
            user: req.user,
            guild: guild,
            settings: guildSettings,
            channels: channels,
            voiceChannels: voiceChannels,
            categories: categories,
            roles: roles
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Internal server error');
    }
});

module.exports = router;