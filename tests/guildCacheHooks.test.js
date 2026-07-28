'use strict';

// No jest.mock here — this suite loads the real Guild model to confirm the cache
// invalidation middleware is actually attached to the compiled schema.
//
// Mongoose only honours middleware registered before model() compiles the
// schema, so a hook added in the wrong place fails silently: writes succeed,
// nothing invalidates, and the hot paths serve stale settings until the TTL
// expires. The unit tests in guildSettingsCache.test.js cover what the handlers
// do; this covers that they are wired in at all.

const Guild = require('../src/models/Guild');

// Every Mongoose entry point that can modify a Guild. Anything writing through
// one of these must drop the guild's cached settings.
const WRITE_HOOKS = [
    'save',
    'findOneAndUpdate',
    'updateOne',
    'updateMany',
    'findOneAndDelete',
    'deleteOne',
    'deleteMany',
    'replaceOne',
];

describe('Guild cache invalidation middleware', () => {
    const registered = Guild.schema.s.hooks._posts;

    it.each(WRITE_HOOKS)('registers a post(%s) hook', (hookName) => {
        expect(registered.has(hookName)).toBe(true);
        expect(registered.get(hookName).length).toBeGreaterThan(0);
    });

    // Mongoose registers its own internal plugins on these same hooks (subdocument
    // bookkeeping and the like), and invoking those outside a real save crashes.
    // Pick out the project's handler by its source instead of calling them all.
    function ownHandler(hookName) {
        const found = (registered.get(hookName) || [])
            .map(h => h.fn || h)
            .filter(fn => typeof fn === 'function' && /cacheHook/.test(Function.prototype.toString.call(fn)));
        expect(found).toHaveLength(1);
        return found[0];
    }

    it('routes save hooks into the cache module', () => {
        const cache = require('../src/utils/guildSettingsCache');
        const spy = jest.spyOn(cache, 'onGuildDocumentSaved');

        ownHandler('save').call({}, { guildId: 'hook-test-guild' });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'hook-test-guild' }));
        spy.mockRestore();
    });

    it('routes query-write hooks into the cache module with the query as context', () => {
        const cache = require('../src/utils/guildSettingsCache');
        const spy = jest.spyOn(cache, 'onGuildQueryWrite');

        const query = { getFilter: () => ({ guildId: 'hook-test-guild' }) };
        ownHandler('findOneAndUpdate').call(query);

        expect(spy).toHaveBeenCalledWith(query);
        spy.mockRestore();
    });

    it.each(WRITE_HOOKS)('wires the project handler into post(%s)', (hookName) => {
        expect(() => ownHandler(hookName)).not.toThrow();
    });
});
