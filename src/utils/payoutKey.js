'use strict';

/**
 * Exactly-once payouts (#807).
 *
 * Every path that credits a user and writes the credit down as owed on failure
 * is at-least-once, not exactly-once. A write can commit server-side and lose
 * its response — a dropped connection, a client timeout on a write that landed.
 * The caller sees a failure, records the payout as owed (src/utils/owedPayout.js),
 * and `npm run payouts:replay -- --pay` later applies it a second time. The
 * five-minute claim lease from #806 stops two replay *runs* racing each other;
 * this is the other half, duplicates across time from a write whose outcome was
 * never known.
 *
 * There is no transaction to reach for — the deployment is a standalone mongod
 * and PR #520 removed the transactions the codebase used — and a separate key
 * collection does not work either: the insert and the credit would be two
 * writes, so a crash between them loses the payout, which is the #804 failure
 * this is built on top of. The guard has to be in the *same* write as the
 * credit, which means it has to be in that write's filter.
 *
 * So the key lives on the user document and the credit writes it itself:
 *
 *     filter: { userId, guildId, 'paidPayouts.key': { $ne: key } }
 *     update: [{ $set: { balance: <credit>, paidPayouts: <append key> } }]
 *
 * A key already present makes the filter match nothing, so no coins move. An
 * aggregation-pipeline update because operator syntax cannot be mixed with the
 * aggregation expressions the append needs; the precedent is already in the
 * tree at src/commands/economy/daily.js:404-420 (a drop and the milestone flag
 * recording it, in one update) and in `extraSet` on src/utils/balanceDebit.js
 * and src/utils/inventoryGrant.js.
 *
 * `$concatArrays` rather than the idiomatic `$setUnion`, despite `$addToSet`
 * being what this looks like. `$setUnion` returns a *set*, with no defined
 * order, so the eviction below would drop arbitrary keys instead of the oldest
 * and the retention bound would mean nothing. The filter already guarantees the
 * key is absent, so a plain append is both correct and order-preserving.
 */

const DEFAULT_USER = require('../models/User');

/**
 * How long a key is honoured.
 *
 * This is a correctness parameter, not a tidiness one: once a key is evicted, a
 * replay of that payout double-pays again, exactly as it did before this
 * existed. So the window has to comfortably exceed the longest plausible gap
 * between a credit whose response was lost and an operator running
 * `npm run payouts:replay -- --pay`.
 *
 * Thirty days. The owed records that drive a replay surface on /health and in
 * the dashboard's dead-letter view as soon as the sweep fails, so the realistic
 * gap is hours; a month is two orders of magnitude of slack on that, and an
 * operator who finds a month-old owed record has bigger problems than a
 * double-paid 500 coins. Ageing rather than counting is deliberate — the bound
 * that matters is measured in operator response time, not in how many payouts
 * the user happened to receive meanwhile.
 */
const RETENTION_DAYS = 30;
const RETENTION_MS   = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Hard cap on the array, as a document-size backstop rather than a correctness
 * bound. Only payouts that can be replayed carry a key — the two scheduled
 * jobs, and the `commitBalanceDelta` callers that opt in — so a user earns a
 * handful a month and never approaches this. It exists so that a future caller
 * keying something high-frequency cannot grow an unbounded array on a document
 * that is read on nearly every command; if that ever happens, the eviction and
 * not the retention window decides, and the guarantee above weakens to "the
 * last 200 payouts".
 */
const KEY_CAP = 200;

/**
 * Filter clause that makes an already-applied payout match nothing.
 *
 * `field` is the document's key array, defaulting to the User document's
 * `paidPayouts`. The gathering-shop grant guard keys a `grantKeys` array on the
 * GrindProfile instead (#1058), so the same guard shape serves both.
 */
function payoutKeyGuard(key, field = 'paidPayouts') {
    return { [`${field}.key`]: { $ne: key } };
}

/**
 * Pipeline `$set` expression for `paidPayouts` after recording `key`: drops
 * anything past the retention window, then appends.
 *
 * `$$NOW` is the server's clock at the moment of the update, so the stamp does
 * not depend on the caller's. An entry with no `at` at all is *kept* rather than
 * pruned — keeping a key too long is a payout not made twice, dropping one early
 * is a payout made twice, and only one of those is worth defaulting to.
 */
function payoutKeyAppendExpr(key) {
    return {
        $slice: [
            {
                $concatArrays: [
                    {
                        $filter: {
                            input: { $ifNull: ['$paidPayouts', []] },
                            as: 'p',
                            cond: {
                                $gt: [
                                    { $ifNull: ['$$p.at', '$$NOW'] },
                                    { $subtract: ['$$NOW', RETENTION_MS] },
                                ],
                            },
                        },
                    },
                    [{ key, at: '$$NOW' }],
                ],
            },
            -KEY_CAP,
        ],
    };
}

/**
 * Pipeline `$set` expression that adds `amount` of `currencyId` to a user's
 * `eventCurrency` array (#873, pass 8).
 *
 * Event currency does not live in `balance` — it is an array of
 * `{ currencyId, amount }` entries — so a keyed credit cannot reuse the scalar
 * `$add` `creditCoinsOnce` uses. This bumps the matching entry, or appends a
 * fresh one when the player holds none of that currency yet, in one expression
 * so the "does an entry exist?" decision and the write are a single atomic
 * update — the same shape src/utils/inventoryGrant.js uses for the inventory
 * array, and the reason this can share `paidPayouts` with the coin and item
 * credits.
 *
 * `$mergeObjects` rather than a rebuilt literal so any other fields on an entry
 * (a subdocument `_id`, say) survive the bump; `$ifNull` on the amount so a
 * legacy entry written without one is treated as zero rather than nulling the
 * whole credit.
 */
