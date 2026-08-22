require('dotenv').config();
// Resolves any <NAME>_FILE variable into <NAME>, so secrets can be mounted as
// files (docker secrets) instead of being readable via `docker inspect`. Runs
// straight after dotenv so .env can set the *_FILE paths too, and before
// anything reads process.env.
require('./config/fileSecrets').loadFileSecrets();
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
