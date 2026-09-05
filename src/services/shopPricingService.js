/**
 * Dynamic shop pricing: the recurring recalculation (issue #354, split out in
 * #931).
 *
 * `utils/dynamicPricing.js` holds the arithmetic — what the next price is, how
 * demand decays, which way the trend arrow points — and `/shop` reads the
 * result. This is the job that moves the numbers. Registered in
 * `services/scheduler/index.js`, which owns the cron expression and runs it
 * through `runJob`; nothing here schedules itself (#611).
 *
 * The shop is read under a projection naming only the pricing fields, and the
 * new prices go back as a `bulkWrite` of per-item `$set`s, rather than the
 * whole-document read-mutate-`save()` this job used to do.
 *
 * The reason was that shop items carried their icon inline, as an `imageData`
 * Buffer on the subdocument, so the job's cost was proportional to a guild's
 * uploaded artwork rather than to the handful of numbers it changes — every
 * fifteen minutes it pulled every icon of every dynamic-pricing guild into the
 * process and `markModified('shop')` wrote them all back untouched. #888 moved
 * those Buffers into the ItemImage collection, so that particular cost is gone;
 * the shape stays, because a targeted `$set` of the fields a job changes is
 * still the right thing for a job that runs every fifteen minutes against every
 * guild.
 *
 * @module services/shopPricingService
 */

const Guild = require('../models/Guild');
const { handlesGuild } = require('../utils/sharding');
const { ensurePricingFields, nextPrice, decayDemand, demandDecayFactor, trendBucket, HISTORY_CAP } = require('../utils/dynamicPricing');
const { postAnnouncement } = require('../utils/guildAnnounce');
const COLORS = require('../utils/embedColors');