function eventCurrencyCreditExpr(currencyId, amount) {
    return {
        $let: {
            vars: { arr: { $ifNull: ['$eventCurrency', []] } },
            in: {
                $cond: [
                    { $in: [currencyId, { $map: { input: '$$arr', as: 'e', in: '$$e.currencyId' } }] },
                    {
                        $map: {
                            input: '$$arr',
                            as: 'e',
                            in: {
                                $cond: [
                                    { $eq: ['$$e.currencyId', currencyId] },
                                    { $mergeObjects: ['$$e', { amount: { $add: [{ $ifNull: ['$$e.amount', 0] }, amount] } }] },
                                    '$$e',
                                ],
                            },
                        },
                    },
                    { $concatArrays: ['$$arr', [{ currencyId, amount }]] },
                ],
            },
        },
    };
}

/**
 * Why a guarded credit matched nothing.
 *
 * This is the whole reason the guard needs care. Before it, a `null` from
 * `findOneAndUpdate` meant one thing — no user document in that guild — and
 * #804 was about that being treated as success. With the key in the filter,
 * `null` also means "already paid", and the two want opposite handling: one is
 * owed and must be recorded, the other is done and must be dropped. Telling
 * them apart needs a second read, so here it is in one place rather than
 * open-coded at three call sites where one of them would get it wrong.
 *
 * Returns:
 *   'duplicate' — the key is on the document; the payout has already landed
 *   'missing'   — there is no document to credit; the payout is still owed
 *   'unknown'   — the document is there without the key, so the update should
 *                 have matched. Something wrote concurrently. Treated as owed
 *                 by callers, which is safe now: a replay carries the same key
 *                 and will guard itself.
 */
async function classifyUnmatchedPayout(Model, filter, key, field = 'paidPayouts') {
    const doc = await Model.findOne(filter, { [field]: 1 }).lean();
    if (!doc) return 'missing';
    return (doc[field] ?? []).some(entry => entry?.key === key) ? 'duplicate' : 'unknown';
}

/** True for the unique-index violation an upsert raises when the document exists. */
function isDuplicateKeyError(err) {
    return err?.code === 11000 || err?.code === 11001;
}

/**
 * Credits `amount` coins exactly once, keyed by `key`.
 *
 * No `upsert`: a payout is owed to a user who has played, and creating a
 * document for one who has none would resurrect pruned accounts. That keeps
 * `'missing'` meaning what it meant before the guard existed.
 *
 * @returns {Promise<{status: 'paid'|'duplicate'|'missing'|'unknown', doc: ?object}>}
 */
async function creditCoinsOnce(filter, amount, key, options = {}) {
    const { extraSet = {}, projection, Model = DEFAULT_USER, guard = {} } = options;

    const credited = await Model.findOneAndUpdate(
        { ...filter, ...guard, ...payoutKeyGuard(key) },
        [{
            $set: {
                balance:     { $add: [{ $ifNull: ['$balance', 0] }, amount] },
                paidPayouts: payoutKeyAppendExpr(key),
                ...extraSet,
            },
        }],
        projection
            ? { updatePipeline: true, new: true, projection }
            : { updatePipeline: true, new: true },
    );

    // `guard` is a *sanction* clause that rides only the update, never the
    // classification below. A frozen member's document is still there and still
    // without the key, so classifying it against a filter that carried the
    // freeze guard would answer 'missing' — and a caller acting on 'missing'
    // records the credit as owed and pays the frozen member the moment an
    // operator runs the replay, which is the sanction not being a sanction
    // (#873, pass 11). Classified against the plain `filter`, the same document
    // answers 'unknown', which the caller re-reads to tell a freeze refusal from
    // a genuine concurrent miss. The default `{}` leaves every existing caller
    // unchanged.
    if (credited) return { status: 'paid', doc: credited };
    return { status: await classifyUnmatchedPayout(Model, filter, key), doc: null };
}

/**
 * Grants `quantity` of `itemId` exactly once, keyed by `key`.
 *
 * The item side is cheaper than the coin side because `grantInventoryItem`
 * already takes an `extraSet` written in the same update; all it needed was the
 * guard on its filter.
 *
 * `upsert` is two steps rather than one. A guarded upsert on a document that
 * already carries the key matches nothing and so tries to *insert*, which the
 * unique `{ userId, guildId }` index rejects — a correct outcome reached by an
 * error, and an error that is indistinguishable from a genuine race unless the
 * classification is done first. So: guarded update, classify, and only actually
 * upsert when there is no document at all. The guard stays on the insert too,
 * so a document created in between still cannot be credited twice.
 *
 * A duplicate-key error from that insert is *not* read as "already paid". It
 * means only that a document now exists — which is true both when this payout
 * has already landed and when another writer simply created the user in
 * between, and in the second case nothing has been granted. Two sweeps
 * returning two expired listings to a seller with no document is exactly that
 * race, and calling it a duplicate would drop the second return without even
 * recording it as owed. So the guarded update is retried against the document
 * that now exists, and only then is the answer classified.
 *
 * @returns {Promise<{status: 'paid'|'duplicate'|'missing'|'unknown', doc: ?object}>}
 */
async function grantItemOnce(filter, itemId, quantity, key, options = {}) {
    const { extraSet = {}, upsert = false, Model = DEFAULT_USER } = options;
    const { grantInventoryItem } = require('./inventoryGrant');
    const { userId, guildId } = filter;

    const grantOptions = {
        extraSet: { paidPayouts: payoutKeyAppendExpr(key), ...extraSet },
        guard: payoutKeyGuard(key),
        Model,
    };
    const grant = extra => grantInventoryItem(userId, guildId, itemId, quantity, { ...grantOptions, ...extra });

    const granted = await grant();
    if (granted) return { status: 'paid', doc: granted };

    const status = await classifyUnmatchedPayout(Model, filter, key);
    if (status !== 'missing' || !upsert) return { status, doc: null };

    try {
        return { status: 'paid', doc: await grant({ upsert: true }) };
    } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;

        // Somebody created the document between the classification and the
        // insert. Whether this payout was part of what they wrote is what the
        // retry answers.
        const retried = await grant();
        if (retried) return { status: 'paid', doc: retried };
        return { status: await classifyUnmatchedPayout(Model, filter, key), doc: null };
    }
}

