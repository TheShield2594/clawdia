/**
 * The Bank district's weekly interest payout (issue #370, split out in #931).
 *
 * `/bank` moves coins in and out; this is the only thing that adds to a balance
 * nobody deposited. It runs where the Bank district is active, and is
 * registered as a job in `services/scheduler/index.js`, which owns the cron
 * expression and runs it through `runJob`; nothing here schedules itself
 * (#611).
 *
 * @module services/bankService
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const { handlesGuild } = require('../utils/sharding');
const { postAnnouncement } = require('../utils/guildAnnounce');

// Credits 5% of each user's banked coins in guilds where the Bank district is active.
// Intended to run once per week. Only the first INTEREST_BEARING_CAP coins of a
// user's bank earn interest — uncapped 5%/week compounds to ~260% APY and lets
// large balances inflate the economy unboundedly.
const INTEREST_BEARING_CAP = 100_000;

// Users are credited in batches rather than one document at a time. A guild with
// tens of thousands of bankers would otherwise cost that many sequential round
// trips, and holding every op in one array before sending it trades the round
// trips for an equally unbounded amount of memory.
const INTEREST_BATCH_SIZE = 1_000;

/**
 * Pay weekly interest on bank balances, in batches of 1,000 users.
 *
 * Only the first 100,000 coins of a balance earn: uncapped 5%/week compounds to
 * roughly 260% APY, which lets a large balance inflate the economy without
 * bound. Batched rather than one document at a time because a guild with tens
 * of thousands of bankers would otherwise cost that many sequential round
 * trips, and holding every operation in one array trades those round trips for
 * an equally unbounded amount of memory.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function applyBankInterest(client) {
    const { EmbedBuilder } = require('discord.js');
    const { isDistrictActive } = require('./districtService');
    const Transaction = require('../models/Transaction');

    const now     = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const guilds  = await Guild.find({
        'districts': { $elemMatch: { districtId: 'bank', activeUntil: { $gt: now } } }
    }).lean();

    for (const guildDoc of guilds) {
        const guildId = guildDoc.guildId;
        // Per-guild job, despite being the usual example of a deployment-wide
        // one. Every write it makes is inside this guild — the weekly claim on
        // `bankInterestLastRunAt`, the credits to this guild's users — and it
        // finishes by posting the interest summary to this guild's announcement
        // channel. Pinned to shard 0 it pays correctly and tells nobody.
        if (!handlesGuild(guildId, client)) continue;

        try {
            // Atomic weekly claim — skip if already run within the last 7 days
            const claimed = await Guild.findOneAndUpdate(
                {
                    guildId,
                    $or: [
                        { bankInterestLastRunAt: null },
                        { bankInterestLastRunAt: { $lte: weekAgo } },
                    ],
                },
                { $set: { bankInterestLastRunAt: now } },
                { new: false }
            );
            if (!claimed) continue;

            if (!isDistrictActive(guildDoc, 'bank')) continue;

            // Projected and lean: the credit needs three fields, and hydrating full
            // user documents for the whole guild is what makes this job expensive.
            const users = await User.find({ guildId, bank: { $gt: 0 } })
                .select('userId bank balance')
                .lean();

            const note = `5% weekly bank interest (Bank district active, first ${INTEREST_BEARING_CAP.toLocaleString()} coins)`;
            let totalInterestPaid = 0;
            let credits = [];
            let ledger  = [];

            const flush = async () => {
                if (!credits.length) return;
                await User.bulkWrite(credits, { ordered: false });
                // The ledger is written after the credit for the same reason the rest of
                // the economy does it in that order: an entry with no matching credit
                // claims coins nobody was paid.
                await Transaction.insertMany(ledger, { ordered: false })
                    .catch(err => console.error('[scheduler] bank interest ledger write failed:', err.message));
                credits = [];
                ledger  = [];
            };

            for (const user of users) {
                const interest = Math.floor(Math.min(user.bank, INTEREST_BEARING_CAP) * 0.05);
                if (interest <= 0) continue;
                credits.push({ updateOne: { filter: { _id: user._id }, update: { $inc: { bank: interest } } } });
                ledger.push({ userId: user.userId, guildId, type: 'bank_interest', amount: interest, balance: user.balance, note });
                totalInterestPaid += interest;
                if (credits.length >= INTEREST_BATCH_SIZE) await flush();
            }
            await flush();

            if (totalInterestPaid <= 0) continue;

            const channelId = guildDoc.economy?.announcementChannelId ?? null;
            if (!channelId) continue;

            const currency = guildDoc.economy?.currency ?? '💰';
            const embed = new EmbedBuilder()
                .setColor('#f1c40f')
                .setTitle('🏦 Weekly Bank Interest Paid')
                .setDescription(
                    `The **Bank district** is active — all members with banked coins earned **5% weekly interest** (on the first ${INTEREST_BEARING_CAP.toLocaleString()} coins).\n\n` +
                    `Total interest distributed: **${currency}${totalInterestPaid.toLocaleString()}**`
                )
                .setFooter({ text: 'Deposit coins with /bank deposit to earn interest each week.' })
                .setTimestamp();

            await postAnnouncement(client, guildId, channelId, embed);
        } catch (err) {
            console.error(`[scheduler] applyBankInterest failed for guild ${guildId}:`, err.message);
        }
    }
}

module.exports = { applyBankInterest, INTEREST_BEARING_CAP };
