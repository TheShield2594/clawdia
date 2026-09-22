const { deployCommandsIfChanged } = require('../utils/commandDeployer');
const { startScheduler } = require('../services/scheduler');
const { reconcileJackpotClaims } = require('../services/casinoJackpotService');
const { reconcileCrashRefunds } = require('../games/casino/crashRefund');

module.exports = {
    name: 'clientReady',
    once: true,
    async execute(client) {
        console.log(`[READY] Logged in as ${client.user.tag}`);
        console.log(`[READY] Serving ${client.guilds.cache.size} guilds`);

        try {
            // Registering here, rather than in a separate step, is what makes
            // the documented Docker quick-start produce a bot with commands:
            // the image runs `node src/index.js` and neither stack file runs
            // `npm run deploy`, so anything outside this process never runs
            // (#643).
            //
            // Deploys the commands startup already loaded rather than walking
            // and requiring src/commands a second time (#607) — which is also
            // what keeps the registered set and the running set the same set —
            // and only when that set differs from the one last published, so
            // the ordinary restart costs one indexed read instead of a full PUT
            // of ~98 commands, and N shards do not each publish the same set.
            const { deployed, count, reason } = await deployCommandsIfChanged(
                client.user.id,
                process.env.DISCORD_TOKEN,
                client.commands.values()
            );
            if (deployed) {
                console.log(`[READY] Deployed ${count} slash commands (${reason})`);
            } else {
                console.log(`[READY] Slash command deploy skipped: ${reason} (${count} registered)`);
            }
        } catch (error) {
            // Logged, not fatal. The bot is already connected and every command
            // Discord has registered from a previous boot still works; refusing
            // to finish startup over a failed re-registration would take a
            // working bot down to fix a stale command description.
            console.error('[READY] Failed to deploy slash commands:', error);
        }

        // All recurring jobs, start-once services, and presence rotation live
        // in the scheduler — this is the only bootstrap site.
        startScheduler(client);

        // Pay out any jackpot claimed out of a pool by a process that stopped
        // before it could credit the winner. The pot, the winner and the key the
        // credit is guarded by are all on the guild document; the service owns
        // what to do with them (#873).
        try {
            const { reconciled, failed } = await reconcileJackpotClaims();
            if (reconciled) console.log(`[READY] Reconciled ${reconciled} unpaid jackpot win(s)`);
            if (failed) console.error(`[READY] ${failed} jackpot win(s) could not be settled — left for the next restart`);
        } catch (err) {
            console.error('[READY] Jackpot reconciliation failed:', err);
        }

        // Refund any crash stakes a restart stranded mid-round. The marker the
        // debit wrote is the whole record; the sweep owns what to do with it.
        try {
            const { refunded, failed } = await reconcileCrashRefunds(client);
            if (refunded) console.log(`[READY] Refunded crash bets for ${refunded} user(s)`);
            if (failed) console.error(`[READY] ${failed} crash refund(s) could not be settled — left for the next restart`);
        } catch (err) {
            console.error('[READY] Crash refund sweep failed:', err);
        }

        console.log('[READY] Background services started');
    }
};