/**
 * Adds `amount` of `currencyId` event currency exactly once, keyed by `key`
 * (#873, pass 8).
 *
 * The event-currency counterpart to `creditCoinsOnce`: same guard, same
 * classification of a miss, same absence of `upsert` (a payout is owed to a
 * player who has played, so 'missing' keeps meaning "no document to credit").
 * Only the credited field differs — `eventCurrencyCreditExpr` writes the array
 * where `$add` on `balance` would go.
 *
 * @returns {Promise<{status: 'paid'|'duplicate'|'missing'|'unknown', doc: ?object}>}
 */
async function creditEventCurrencyOnce(filter, currencyId, amount, key, options = {}) {
    const { extraSet = {}, projection, Model = DEFAULT_USER } = options;

    const credited = await Model.findOneAndUpdate(
        { ...filter, ...payoutKeyGuard(key) },
        [{
            $set: {
                eventCurrency: eventCurrencyCreditExpr(currencyId, amount),
                paidPayouts:   payoutKeyAppendExpr(key),
                ...extraSet,
            },
        }],
        projection
            ? { updatePipeline: true, new: true, projection }
            : { updatePipeline: true, new: true },
    );

    if (credited) return { status: 'paid', doc: credited };
    return { status: await classifyUnmatchedPayout(Model, filter, key), doc: null };
}

/**
 * The key constructors, here rather than at the call sites, because the job that
 * pays and the replay that re-pays have to agree on the string exactly — a
 * mismatch is a guard that never fires and a double payment nobody notices.
 *
 * `week` is the ISO week bucket from src/utils/weeklyChampion.js, which is
 * already the unit the champion record is keyed by; `category` because a week
 * has one champion per competition. `listingId` is the market listing's `_id`,
 * which the job has already deleted by the time a credit can fail, so it is
 * unique for good.
 */
function weeklyChampionPayoutKey(week, category) {
    return `weekly:${week}:${category}`;
}

/**
 * The hourly competition this replaced is gone, and nothing builds one of these
 * any more. It stays because owed payouts outlive the job that owed them: a
 * credit that failed on the last hourly sweep before the switch is still in the
 * queue, and `npm run payouts:replay` has to rebuild the same key it was
 * originally guarded with or the replay pays a second time.
 */
function hourlyPayoutKey(hour, category) {
    return `hourly:${hour}:${category}`;
}

function listingPayoutKey(listingId) {
    return `listing:${listingId}`;
}

/**
 * The seller's proceeds from a completed sale (#869), as opposed to the stock
 * `listingPayoutKey` returns when the listing expires unsold.
 *
 * Two credits against one listing id, and only one of them can ever happen —
 * `/market buy` and the expiry sweep both delete the listing to claim it. They
 * are still keyed apart rather than sharing a key, because the guard is a string
 * comparison on the user document and nothing there records which of the two
 * wrote it; a shared key would let a replay of one silently satisfy the other.
 */
function marketSalePayoutKey(listingId) {
    return `listing:${listingId}:sale`;
}

/**
 * The item a market buyer paid for (#873).
 *
 * The buyer's credit is the one write in a purchase whose outcome the unwind
 * has to *know* rather than assume: the listing is already deleted, so a credit
 * that committed and lost its response looks exactly like one that never ran,
 * and unwinding on that reading hands the item to the seller as well. Keyed, it
 * is a question that can be asked — `classifyUnmatchedPayout` reads the key off
 * the buyer's own document — so the unwind runs only when the item genuinely did
 * not arrive.
 *
 * Keyed by the listing rather than the interaction, and apart from the sale and
 * the unwind for the same reason those are apart from each other: one listing,
 * three credits that can each happen at most once, and a guard that is a string
 * comparison with nothing on it to say which of them wrote it.
 */
function listingPurchasePayoutKey(listingId) {
    return `listing:${listingId}:buyer`;
}

/**
 * The stock coming back out of a listing the seller cancelled (#873).
 *
 * Keyed apart from `listingPayoutKey` for the reason `marketSalePayoutKey` is:
 * only one of a cancel, a sale and an expiry can ever happen to a listing, since
 * all three claim it by deleting it — but the guard is a string comparison on
 * the user document with nothing on it to say which one wrote it, and a shared
 * key would let a replay of one silently satisfy another.
 */
function listingCancelPayoutKey(listingId) {
    return `listing:${listingId}:cancel`;
}

/**
 * The seller's stock coming back when a sale could not be finished (#873).
 *
 * `/market buy` deletes the listing before crediting the buyer, so a credit that
 * fails leaves the item in nobody's bag: the buyer's coins go back, and this is
 * what puts the item back where it came from.
 */
function listingUnwindPayoutKey(listingId) {
    return `listing:${listingId}:unwind`;
}

/**
 * The stock coming back when a listing could not be created (#873).
 *
 * Keyed by the interaction rather than a listing, because there is no listing:
 * this is the stock a `/market list` took out of the seller's bag and then could
 * not find a slot for.
 */
function listingCreateRefundPayoutKey(interactionId) {
    return `market:${interactionId}:relist`;
}

/**
 * A market buyer's coins coming back when the purchase could not be completed
 * (#873).
 *
 * Keyed by the interaction rather than the listing, exactly as
 * `transferRefundPayoutKey` is: the same buyer trying the same listing again a
 * second later is a different purchase and refunds separately, and the listing
 * id alone would collide across those attempts and drop the second refund.
 */
function marketRefundPayoutKey(interactionId) {
    return `market:${interactionId}:refund`;
}

/**
 * A gifted item coming back to its sender when the recipient's credit missed
 * (#873).
 *
 * Keyed by the interaction, like the coin transfer's refund beside it: the same
 * sender gifting the same item to the same person again is a different gift and
 * unwinds separately.
 */
function giftItemRollbackPayoutKey(interactionId) {
    return `gift:${interactionId}:rollback`;
}

/**
 * One player's stake coming back out of a duel escrow, or the pot going to its
 * winner (#873).
 *
 * `duelId` is `${challengerId}_${Date.now()}`, built when the challenge is
 * posted, so it names this duel and nothing else. The phase is in the key
 * because a duel can owe a player at two different moments — the escrow rollback
 * when the second stake could not be taken, and the settlement that pays the
 * winner — and the guard is a string comparison on the user document with
 * nothing on it to say which of the two wrote it. A shared key would let a
 * replay of the refund silently satisfy the payout.
 */
