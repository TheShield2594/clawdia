'use strict';

// Persisting effect-charge spends (#873, pass 15).
//
// `consumeEffect` and `refundEffectCharge` work on a loaded document, because
// the flows that call them decide inside synchronous service code (a hunt's
// death save, a cast's doubled yield) and cannot await a write at the moment
// they decide. What they must not do is persist through `save()`: that writes
// `activeEffects` back as the array the flow read, so an effect activated,
// spent or refunded by anything else in between was erased or restored — and
// `pruneEffects`, which reassigns the array whenever an entry has expired, made
// every flow that merely *checked* an effect and then saved do the same.
//
// So the array is kept out of `save()` altogether (the User model's pre-save
// hook calls `detachEffectWrites`), and the flow's net charge change is
// recorded on the document and committed as a guarded `$inc` once the save has
// landed (`applyEffectSpends`, from the post-save hook) — the same save-then-
// credit shape utils/balanceDelta.js uses for `balance`.

const { EFFECT_CONFIGS } = require('../data/effectConfigs');

const SPENDS_KEY = 'effectSpends';

/** Record a net charge change for `type` on a Mongoose document's `$locals`. */
function recordEffectSpend(user, type, n) {
    const locals = user?.$locals;
    if (!locals || !n) return;
    const spends = locals[SPENDS_KEY] ?? (locals[SPENDS_KEY] = {});
    spends[type] = (spends[type] ?? 0) + n;
    if (spends[type] === 0) delete spends[type];
}

/**
 * Take `activeEffects` out of the pending `save()` of an existing document, and
 * hand back the charge spends the flow recorded (clearing them), for
 * `applyEffectSpends` to commit after the save lands.
 *
 * A new document is left alone: its insert is the first write, with nothing
 * stored for a snapshot to overwrite.
 *
 * @returns {Object<string, number>|null} net charges spent per effect type
 *   (negative for a net refund), or null when there is nothing to commit.
 */
function detachEffectWrites(doc) {
    if (!doc || doc.isNew) return null;
    // Default-state paths too (#873, pass 19): a document stored without
    // `activeEffects` loads with the default `[]` filled in, and saved it over
    // an effect activated in between. models/seasonWrites.js found it.
    const defaults = doc.$__?.activePaths?.getStatePaths?.('default') ?? {};
    for (const path of new Set([...(doc.directModifiedPaths?.() ?? []), ...Object.keys(defaults)])) {
        if (path === 'activeEffects' || path.startsWith('activeEffects.')) doc.unmarkModified(path);
    }
    const spends = doc.$locals?.[SPENDS_KEY];
    if (!spends || !Object.keys(spends).length) return null;
    delete doc.$locals[SPENDS_KEY];
    return spends;
}

/**
 * Commit recorded charge spends as guarded writes, one effect type at a time.
 *
 * A spend decrements the stored entry only while it still holds that many
 * charges, then pulls the entry once it is empty. A spend that matches nothing
 * means the charge was already gone — used up or expired by another flow in
 * between — and is logged rather than driven below zero: the flow already
 * acted on it, and the stored state is the one to keep.
 *
 * A net refund puts the charges back on the live entry, capped at the effect's
 * full charge count, or re-adds the effect when spending its last charge had
 * removed it — `refundEffectCharge`'s rule, as a write.
 *
 * Never throws: it runs after a save that has already landed, and a failure
 * here must not turn that save into an error the caller would retry.
 */
async function applyEffectSpends(Model, filter, spends) {
    const results = {};
    for (const [type, n] of Object.entries(spends ?? {})) {
        try {
            if (n > 0) {
                const res = await Model.updateOne(
                    { ...filter, activeEffects: { $elemMatch: { type, charges: { $gte: n } } } },
                    { $inc: { 'activeEffects.$.charges': -n } },
                );
                if (!res?.matchedCount) {
                    console.warn(`[effects] ${n}x ${type} spent by ${filter.userId} was already gone`);
                    results[type] = 'gone';
                    continue;
                }
                await Model.updateOne(filter, { $pull: { activeEffects: { type, charges: 0 } } });
                results[type] = 'spent';
            } else {
                const back = -n;
                const cfg = EFFECT_CONFIGS[type];
                if (!cfg || cfg.charges === -1) continue;
                const res = await Model.updateOne(
                    { ...filter, activeEffects: { $elemMatch: { type, charges: { $gt: 0, $lte: cfg.charges - back } } } },
                    { $inc: { 'activeEffects.$.charges': back } },
                );
                if (res?.matchedCount) { results[type] = 'refunded'; continue; }
                await Model.updateOne(filter, { $pull: { activeEffects: { type, charges: 0 } } });
                const pushed = await Model.updateOne(
                    { ...filter, 'activeEffects.type': { $ne: type } },
                    { $push: { activeEffects: {
                        type,
                        expiresAt: cfg.durationMs ? new Date(Date.now() + cfg.durationMs) : null,
                        charges:   Math.min(back, cfg.charges),
                    } } },
                );
                results[type] = pushed?.matchedCount ? 'refunded' : 'full';
            }
        } catch (err) {
            console.error(`[effects] committing ${n}x ${type} for ${filter.userId} failed:`, err?.message);
            results[type] = 'failed';
        }
    }
    return results;
}


module.exports = { recordEffectSpend, detachEffectWrites, applyEffectSpends };
