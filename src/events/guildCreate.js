const Guild = require('../models/Guild');

module.exports = {
    name: 'guildCreate',
    async execute(guild, client) {
        console.log(`[GUILD] Joined new guild: ${guild.name} (${guild.id})`);
        
        try {
            await Guild.create({
                guildId: guild.id,
                name: guild.name
            });
            
            console.log(`[DATABASE] Created settings for guild: ${guild.name}`);
        } catch (error) {
            console.error('Error in guildCreate:', error);
        }
    }
};