function duelPayoutKey(duelId, userId, phase) {
    return `duel:${duelId}:${phase}:${userId}`;
}

/**
 * The keys a two-way trade credits under (#1010).
 *
 * A trade delivers up to four things that can each happen at most once: each
 * side receives the other's coins and the other's item. They are keyed apart —
 * by the trade, the party being credited and, for items, the item — because the
 * guard is a string comparison on the recipient's document with nothing on it to
 * say which credit wrote it, so a shared key would let a replay of one satisfy
 * another. The unwind that hands a committed asset back to its owner is keyed
 * apart again, since a return and a delivery of the same item are two grants
 * that must not stand in for each other.
 *
 * `tradeId` is `${aId}_${bId}_${Date.now()}`, minted when the trade opens, so it
 * names this trade and nothing else — the same shape `duelPayoutKey` uses, for
 * the same reason.
 */
function tradeCoinPayoutKey(tradeId, userId) {
    return `trade:${tradeId}:pay:${userId}`;
}

function tradeItemDeliverPayoutKey(tradeId, userId, itemId) {
    return `trade:${tradeId}:give:${userId}:${itemId}`;
}

function tradeItemReturnPayoutKey(tradeId, userId, itemId) {
    return `trade:${tradeId}:return:${userId}:${itemId}`;
}

/**
 * One side's reserved daily-cap allowance coming back when a trade unwinds
 * (#1025).
 *
 * A trade reserves the net value each side moves against their daily caps in the
 * take phase; a later take that fails hands those reservations back. The refund
 * is a counter decrement, not a coin credit, but it needs the same exactly-once
 * guard for the same reason the coin reversals do: a refund whose response is
 * lost is written down as owed and replayed, and a bare decrement replayed would
 * hand back the allowance twice. Keyed by the trade, the party and the budget
 * field so the four budgets a trade can touch refund independently and a replay
 * of one cannot satisfy another.
 */
function tradeBudgetRefundKey(tradeId, userId, field) {
    return `trade:${tradeId}:budget:${userId}:${field}`;
}

/**
 * One crew member's share of a group job — a `/heist` or a `/syndicate` raid
 * (#873).
 *
 * Both are keyed by the run's own id rather than by the guild and the hour: a
 * crew that fails a job and immediately runs another is owed two separate
 * shares, and a key that could not tell the runs apart would drop the second.
 */
function crewSharePayoutKey(jobId, userId) {
    return `crew:${jobId}:${userId}`;
}

/**
 * The founder's stake coming back when a `/syndicate found` could not create the
 * syndicate document (#873, pass 7).
 *
 * The command debits the 50k creation cost and enrolls the founder in one atomic
 * write, then creates the syndicate; a creation that throws has to hand the coins
 * back. That refund was a bare `$inc` that read nothing back and recorded
 * nothing, so a refund against a pruned or already-changed document moved no
 * coins and left the founder out the cost with no owed record — the pass-3
 * `/market` unwind shape. Keyed, it records the debt for `payouts:replay` and a
 * retry cannot refund twice.
 *
 * Keyed by the interaction, like the other refunds: the same founder trying the
 * same name again is a fresh attempt with a fresh `syndicateId` and refunds
 * separately.
 */
function syndicateFoundRefundPayoutKey(interactionId) {
    return `syndicate:${interactionId}:refund`;
}

/**
 * One place's prize in a fishing tournament (#873, pass 7).
 *
 * `endTournament` claims the tournament with an atomic `status: active → ended`
 * flip and then pays the top three out of the pool. The claim makes the payout
 * loop run once, but each credit inside it was a bare `$inc` that a transient
 * failure or a missing member left `paidOut: false` with nothing to settle it —
 * no owed record, no replay — while the winners embed announced the prize
 * regardless. Keyed, a prize that will not land is recorded as owed and a replay
 * cannot pay it twice.
 *
 * Keyed by the tournament and the place, which is stable: a tournament has one
 * winner per place and its `_id` is unique, so the key names this prize and
 * nothing else — and the same string rebuilds on a replay.
 */
function tournamentPrizePayoutKey(tournamentId, place) {
    return `tournament:${tournamentId}:place:${place}`;
}

/**
 * A season-pass tier reward — its coins and its item are keyed apart (#873, pass 7).
 *
 * `/season claim` records the tier as claimed in the same `save()` that detaches
 * the balance credit, then credits the coins and grants the item as their own
 * writes. Both were unrecoverable if they failed: the coins rode
 * `saveWithBalanceDelta` with no `payoutKey`, so a failure filed a keyless
 * `FailedJob` that `payouts:replay` cannot pay and a missing document was
 * reported as credited; the item was a bare `grantInventoryItem` whose `null`
 * (no document) read as success. Keyed, each is exactly-once and recorded as a
 * replayable owed payload — and the tier is already marked claimed, so without a
 * replayable record the reward is lost behind a permanent claim flag.
 *
 * `seasonId` is `user.season.seasonId`, so a reward claimed again in a *new*
 * season (which resets `claimedTiers`) gets a fresh key rather than colliding
 * with last season's. `track` is 'free' or 'premium', the two reward tracks a
 * tier carries. The coin and item keys are separate strings because a tier pays
 * both and the guard is a string comparison on the user document with nothing on
 * it to say which write recorded it — a shared key would let a replay of one
 * satisfy the other. `/season claim-all` grants each tier's item under this same
 * per-tier key, so claiming a tier alone and claiming it in a batch cannot both
 * land.
 */
function seasonTierCoinPayoutKey(seasonId, userId, tier, track) {
    return `season:${seasonId}:${userId}:tier:${tier}:${track}:coins`;
}

function seasonTierItemPayoutKey(seasonId, userId, tier, track) {
    return `season:${seasonId}:${userId}:tier:${tier}:${track}:item`;
}

