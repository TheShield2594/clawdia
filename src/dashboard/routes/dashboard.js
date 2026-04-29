const express = require('express');
const router = express.Router();
const Guild = require('../../models/Guild');

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/login');
}

function getUserGuilds(req) {
    const userGuilds = req.user.guilds.filter(guild => 
        (guild.permissions & 0x20) === 0x20
    );
    
    const botGuilds = req.client.guilds.cache;
    const mutualGuilds = userGuilds.filter(guild => 
        botGuilds.has(guild.id)
    );
    
    return mutualGuilds;
}

router.get('/', checkAuth, (req, res) => {
    const guilds = getUserGuilds(req);
    res.render('dashboard', { user: req.user, guilds });
});

router.get('/guild/:guildId', checkAuth, async (req, res) => {
    const { guildId } = req.params;
    const userGuilds = getUserGuilds(req);
    
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

        const roles = guild.roles.cache
            .filter(r => r.name !== '@everyone')
            .map(r => ({ id: r.id, name: r.name }));

        res.render('guild-settings', {
            user: req.user,
            guild: guild,
            settings: guildSettings,
            channels: channels,
            roles: roles
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Internal server error');
    }
});

module.exports = router;