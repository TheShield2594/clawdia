const Guild = require('../models/Guild');
const { endGiveaway } = require('../commands/utility/giveaway');

// Ended giveaways are kept around so `/giveaway reroll` still works, but not
// forever: each one carries a full entrant list, and nothing else prunes the
// array, so a busy server would grow its Guild document without bound.
const GIVEAWAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function checkGiveaways(client) {
    const now = new Date();

    try {
        // Projected: this sweep runs on a schedule across every guild holding a
        // giveaway, and it only ever touches the giveaways array. Without this it
        // pulls whole guild documents — analytics history and inline shop item
        // image Buffers included — to read one field.
        //
        // guildId is selected because endGiveaway resolves the channel through it.
        // Mongoose skips required-validators for paths a projection excluded, so
        // saving these partial documents is safe.
        const guilds = await Guild.find({ 'giveaways.0': { $exists: true } })
            .select('guildId giveaways');

        for (const guildSettings of guilds) {
            let dirty = false;

            for (const ga of guildSettings.giveaways) {
                if (ga.ended) continue;
                if (ga.endsAt <= now) {
                    await endGiveaway(client, guildSettings, ga);
                    dirty = true;
                }
            }

            const cutoff = now.getTime() - GIVEAWAY_RETENTION_MS;
            const keep = guildSettings.giveaways.filter(
                ga => !ga.ended || !ga.endsAt || ga.endsAt.getTime() > cutoff
            );
            if (keep.length !== guildSettings.giveaways.length) {
                guildSettings.giveaways = keep;
                dirty = true;
            }

            if (dirty) await guildSettings.save();
        }
    } catch (err) {
        console.error('[GIVEAWAY] Error checking giveaways:', err);
    }
}

module.exports = { checkGiveaways };