/**
 * The summed coins of a `/season claim-all` batch (#873, pass 7).
 *
 * Claim-all credits the whole batch of tier coins as one `$inc` (the detached
 * balance delta), so it keys the one credit rather than each tier: the item side
 * keys per tier through `seasonTierItemPayoutKey` because items are separate
 * grants, but the coins are one write and one key. `signature` is the sorted
 * list of tiers the batch claimed, which makes two things true at once — a
 * failure records a replayable owed payload of the exact sum, and a
 * double-clicked claim-all that computes the same batch produces the same key,
 * so the second credit is a no-op rather than a double payment. A different
 * batch (a mission bumped the tier between clicks) has a different signature and
 * credits its own coins, as it should.
 *
 * Namespaced apart from the per-tier coin key so a batch can never collide with
 * an individual tier claim; the two claim disjoint tiers anyway, since claim-all
 * only touches tiers not already in `claimedTiers`.
 */
function seasonClaimAllCoinsPayoutKey(seasonId, userId, track, signature) {
    return `season:${seasonId}:${userId}:claimall:${track}:${signature}:coins`;
}

/**
 * The coins a `/season claim-mission` pays (#873, pass 7).
 *
 * The mission is marked `claimed` in the same `save()` that detaches the credit,
 * so a coin credit that then failed left the mission locked as claimed with the
 * coins in a keyless, unreplayable record. Keyed, the credit is exactly-once and
 * the failure is replayable.
 *
 * `missionDay` is `user.seasonMissionsDate` (midnight UTC of the day the set was
 * dealt) and `index` the mission's slot in that day's three, which together name
 * this mission instance: the same slot on a different day is a different mission,
 * so a key without the day would guard tomorrow's reward against today's replay.
 * `seasonId` is carried too, so a season rollover mid-day cannot alias the two.
 */
function seasonMissionCoinPayoutKey(seasonId, userId, missionDay, index) {
    return `season:${seasonId}:${userId}:mission:${missionDay}:${index}`;
}

/**
 * One claim on the progressive casino jackpot pool (#873).
 *
 * `claimId` is minted by the claim itself and written into the guild document
 * alongside the reset pool, so the live credit, the restart reconciler and
 * `payouts:replay` all rebuild the same string for the same pot. That is the
 * whole recovery design: the pool is claimed once and can then be credited from
 * three places at three different times, and the key is what makes all three
 * add up to one payment.
 *
 * Nothing about the win goes into it — not the guild's pool, not the amount, not
 * the winner. Two players can win identical pots minutes apart, and a key built
 * from what they won would make the second look like a replay of the first.
 */
function jackpotPayoutKey(guildId, claimId) {
    return `jackpot:${guildId}:${claimId}`;
}

/**
 * One settlement of one casino hand (#873).
 *
 * A hand is not one payment. Blackjack alone can credit a natural, a peeked
 * insurance side bet, two split halves and a doubled bet; a Monte run pays on
 * whichever round the player takes the money; higher-or-lower pays a cash-out
 * that may arrive from the button or from the collector timing out. Each of
 * those is a separate credit that has to be replayable on its own, so the phase
 * is in the key.
 *
 * `handId` is the opening interaction's id, which is the one identifier that
 * survives the whole hand: the collectors that settle it fire minutes later on
 * their own callbacks, and `Date.now()` read at settlement time would give the
 * retry inside `creditCoinsOrOwe` a different key from the attempt it is
 * retrying — which is the one thing the key exists to prevent.
 *
 * The phase is not the outcome. 'settle' is the same phase whether the hand won,
 * pushed or was saved by a lucky charm, because those are three amounts for one
 * payment and only one of them is ever credited. Naming the outcome instead
 * would let a replay of a push top up a win.
 */
function casinoPayoutKey(game, handId, phase) {
    return `casino:${game}:${handId}:${phase}`;
}

/**
 * The sender's refund when a coin transfer could not be completed (#868).
 *
 * Keyed by the interaction, which is the one identifier that names *this*
 * transfer: the same two users moving the same amount a second later is a
 * different transfer and must refund separately, so a key built from the pair
 * and the amount would collide and drop the second one.
 */
function transferRefundPayoutKey(interactionId) {
    return `transfer:${interactionId}:refund`;
}

/**
 * A `/invest contribute` refund when the district activated between the
 * pre-check and the pool write, so the debited coins belong to nobody (#873).
 *
 * Keyed by the interaction rather than the district, like the transfer refund
 * above: the same member investing the same amount in the same district again a
 * second later is a different contribution and refunds separately, and a key
 * built from the district alone would collide across those attempts and drop the
 * second refund.
 */
function investRefundPayoutKey(interactionId) {
    return `invest:${interactionId}:refund`;
}

/**
 * The coins a `/crime` earns on a clean getaway (#873).
 *
 * Unlike `/work` and `/daily`, whose payout and cooldown are one guarded write —
 * a credit that does not land leaves the cooldown unset and the run can be
 * retried — `/crime` claims its cooldown slot up front, before the ~30s button
 * flow, so the cooldown is already spent by the time the payout is credited. A
 * payout that then failed a bare `$inc` cost the player both the coins and the
 * cooldown with nothing written down. Keyed, the credit is recorded as owed when
 * it will not land, and a replay cannot pay it twice.
 *
 * Keyed by the opening interaction, which names this attempt: a crime resolves
 * once, so there is no replay within it, and the next `/crime` is a new
 * interaction after the cooldown clears.
 */
function crimePayoutKey(interactionId) {
    return `crime:${interactionId}:payout`;
}

/**
 * The bonus a `/work` shift or a `/daily` claim pays for answering its challenge
 * (#873).
 *
 * The base shift and claim are guarded, cooldown-carrying writes; the challenge
 * bonus that follows was a bare `$inc` credited minutes later from a collector
 * callback, announced as earned whether or not the write landed. Keyed by the
 * opening interaction — the one identifier that survives the collector — so a
 * credit whose response was lost is recorded once and a retry cannot pay twice.
 * The phase names which command paid it, so the two cannot collide on the rare
 * interaction id reuse across a restart.
 */
function challengeBonusPayoutKey(command, interactionId) {
    return `${command}:${interactionId}:challenge`;
}