/**
 * Move every dynamic-pricing guild's shop prices one step toward what demand
 * says they should be, decay the demand scores, and append to the price history.
 *
 * Reads the shop under a projection naming only the pricing fields and writes
 * the new prices as a `bulkWrite` of per-item `$set`s — see the note above for
 * why that shape rather than a read-mutate-`save()`.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function recalcShopPrices(client) {
    const { EmbedBuilder } = require('discord.js');
    // Only the lease window is needed here; the claim below re-reads the guild.
    const guilds = await Guild.find({ 'dynamicPricing.enabled': true }, 'guildId dynamicPricing.recalcMinutes').lean();

    for (const guildSummary of guilds) {
        // Per-guild job, checked before the lease claim below.
        if (!handlesGuild(guildSummary.guildId, client)) continue;

        try {
            const recalcMs = (guildSummary.dynamicPricing?.recalcMinutes ?? 60) * 60_000;
            const now      = new Date();
            const leaseCutoff = new Date(now.getTime() - recalcMs);

            // Atomically claim this guild's recalc window. The update only
            // succeeds when lastRecalcAt is null or older than the lease window,
            // ensuring concurrent workers (multi-instance deployments) don't
            // both run the recalc for the same guild.
            //
            // `priceHistory` is deliberately absent from the projection: the write
            // below appends to it with `$push`/`$slice` rather than replacing it,
            // so there is no reason to carry thirty entries per item back and forth.
            const guildDoc = await Guild.findOneAndUpdate(
                {
                    guildId: guildSummary.guildId,
                    'dynamicPricing.enabled': true,
                    $or: [
                        { 'dynamicPricing.lastRecalcAt': null },
                        { 'dynamicPricing.lastRecalcAt': { $lte: leaseCutoff } },
                    ],
                },
                { $set: { 'dynamicPricing.lastRecalcAt': now } },
                {
                    new: true,
                    projection: 'guildId dynamicPricing economy.announcementChannelId economy.currency '
                        + 'shop._id shop.name shop.price shop.basePrice shop.currentPrice shop.demandScore',
                }
            ).lean();
            if (!guildDoc) continue; // another worker already claimed this window

            const shop = Array.isArray(guildDoc.shop) ? guildDoc.shop : [];
            // Captured before the backfill, because the write below names a field
            // only where this job is the one that changed it. `basePrice` is set by
            // admins through the dashboard, and writing back the value we read
            // would undo an edit made while we were computing.
            const priorState = shop.map(item => ({
                hadBasePrice: item.basePrice != null,
                // `$mul` rejects a null, and treats a missing field as zero — which
                // is the right answer for an item that predates demand tracking, but
                // has to be reached with `$set` rather than by multiplying.
                hadDemandScore: typeof item.demandScore === 'number',
            }));
            ensurePricingFields(shop);

            const band        = guildDoc.dynamicPricing.priceBand ?? 0.5;
            const volatility  = guildDoc.dynamicPricing.volatility ?? 'medium';
            const decayFactor = demandDecayFactor(volatility);
            const changedMovers = [];
            const writes = [];

            for (const [index, item] of shop.entries()) {
                const prev = item.currentPrice ?? item.basePrice ?? item.price;
                // Both read the demand score as it was at claim time, which is what
                // the price is supposed to follow; only the stored score is left to
                // the database to decay.
                item.currentPrice = nextPrice(item, band, volatility);
                item.demandScore  = decayDemand(item, volatility);

                // Nothing else writes `currentPrice`, and this job holds the guild's
                // recalc lease, so it is the sole author of that field.
                const set = { 'shop.$.currentPrice': item.currentPrice };
                if (!priorState[index].hadBasePrice) set['shop.$.basePrice'] = item.basePrice;

                const update = {
                    $set: set,
                    $push: {
                        'shop.$.priceHistory': {
                            // A snapshot of the score this tick's price was computed
                            // from; a buy landing during the write moves the stored
                            // score without rewriting this row.
                            $each: [{ at: now, price: item.currentPrice, demandScore: item.demandScore }],
                            $slice: -HISTORY_CAP,
                        },
                    },
                };
                if (priorState[index].hadDemandScore) {
                    update.$mul = { 'shop.$.demandScore': decayFactor };
                } else {
                    set['shop.$.demandScore'] = item.demandScore;
                }

                // Matched by subdocument `_id` rather than by array index: an admin
                // adding or removing a shop item between the read and the write
                // shifts the indices, and an index-addressed `$set` would then land
                // the new price on somebody else's item. A stale `_id` simply
                // matches nothing.
                //
                // Backfilling an item additionally requires that it still have no
                // basePrice. That is the one field here whose value is read rather
                // than derived, so an admin setting it between the claim and this
                // write is a real edit to lose. Failing the predicate skips the item
                // for this tick — including its currentPrice and history entry,
                // which were computed from the basePrice that no longer applies —
                // and the next tick recomputes from the admin's value.
                //
                // `{ basePrice: null }` matches an absent field as well as an
                // explicit null, which is the same set `item.basePrice == null`
                // selected when priorState was captured.
                const filter = priorState[index].hadBasePrice
                    ? { guildId: guildDoc.guildId, 'shop._id': item._id }
                    : { guildId: guildDoc.guildId, shop: { $elemMatch: { _id: item._id, basePrice: null } } };

                writes.push({
                    updateOne: {
                        filter,
                        update,
                    },
                });

                // Movers are collected from the computed values rather than from
                // what the write matched, since bulkWrite reports matches only in
                // aggregate. A backfill item losing its predicate could therefore be
                // named in the embed without its price having landed — cosmetic, and
                // it needs an admin edit to land inside the same few milliseconds.
                if (Math.abs(item.currentPrice - prev) / Math.max(1, prev) > 0.05) {
                    changedMovers.push({ name: item.name, prev, next: item.currentPrice, item });
                }
            }

            if (writes.length) await Guild.bulkWrite(writes);

            const channelId = guildDoc.economy?.announcementChannelId;
            if (channelId && changedMovers.length) {
                const currency = guildDoc.economy?.currency ?? '💰';
                const top = changedMovers
                    .sort((a, b) => Math.abs(b.next - b.prev) - Math.abs(a.next - a.prev))
                    .slice(0, 5);
                const lines = top.map(m => {
                    const tb = trendBucket(m.item);
                    return `${tb.arrow} **${m.name}** — ${currency}${m.prev.toLocaleString()} → ${currency}${m.next.toLocaleString()}`;
                });
                const embed = new EmbedBuilder()
                    .setColor(COLORS.INFO)
                    .setTitle('📊 Market Update')
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: 'Supply and demand shifted shop prices. Use /shop trends for the full board.' })
                    .setTimestamp();
                await postAnnouncement(client, guildDoc.guildId, channelId, embed);
            }
        } catch (err) {
            console.error(`[scheduler] recalcShopPrices failed for guild ${guildSummary.guildId}:`, err);
        }
    }
}

module.exports = { recalcShopPrices };
