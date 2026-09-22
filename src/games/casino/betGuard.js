'use strict';

/**
 * The guild's say over a casino bet: whether the casino is open, and how much a
 * hand may stake.
 *
 * Every game checked `casinoMaxBet` in its own copy of the same four lines, and
 * the dispatcher in `commands/economy/casino.js` checked the three switches
 * (`economy.enabled`, `gamesEnabled`, `casinoEnabled`) before handing over. Both
 * ran once per *command* — and a command is not a hand (#873, pass 12). Every
 * game but blackjack, coinflip and dice ends its hand with a "Play Again" that
 * stakes the same bet again, from a button whose collector outlives the command
 * by a minute and re-arms itself on every replay. None of those replays asked
 * again. An admin who closed the casino, or lowered the limit, did so for new
 * commands only: a player already holding a replay button could keep playing at
 * the old stake for as long as they kept pressing it.
 *
 * So the rule is stated here once, and asked at the start of every hand. The
 * economy freeze is not part of it on purpose: it already rides `placeWager`'s
 * own filter (#870), which is the one place a refusal cannot race the debit.
 */

const { MessageFlags } = require('discord.js');
const { getGuildSettings } = require('../../utils/guildSettingsCache');

/**
 * Why this guild will not take this bet, or null when it will.
 *
 * @param {object|null} settings  the guild's settings document
 * @param {number} bet            the stake the hand opens with
 * @returns {string|null}
 */
function casinoRefusal(settings, bet) {
    const economy = settings?.economy ?? {};
    if (economy.enabled === false)       return 'The economy is disabled on this server.';
    if (economy.gamesEnabled === false)  return 'Economy games are disabled on this server.';
    if (economy.casinoEnabled === false) return 'Casino games are disabled on this server.';
    const max = economy.casinoMaxBet ?? 0;
    if (max > 0 && bet > max) {
        return `❌ The casino bet limit on this server is **${max.toLocaleString()}** coins.`;
    }
    return null;
}

/**
 * The same question for a replay, asked against the settings as they are now.
 *
 * Read through the settings cache, the same read the dispatcher's own switch
 * checks use. A `/casino setlimit` invalidates it in the process that wrote it;
 * a dashboard save reaches the other shards within the cache's 30-second TTL
 * (see `utils/sharding.js`). That bound is the whole of the window — against
 * a replay that used to ask never.
 *
 * Fails closed. A replay refused because the settings could not be read costs
 * the player one button press and nothing else — no coins have moved — where a
 * replay let through on a failed read is exactly the bypass this exists to
 * close.
 */
async function replayRefusal(guildId, bet) {
    try {
        return casinoRefusal(await getGuildSettings(guildId), bet);
    } catch (err) {
        console.error('[casino] replay settings read failed:', err);
        return 'The casino could not check this server\'s settings just now — please try again.';
    }
}

/**
 * Turns a replay press away: tells the player why, privately, and takes the
 * replay button off the hand so it is not pressed again.
 */
async function refuseReplay(press, interaction, reason) {
    await press.reply({ content: reason, flags: MessageFlags.Ephemeral }).catch(() => {});
    await interaction.editReply({ components: [] }).catch(() => {});
}

module.exports = { casinoRefusal, replayRefusal, refuseReplay };
