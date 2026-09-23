'use strict';

/**
 * Load the AiItem rows for whichever of `itemIds` are forged (`ai_`) ids.
 *
 * Returns a plain `itemId -> doc` map, `{}` when there is nothing to look up or
 * the query fails. The name is cosmetic — `describeItem` falls back to the id —
 * so a failed lookup must never be the reason a command refuses. One query for
 * the whole batch, so it is affordable inside an autocomplete handler.
 */
async function loadAiItems(itemIds) {
    const forged = [...new Set((itemIds ?? []).map(String).filter(id => id.startsWith('ai_')))];
    if (!forged.length) return {};
    try {
        const AiItem = require('../models/AiItem');
        const docs = await AiItem.find({ itemId: { $in: forged } }, 'itemId name emoji rarity lore').lean();
        return Object.fromEntries(docs.map(d => [d.itemId, d]));
    } catch (err) {
        console.error('[aiItemLookup] AiItem lookup failed:', err);
        return {};
    }
}

module.exports = { loadAiItems };
