'use strict';

/**
 * A `getGuildSettings` that answers from whatever the suite already told the
 * Guild model to return.
 *
 * Commands read guild configuration through `utils/guildSettingsCache` instead
 * of `Guild.findOne` (#877), so a suite that stubs the model no longer stubs
 * the read the command makes. Rather than have every command suite carry a
 * second fixture that has to be kept in step with the first, this delegates:
 * it calls the mocked `Guild.findOne` and unwraps whatever shape that mock
 * hands back.
 *
 * Delegating rather than answering directly is what keeps the existing
 * assertions meaningful — a suite that parks `Guild.findOne` to hold a command
 * inside its critical section, or asserts the read never happened, still works
 * because the read still goes through the model mock.
 *
 * Usage, beside the Guild mock:
 *
 *     jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
 *     jest.mock('../src/utils/guildSettingsCache', () =>
 *         require('./helpers/guildSettingsCacheMock')());
 *
 * Nothing here caches. The real cache collapses repeated reads within its TTL;
 * a test double that did the same would make "how many times was the database
 * asked" depend on the order tests happen to run in.
 */

// The projection the real cache reads with. Passed through so a suite can
// assert the heavy fields are still excluded on this path.
const HEAVY_FIELDS_PROJECTION = '-giveaways.entrantIds';

/** Resolves the query-like shapes the model mocks in this repo return. */
async function unwrap(result) {
    let value = await result;
    if (value && typeof value.select === 'function') value = await value.select();
    if (value && typeof value.lean === 'function') value = await value.lean();
    value = await value;
    // The real cache converts a hydrated document; a mock may hand back either.
    if (value && typeof value.toObject === 'function') value = value.toObject();
    return value ?? null;
}

module.exports = function guildSettingsCacheMock() {
    const getGuildSettings = jest.fn(async guildId => {
        if (!guildId) return null;
        const Guild = require('../../src/models/Guild');
        return unwrap(Guild.findOne({ guildId }, HEAVY_FIELDS_PROJECTION));
    });

    return {
        getGuildSettings,
        invalidateGuildSettings: jest.fn(),
        clearGuildSettingsCache: jest.fn(),
        onGuildDocumentSaved: jest.fn(),
        onGuildQueryWrite: jest.fn(),
        setGuildSettingsTtl: jest.fn(),
        getGuildSettingsCacheStats: jest.fn(() => ({ size: 0, hits: 0, misses: 0, ttlMs: 0 })),
    };
};
