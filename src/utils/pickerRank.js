'use strict';

/**
 * How an item autocomplete orders and filters what it offers.
 *
 * `/use`, `/gift`, `/market` and the grind shops' `use` pickers each carried a
 * copy of the same comparator: prefix matches ahead of substring ones, then
 * A–Z. `/use` added a key in front of those (ready items first), which is the
 * `first` option here, so all of them rank the same way.
 */

/**
 * Whether an item matches what the player has typed so far, on its display
 * name or its raw id. `typed` is expected lowercased; empty matches everything.
 */
function matchesName(item, typed) {
    if (!typed) return true;
    return item.name.toLowerCase().includes(typed) || String(item.itemId ?? '').toLowerCase().includes(typed);
}

/**
 * Sorts a copy of `items` (anything with a `name`) for an autocomplete.
 *
 * Items for which `first(item)` is truthy come before the rest; within each
 * group, names starting with `typed` come ahead of the others, then A–Z.
 * `typed` is expected lowercased.
 */
function rankByName(items, typed, { first } = {}) {
    const lead = first ? item => (first(item) ? 0 : 1) : () => 0;
    const prefix = item => (typed && !item.name.toLowerCase().startsWith(typed) ? 1 : 0);
    return [...items].sort((a, b) =>
        (lead(a) - lead(b))
        || (prefix(a) - prefix(b))
        || a.name.localeCompare(b.name));
}

module.exports = { matchesName, rankByName };