/**
 * The coins a gathering run pays out — a `/hunt`, `/fish`, `/mine` or `/explore`
 * (#873).
 *
 * These are the highest-volume credits in the economy, and they were the last
 * to go unkeyed. Each run reads the user, mutates `balance` in memory across an
 * interactive window, and credits the net change through `commitBalanceDelta`
 * (src/utils/balanceDelta.js) after the save lands. Without a key that credit is
 * at-least-once: `commitBalanceDelta` retries the bare `$inc` up to three times,
 * so a write that committed and merely lost its response is credited again on
 * the retry, and a run against a pruned document is reported as paid while no
 * coins move — the #804 failure the keyed path exists to tell apart. Keyed, the
 * retry is a no-op, a missing document is recorded as owed, and the record
 * replays under the same key.
 *
 * Keyed by the opening interaction, which is the one identifier that survives
 * the run's own awaits — the approach, reel-in and encounter prompts all resolve
 * on collector callbacks minutes later. The `phase` is in the key because one
 * interaction can credit twice: a hunt pays its base haul and then its apex
 * bonus, a cast its catch and then its boss bonus, an expedition its find and
 * then its encounter. Naming the service too keeps the two commands that share
 * an interaction id across a restart from colliding, the same reason
 * `challengeBonusPayoutKey` carries its command.
 */
function gatherPayoutKey(service, interactionId, phase) {
    return `gather:${service}:${interactionId}:${phase}`;
}

/**
 * The coins a completed quest pays — the reward `awardQuest` hands out when a
 * daily or weekly quest, or an AI legendary quest, is finished (#873, pass 11).
 *
 * Every command and event that ticks a quest hook — `/hunt`, `/fish`, `/mine`,
 * `/explore`, `/work`, `/daily`, `/pet`, and the message, reaction and
 * command-use handlers — routes its reward through the one `awardQuest`, which
 * adds the coins to `balance` in memory for the flow's `save()` to persist as an
 * `$inc` (src/utils/balanceDelta.js). The gathering runs already fold that credit
 * into the run's keyed delta (`gatherPayoutKey`), but everywhere else it rode
 * `saveWithBalanceDelta` with no key — the pass-6 degraded branch: the retry
 * re-credits a write whose response was lost, a run against a pruned document is
 * reported as paid though no coins moved (#804), and a payout that ultimately
 * fails is filed as a keyless `FailedJob` that `payouts:replay` cannot settle.
 *
 * Keyed, the credit is exactly-once and a failure is a replayable owed `coins`
 * payload. The key is per *flow* rather than per quest, because the credit is one
 * `$inc` of the flow's whole delta and cannot carry a different key for each
 * quest folded into it — and per-flow is enough: a quest completes in exactly one
 * flow (its `completedAt` is set once and persisted by the save that runs before
 * the credit), so the flow's coins are one credit that must land once. The
 * message handler folds its streak-milestone coins into the same delta, and they
 * ride this key too — one write, one key.
 *
 * `scope` names the flow ('message', 'reaction', 'command', 'work', 'daily',
 * 'pet'), so two flows that reuse an `id` across a restart cannot collide, the
 * same reason `gatherPayoutKey` carries its service. `id` is the flow's own
 * identifier — the message id, the slash interaction id, or, for a pet action
 * driven by a button the player can click repeatedly, that button interaction's
 * id, so each click is its own credit rather than a duplicate of the first.
 */
function questRewardPayoutKey(scope, id) {
    return `quest:earn:${scope}:${id}`;
}

/**
 * A relic recovered on an expedition (#873).
 *
 * The relic is the one thing an expedition grants that does not ride the run's
 * own `save()`: a legendary treasure's relic is re-applied as an atomic upsert
 * right after the save, because `save()` would flatten a concurrent inventory
 * write (src/utils/inventoryGrant.js). That grant was a bare `grantInventoryItem`
 * that read nothing back and swallowed a throw into a log line, so a relic that
 * did not land was still announced as in the player's case — the item-side #873
 * pattern. Keyed, the grant is recorded as owed when it will not land, and a
 * replay cannot grant it twice.
 *
 * Keyed by the interaction: one expedition turns up at most one relic, and the
 * next `/explore go` is a new interaction.
 */
function exploreRelicPayoutKey(interactionId) {
    return `explore:${interactionId}:relic`;
}

/**
 * The item won from a seasonal loot box opened with `/use` (#873).
 *
 * `/use` consumes the box atomically and then granted the won item with a bare
 * `grantInventoryItem` — no result read, no record when it missed — over an
 * embed that announced the win regardless. The box is spent by the time the
 * grant runs, so a grant that failed lost the item with nothing to replay.
 * Keyed, it is recorded as owed and settles under the same key.
 *
 * Keyed by the interaction, which names this open: the same player opening
 * another box a moment later is a new interaction and grants separately.
 */
function lootBoxItemPayoutKey(interactionId) {
    return `lootbox:${interactionId}:item`;
}

/**
 * A shop purchase's coins coming back when the item could not be granted (#873).
 *
 * The gathering shops debit atomically against the balance, then grant the bait,
 * consumable, tool or upgrade under a stack-cap guard that a concurrent purchase
 * can make fail. The refund that followed was a bare `$inc` with `.catch(() =>
 * {})`, read nothing back, and told the player "your coins were refunded"
 * whether or not the write landed — the same unwind shape pass 3 found in
 * `/market`. Keyed, the refund is recorded as owed when it will not land and the
 * message is told only once it does.
 *
 * Keyed by the interaction, like the other refunds beside it: the same player
 * retrying the same purchase a second later is a different attempt and refunds
 * separately, so a key built from the item alone would collide and drop the
 * second refund.
 */
function shopRefundPayoutKey(interactionId) {
    return `shop:${interactionId}:refund`;
}

/**
 * A gathering-shop purchase's *item grant* (#1058), as opposed to the refund
 * that unwinds it.
 *
 * Stamped into `grantKeys` on the buyer's GrindProfile in the same write as the
 * grant, so a grant that committed but lost its response can be told from one
 * that never ran (utils/shopGrant.js) — the same commit-but-lost-response window
 * `listingPurchasePayoutKey` guards on the market's buyer credit, here on the
 * gathering shops' grant/debit side.
 *
 * Keyed by the interaction, like the refund beside it: the same player retrying
 * the same purchase a second later is a different attempt whose grant records
 * separately, so a key built from the item alone would collide across attempts.
 * A namespace apart from the refund key because the two live in different arrays
 * on different documents and record two different events.
 */
