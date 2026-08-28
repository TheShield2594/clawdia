const { deployCommandsIfChanged } = require('../utils/commandDeployer');
const { startScheduler } = require('../services/scheduler');
const User = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');

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

        // Reconcile any jackpot wins where pool was reset but winner was never credited
        try {
            const Guild = require('../models/Guild');
            const Transaction = require('../models/Transaction');
            const claimToken = `${process.pid}-${Date.now()}`;
            let candidateGuild;
            // Process one guild at a time; re-query each iteration to avoid stale data
            while ((candidateGuild = await Guild.findOneAndUpdate(
                {
                    'casinoJackpot.lastWinnerId':  { $ne: null },
                    'casinoJackpot.lastWonAmount': { $gt: 0 },
                    'casinoJackpot.claimToken':    { $in: [null, claimToken] },
                },
                { $set: { 'casinoJackpot.claimToken': claimToken } },
                { new: true }
            )) !== null) {
                const { lastWinnerId, lastWonAmount, lastWonAt } = candidateGuild.casinoJackpot;
                const guildId = candidateGuild.guildId;
                let creditSucceeded = false;
                try {
                    const credited = await Transaction.findOne({
                        userId:  lastWinnerId,
                        guildId,
                        type:    'casino_jackpot',
                        amount:  lastWonAmount,
                        ...(lastWonAt ? { createdAt: { $gte: lastWonAt } } : {}),
                    }).lean();
                    if (!credited) {
                        const updatedUser = await User.findOneAndUpdate(
                            { userId: lastWinnerId, guildId },
                            { $inc: { balance: lastWonAmount } },
                            { new: true }
                        );
                        if (updatedUser) {
                            logTransaction({ userId: lastWinnerId, guildId, type: 'casino_jackpot', amount: lastWonAmount, balance: updatedUser.balance, note: 'jackpot reconciliation on restart' });
                            console.log(`[READY] Reconciled jackpot payout of ${lastWonAmount} to ${lastWinnerId} in guild ${guildId}`);
                            creditSucceeded = true;
                        }
                    } else {
                        creditSucceeded = true; // already paid, just clear
                    }
                } catch (innerErr) {
                    console.error(`[READY] Jackpot credit failed for guild ${guildId}:`, innerErr);
                }
                if (creditSucceeded) {
                    await Guild.updateOne(
                        { _id: candidateGuild._id },
                        { $set: { 'casinoJackpot.lastWinnerId': null, 'casinoJackpot.lastWonAmount': null, 'casinoJackpot.claimToken': null } }
                    );
                } else {
                    // Release lock without clearing recovery fields so next restart can retry
                    await Guild.updateOne(
                        { _id: candidateGuild._id },
                        { $set: { 'casinoJackpot.claimToken': null } }
                    );
                    break; // avoid spinning on a persistently failing guild
                }
            }
        } catch (err) {
            console.error('[READY] Jackpot reconciliation failed:', err);
        }

        // Refund any bets that were deducted during a crash game that was interrupted by a restart
        try {
            const pending = await User.find({ pendingCrashRefund: { $gt: 0 } }).lean();
            if (pending.length > 0) {
                for (const u of pending) {
                    await User.findOneAndUpdate(
                        { _id: u._id },
                        [{ $inc: { balance: '$pendingCrashRefund' } }, { $set: { pendingCrashRefund: 0 } }]
                    );
                    logTransaction({ userId: u.userId, guildId: u.guildId, type: 'crash_refund', amount: u.pendingCrashRefund, balance: u.balance + u.pendingCrashRefund, note: 'bot restart refund' });
                }
                console.log(`[READY] Refunded crash bets for ${pending.length} user(s)`);
            }
        } catch (err) {
            console.error('[READY] Crash refund sweep failed:', err);
        }

        console.log('[READY] Background services started');
    }
};
