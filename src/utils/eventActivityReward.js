'use strict';

/**
 * The event currency and the themed bonus item a seasonal-event activity pays on
 * a win (#873, pass 8).
 *
 * `/trickortreat`, `/sandcastle`, `/lovenote` and `/trackhunt` are one shape:
 * each claims its cooldown up front, rolls, and on a win credits coins to
 * `balance`, event currency to `eventCurrency`, and a themed item to
 * `inventory`. The coins are keyed through `saveWithBalanceDelta` at the call
 * site (they ride the run's balance delta); this is the other two, which do not.
 *
 * Before pass 8 the currency was mutated onto the user with `addEventCurrency`
 * and written by the same `save()` that detaches the balance — a snapshot `$set`
 * of the whole array that a concurrent `/eventshop` spend landing in between
 * would flatten — and the item was a bare `grantInventoryItem` that read nothing
 * back, both announced in an embed built before either write. Here they go
 * through the keyed helpers instead: exactly-once, recorded as a replayable owed
 * payload when they will not land, and — the reason this touches the embed — a
 * reward that is only owed is said to be owed rather than announced as delivered.
 *
 * The four share one interaction-keyed shape, so they share this. The `phase` in
 * each key keeps the currency and the item apart on the one `paidPayouts` array,
 * and apart from the 'coins' phase the call site keys the balance credit with.
 */

const { creditEventCurrencyOrOwe, grantItemsOrOwe } = require('./creditOrOwe');
const { eventActivityPayoutKey } = require('./payoutKey');

/**
 * Credits the currency and grants the item, then adds an "only owed" notice to
 * `embed` for whichever did not land. Never throws — a reward that cannot be
 * delivered is recorded, not raised, so the activity's reply still goes out.
 *
 * @param {import('discord.js').EmbedBuilder} embed  the win embed, mutated in place
 * @param {object} opts
 * @param {object} opts.filter         the user's `{ userId, guildId }`
 * @param {string} opts.activity       names the activity for the key and logs
 * @param {string} opts.interactionId  the opening interaction's id
 * @param {?string} opts.currencyId    the active event currency, or null for none
 * @param {number} opts.currencyAmount how much event currency the win pays
 * @param {string} opts.currencyLabel  its display name, e.g. 'Candy'
 * @param {string} opts.itemId         the themed bonus item
 * @param {string} opts.itemLabel      its display name, e.g. 'Candy Bag'
 * @returns {Promise<{currency: object, item: object}>} the helper results
 */
async function creditActivityReward(embed, {
    filter, activity, interactionId,
    currencyId, currencyAmount, currencyLabel,
    itemId, itemLabel,
}) {
    const currency = currencyId
        ? await creditEventCurrencyOrOwe(filter, currencyId, currencyAmount, {
            payoutKey: eventActivityPayoutKey(activity, interactionId, 'currency'),
            service:   activity,
            jobName:   'eventCurrency',
        })
        : { credited: true, owed: false };

    const item = await grantItemsOrOwe(filter, itemId, 1, {
        payoutKey: eventActivityPayoutKey(activity, interactionId, 'item'),
        service:   activity,
        jobName:   'bonusItem',
    });

    const owed = [];
    if (!currency.credited) owed.push(owedLine(currencyLabel, currency.owed));
    if (!item.granted)      owed.push(owedLine(itemLabel, item.owed));
    if (owed.length) {
        embed.addFields({ name: '⚠️ Not Yet Delivered', value: owed.join('\n') });
    }

    return { currency, item };
}

// The three-way the rest of the economy uses: a reward that is owed will arrive
// on a replay; one that could not even be recorded will not, and the two must
// not read the same to the player.
function owedLine(label, owed) {
    return owed
        ? `**${label}** couldn't be delivered just now and has been recorded as owed — it'll arrive once the problem clears. Tell an admin if it doesn't.`
        : `**${label}** couldn't be delivered and could not be recorded — please contact a server admin.`;
}

module.exports = { creditActivityReward };
