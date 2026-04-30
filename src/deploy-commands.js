require('dotenv').config();
const { deployCommands } = require('./utils/commandDeployer');

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        const count = await deployCommands(process.env.CLIENT_ID, process.env.DISCORD_TOKEN);
        console.log(`Successfully reloaded ${count} application (/) commands.`);
    } catch (error) {
        console.error(error);
    }
})();
