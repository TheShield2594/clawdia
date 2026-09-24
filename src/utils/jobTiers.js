'use strict';

const DEFAULT_TIERS = require('../data/defaultTiers');

/** The guild's four job tiers, lowest first, or the defaults when it has none. */
function resolveTiers(guildSettings) {
    const saved = guildSettings?.jobTiers;
    if (saved?.length === 4) return [...saved].sort((a, b) => a.tier - b.tier);
    return DEFAULT_TIERS;
}

module.exports = { resolveTiers };