function shopGrantPayoutKey(interactionId) {
    return `shop:${interactionId}:grant`;
}

/**
 * The coins a gathering daily-quest claim pays — a `/hunt`, `/fish` or `/mine`
 * quest-board reward (#873, pass 9).
 *
 * The claim marks the quest entry `progress: -1` ("claimed") in the same
 * `save()` that detaches the coin credit, then credits through
 * `saveWithBalanceDelta` — which, with no key, is the pass-6 degraded branch: the
 * `$inc` is retried and re-credits a lost-response write, a missing document is
 * reported as paid, and a hard failure files a keyless `FailedJob`
 * `payouts:replay` cannot settle. Because the quest is already flagged claimed,
 * a failed credit locks the reward out with the coins in a non-replayable
 * record. Keyed, the credit is exactly-once and a failure is recorded as a
 * replayable owed `coins` payload.
 *
 * `service` ('hunt'/'fish'/'mine') keeps the three boards' identical template
 * ids from colliding; `questId` names the quest and `expiresAt` (the entry's
 * expiry, in ms) names *this* instance of it — the board re-deals the same
 * template ids each cycle, so a key without the expiry would guard next cycle's
 * reward against this cycle's replay.
 */
function questClaimPayoutKey(service, userId, questId, expiresAt) {
    return `quest:${service}:${userId}:${questId}:${expiresAt}`;
}

/**
 * A fishing-tournament entrant's fee coming back when their entry could not be
 * recorded (#873, pass 9).
 *
 * The fee funds the prize pool and is charged on a player's first catch of the
 * tournament; a `tournament.save()` that throws after the debit leaves the
 * player charged for an entry that did not persist. Keyed by the tournament and
 * the entrant — one entry per player per tournament, and both ids are stable —
 * so the refund records the debt for `payouts:replay` and a retry cannot refund
 * twice. Apart from `tournamentPrizePayoutKey`, which credits the same wallet
 * out of the same tournament: two credits, one guard that is a string comparison
 * with nothing on it to say which wrote it.
 */
function tournamentEntryRefundPayoutKey(tournamentId, userId) {
    return `tournament:${tournamentId}:entry:${userId}:refund`;
}

/**
 * The coins a `/forge` hands back when the item could not be made (#873, pass 9).
 *
 * `/forge` debits the cost, calls the AI, then persists the item; a failure on
 * either the AI or the persistence step refunds. That refund read its own result
 * back (so it never announced a refund that did not happen, unlike the shop
 * unwinds beside it), but it was a bare `$inc` with no key and no owed record —
 * a transient failure was lost with nothing to replay, and a refund whose
 * response was lost told the player to contact an admin over coins that had in
 * fact come back. Keyed, it is recorded as owed when it will not land and a
 * replay cannot refund twice.
 *
 * Keyed by the interaction, which names this forge: the AI-failure and
 * persistence-failure refunds are mutually exclusive within one `execute`, so
 * they share the key safely, and the next `/forge` is a new interaction.
 */
function forgeRefundPayoutKey(interactionId) {
    return `forge:${interactionId}:refund`;
}

/**
 * Coins, event currency or a bonus item paid by a seasonal-event activity —
 * `/event snowball`, `trickortreat`, `sandcastle`, `lovenote`, `trackhunt`, and
 * the event-currency drop `/explore` pays while an event runs (#873, pass 8).
 *
 * Each activity claims its cooldown up front and then, on a win, credits up to
 * three things that can each happen at most once: coins to `balance`, event
 * currency to `eventCurrency`, and a themed bonus item to `inventory`. Every one
 * was a bare write announced as paid regardless — the coin credit rode
 * `saveWithBalanceDelta` with no key (the pass-6 shape) or was a bare `$inc`, the
 * currency credit was a bare `$inc`/`$push`, and the item was a bare
 * `grantInventoryItem`. The `phase` ('coins', 'currency', 'item') splits the
 * three apart, because the guard is a string comparison on `paidPayouts` with
 * nothing on it to say which write recorded it, so a shared key would let a
 * replay of one satisfy another.
 *
 * `activity` keeps two events that reuse an interaction id across a restart from
 * colliding, the same reason `gatherPayoutKey` carries its service; keyed by the
 * opening interaction, which is the one identifier a flow with no long awaits and
 * a later replay both rebuild — the same player running the activity again after
 * the cooldown is a new interaction and credits separately.
 */
function eventActivityPayoutKey(activity, interactionId, phase) {
    return `event:${activity}:${interactionId}:${phase}`;
}

/**
 * An event-shop purchase's event currency coming back when the item or effect
 * could not be granted (#873, pass 8).
 *
 * `/eventshop buy` debits the currency atomically, then grants the item or adds
 * the effect; a grant that fails refunds the currency. That refund was a bare
 * `$inc` with `.catch(() => {})` that read nothing back and told the player the
 * purchase failed while, if the refund itself also failed, the currency was
 * simply gone — the pass-3 `/market` unwind shape, on the currency the keyed
 * helpers did not cover. Keyed, the refund is recorded as owed when it will not
 * land and a retry cannot refund twice.
 *
 * Keyed by the interaction, like the other refunds beside it: the same player
 * retrying the same purchase a second later is a different attempt and refunds
 * separately, so a key built from the item alone would collide and drop the
 * second refund.
 */
function eventShopRefundPayoutKey(interactionId) {
    return `eventshop:${interactionId}:refund`;
}

/**
 * The pot a `/pet battle` wager pays its winner (#873, pass 10).
 *
 * A wagered pet battle escrows both stakes atomically the moment the challenge
 * is accepted (each debit a guarded compare-and-set that is read back in the
 * same handler, so the forward direction is sound), then pays the winner the
 * pot less the house cut. That credit was a bare `$inc` that read nothing back
 * and announced the win regardless — the same durability gap the duel payout
 * had before pass 1, in the one wager outside `/duel` and the casino that puts a
 * player's own coins on an outcome. Keyed, a pot that will not land is recorded
 * as owed and a retry cannot pay it twice.
 *
 * `battleId` is the opening interaction's id — the one identifier that survives
 * the 60s challenge window and the collector callback that settles the fight, so
 * the live credit and its replay rebuild the same string. `winnerId` names the
 * wallet: two battles the same player wins are two separate interactions and pay
 * separately. Namespaced `:payout`, apart from the `:refund` a cancelled battle
 * files under the same `battleId`.
 */
