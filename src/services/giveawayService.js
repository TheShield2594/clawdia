const Guild = require('../models/Guild');
const { endGiveaway } = require('../commands/utility/giveaway');

async function checkGiveaways(client) {
    const now = new Date();

    try {
        const guilds = await Guild.find({ 'giveaways.ended': false });

        for (const guildSettings of guilds) {
            let dirty = false;

            for (const ga of guildSettings.giveaways) {
                if (ga.ended) continue;
                if (ga.endsAt <= now) {
                    await endGiveaway(client, guildSettings, ga);
                    dirty = true;
                }
            }

            if (dirty) await guildSettings.save();
        }
    } catch (err) {
        console.error('[GIVEAWAY] Error checking giveaways:', err);
    }
}

module.exports = { checkGiveaways };
