require('dotenv').config();
const { deployCommands } = require('./utils/commandDeployer');

(async () => {
    if (!process.env.CLIENT_ID || !process.env.DISCORD_TOKEN) {
        console.error('Missing CLIENT_ID or DISCORD_TOKEN environment variable.');
        process.exit(1);
    }
    try {
        console.log('Started refreshing application (/) commands.');
        const count = await deployCommands(process.env.CLIENT_ID, process.env.DISCORD_TOKEN);
        console.log(`Successfully reloaded ${count} application (/) commands.`);
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        process.exit(1);
    }
})();
