'use strict';

/**
 * Confirming a gathering-shop item grant (#1058).
 *
 * A gathering-shop purchase is two writes in two collections with no shared key:
 * an atomic debit on the User document, then a grant on the buyer's GrindProfile
 * (a `$inc` on a bait/consumable/ammo/charge stack, a `$push` onto a tool array,
 * or — for a rod or its upgrade — the wrapped `save()` that co-saves the fishing
 * profile). The debit's outcome is always known: it is read back before the grant
 * runs. The grant's is not. A grant that committed server-side and then lost its
 * response — a dropped connection, a client timeout on a write that landed — threw
 * to the handler, which read the throw as "the grant did not happen" and refunded
 * the debit. The player kept the item and got the coins back.
 *
 * The fix mirrors the exactly-once payout keys (utils/payoutKey.js): the grant
 * stamps the purchase's key into a `grantKeys` array on the GrindProfile *in the
 * same write*, so a grant that committed carries the key whether or not its
 * response arrived. After a throw the key is read back to tell a committed grant
 * from one that never ran, and the refund is gated on a grant confirmed absent.
 *
 * There is no guard on the grant's own filter and no replay of it: the grant runs
 * exactly once per purchase, so the key exists to *answer* whether a thrown write
 * landed, not to *block* a second application. A grant that resolves `null`
 * (the stack-cap `$expr` matched nothing, or the profile is missing) is a genuine
 * no-match and never a lost commit, so it still refunds exactly as before —
 * unchanged, and without the extra read the throw path pays for.
 */

const GrindProfile = require('../models/GrindProfile');
const { classifyUnmatchedPayout } = require('./payoutKey');

/**
 * How many purchase keys a profile keeps.
 *
 * Not a correctness parameter like the payout keys' retention window: nothing
 * replays a shop grant, so a key only has to survive from the grant write until
 * the classification read that follows it a moment later. The cap is a
 * document-size backstop on an array that a purchase appends one entry to and
 * that is read on the buyer's own commands.
 */
const GRANT_KEY_CAP = 50;

function grantKeyEntry(key) {
    return { key, at: new Date() };
}

/**
 * The `$push` that stamps `key` into `grantKeys`, front-evicting past the cap.
 * Spread into the grant's own `$push` (alongside the tool it pushes) or used on
 * its own beside an `$inc`, so the key and the grant commit together.
 */
function grantKeyPush(key) {
    return { grantKeys: { $each: [grantKeyEntry(key)], $slice: -GRANT_KEY_CAP } };
}

/**
 * Stamp `key` onto an attached GrindProfile in memory, for the rod and upgrade
 * grants that persist through `save()` rather than an atomic update. The same
 * `save()` that writes the grant writes the marker.
 */
function stampGrantKey(profile, key) {
    if (!profile) return false;
    const kept = (profile.grantKeys || []).filter(entry => entry?.key !== key);
    profile.grantKeys = [...kept, grantKeyEntry(key)].slice(-GRANT_KEY_CAP);
    return true;
}

/**
 * What the grant's outcome actually was.
 *
 *   'applied'    — the grant landed (the write returned a document, or a thrown
 *                  write's key is on the profile). The item is the player's; do
 *                  not refund.
 *   'absent'     — the grant did not land (the write matched nothing, or a thrown
 *                  write left no key). Refund the debit, as before.
 *   'unresolved' — the write threw and its outcome could not be read back either.
 *                  The grant may or may not have committed, so refunding risks the
 *                  over-credit this fix exists to prevent. Recorded for
 *                  reconciliation and left un-refunded.
 *
 * @param {object}  args
 * @param {*}       args.result   the grant write's return (a document, or null)
 * @param {boolean} args.threw    whether the grant write rejected
 * @param {object}  args.identity { userId, guildId, system } to re-read by
 * @param {string}  args.key      the purchase key stamped into `grantKeys`
 * @returns {Promise<'applied'|'absent'|'unresolved'>}
 */
async function resolveShopGrant({ result, threw, identity, key, Model = GrindProfile }) {
    if (result) return 'applied';
    // A resolved `null` is a real no-match — a `findOneAndUpdate` that matched
    // nothing does not commit — so there is nothing to disambiguate and no read
    // to spend. Only a throw is the commit-but-lost-response window.
    if (!threw) return 'absent';

    try {
        const status = await classifyUnmatchedPayout(Model, identity, key, 'grantKeys');
        // 'duplicate' — the key is on the profile, so the thrown write committed.
        // 'unknown'/'missing' — the profile is there without the key, or not there
        // at all, so the grant never landed.
        return status === 'duplicate' ? 'applied' : 'absent';
    } catch (err) {
        console.error('[shop] could not resolve grant state after a lost write:', err?.message, { identity, key });
        return 'unresolved';
    }
}

module.exports = { GRANT_KEY_CAP, grantKeyPush, stampGrantKey, resolveShopGrant };
