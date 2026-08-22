const Guild = require('../models/Guild');
const { ensureDefaultShopItems } = require('../data/defaultShopItems');

module.exports = {
    name: 'guildCreate',
    async execute(guild, _client) {
        console.log(`[GUILD] Joined new guild: ${guild.name} (${guild.id})`);

        try {
            const guildSettings = await Guild.create({
                guildId: guild.id,
                name: guild.name
            });

            if (ensureDefaultShopItems(guildSettings)) {
                await guildSettings.save();
            }

            console.log(`[DATABASE] Created settings for guild: ${guild.name}`);
        } catch (error) {
            console.error('Error in guildCreate:', error);
        }
    }
};