function petBattlePayoutKey(battleId, winnerId) {
    return `pet:battle:${battleId}:${winnerId}:payout`;
}

/**
 * One escrowed stake coming back when a `/pet battle` wager does not happen
 * (#873, pass 10).
 *
 * A stake is handed back in two mutually exclusive places: the opponent cannot
 * cover the wager after the challenger's stake was taken, or a fighter became
 * unavailable between the challenge and its acceptance. Both were bare `$inc`s
 * that read nothing back and announced the refund regardless — the pass-3
 * `/market` unwind shape. The debit these reverse is known to have landed in the
 * same handler (its result was read), so an unconditional keyed credit is the
 * right compensation — the `rollbackStake` "taken moments ago in this same call"
 * case — and needs no keyed debit. Keyed, a refund that will not land is
 * recorded as owed and a retry cannot refund twice.
 *
 * Keyed by the battle and the player: one stake per player per battle, and the
 * two refund sites are mutually exclusive, so they share the key safely.
 * Namespaced `:refund`, apart from the winner's `:payout`.
 */
function petBattleRefundPayoutKey(battleId, userId) {
    return `pet:battle:${battleId}:${userId}:refund`;
}

/**
 * The adoption fee handed back when `/pet adopt` could not save the new pet
 * (#873, pass 10).
 *
 * The fee is charged with a guarded compare-and-set, then the pet is pushed and
 * the document saved; a save that throws has to give the fee back. That refund
 * was a bare `$inc` that read nothing back and told the player their coins were
 * refunded whether or not the write matched a document — the write it never
 * read that this issue names. Keyed, the refund is recorded as owed when it will
 * not land and a retry cannot refund twice.
 *
 * Keyed by the interaction, which names this adoption: the same player adopting
 * again after a failure is a new interaction and refunds separately.
 */
function petAdoptRefundPayoutKey(interactionId) {
    return `pet:adopt:${interactionId}:refund`;
}

/**
 * The item a `/shop buy` purchase stocks into the buyer's bag (#873, pass 14).
 *
 * The server shop debited atomically and then granted with a bare
 * `grantInventoryItem`: unkeyed, so a failure could not be told from a grant
 * that committed and lost its response, and a grant that failed was followed by
 * an unread refund. Keyed, the grant is exactly-once and is recorded as owed
 * when it will not land, so the buyer is owed the item they paid for rather
 * than refunded over a grant that may have happened.
 *
 * Keyed by the interaction that ran the purchase — the slash command, or the
 * browse view's buy button — because each is one purchase; the same item bought
 * again is a new interaction and grants separately. A namespace apart from
 * `shopGrantPayoutKey`, which the gathering shops stamp on a GrindProfile.
 */
function serverShopGrantPayoutKey(interactionId) {
    return `servershop:${interactionId}:grant`;
}

/**
 * The coins a `/shop buy` purchase hands back when it cannot complete (#873,
 * pass 14) — the stock sold out between the charge and the decrement, the item
 * could not be granted or recorded, or something threw after the charge.
 *
 * Each was a bare `$inc` that read nothing back under a reply saying the coins
 * had been refunded (and a throw after the charge refunded nothing at all) —
 * the pass-3 `/market` unwind shape, in the one storefront every server has.
 * Keyed by the interaction like the grant beside it; only one of the unwinds
 * can run for a given purchase, so they share one key.
 */
function serverShopRefundPayoutKey(interactionId) {
    return `servershop:${interactionId}:refund`;
}

/**
 * A role-granting item `/use` consumed and then could not apply (#873, pass 14).
 *
 * `/use` spends the item first so a double-click cannot grant twice, then adds
 * the role. When `roles.add` threw — a role above the bot's, a missing Manage
 * Roles permission — the item was already gone and nothing gave it back.
 * Keyed by the interaction, which names this one use.
 */
function useItemRestorePayoutKey(interactionId) {
    return `use:${interactionId}:restore`;
}

module.exports = {
    gatherPayoutKey, exploreRelicPayoutKey, lootBoxItemPayoutKey, shopRefundPayoutKey, shopGrantPayoutKey,
    questClaimPayoutKey, questRewardPayoutKey, tournamentEntryRefundPayoutKey, forgeRefundPayoutKey,
    weeklyChampionPayoutKey, hourlyPayoutKey, listingPayoutKey,
    marketSalePayoutKey, listingPurchasePayoutKey, listingCancelPayoutKey,
    listingUnwindPayoutKey,
    listingCreateRefundPayoutKey,
    marketRefundPayoutKey, transferRefundPayoutKey, giftItemRollbackPayoutKey,
    investRefundPayoutKey, crimePayoutKey, challengeBonusPayoutKey,
    duelPayoutKey, crewSharePayoutKey,
    syndicateFoundRefundPayoutKey, tournamentPrizePayoutKey,
    seasonTierCoinPayoutKey, seasonTierItemPayoutKey,
    seasonClaimAllCoinsPayoutKey, seasonMissionCoinPayoutKey,
    tradeCoinPayoutKey, tradeItemDeliverPayoutKey, tradeItemReturnPayoutKey,
    tradeBudgetRefundKey,
    jackpotPayoutKey, casinoPayoutKey,
    eventActivityPayoutKey, eventShopRefundPayoutKey,
    petBattlePayoutKey, petBattleRefundPayoutKey, petAdoptRefundPayoutKey,
    serverShopGrantPayoutKey, serverShopRefundPayoutKey, useItemRestorePayoutKey,
    payoutKeyGuard, payoutKeyAppendExpr, eventCurrencyCreditExpr, classifyUnmatchedPayout,
    creditCoinsOnce, grantItemOnce, creditEventCurrencyOnce, isDuplicateKeyError,
    RETENTION_DAYS, RETENTION_MS, KEY_CAP,
};
