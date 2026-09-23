'use strict';

const AiItem = require('../models/AiItem');

/**
 * Load the AiItem rows for whichever of `itemIds` are forged (`ai_`) ids, for
 * `describeItem`.
 *
 * Returns a plain `itemId -> doc` map, `{}` when there is nothing to look up or
 * the query fails. A missing row is cosmetic for a name, but not for a value: a
 * forged item described without its row is priced as a Legendary, so callers
 * that price an item (the gift and trade caps) pass the row through.
 *
 * Moved out of `/gift` (#873, pass 21) so `/market` and `/trade` describe a
 * forged item the same way instead of printing its `ai_` id.
 */
async function loadAiItems(itemIds) {
    const forged = [...new Set((itemIds ?? []).filter(id => String(id).startsWith('ai_')))];
    if (!forged.length) return {};
    try {
        const docs = await AiItem.find({ itemId: { $in: forged } }, 'itemId name emoji rarity lore').lean();
        return Object.fromEntries(docs.map(d => [d.itemId, d]));
    } catch (err) {
        console.error('[items] AiItem lookup failed:', err);
        return {};
    }
}

module.exports = { loadAiItems };
