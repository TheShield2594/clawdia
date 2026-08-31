'use strict';

/**
 * The four `pre('save')` hooks, run without a server.
 *
 * Mongoose 9 calls document middleware with no `next` callback — kareem's
 * `execPre` is async and simply awaits what the hook returns — so the
 * callback-style hooks these models were written with (`function(next) { ...
 * next(); }`) received `undefined` and died on `next is not a function` the
 * moment anything was saved. Every one of them is now a plain function, and
 * User's duplicate-achievement guard aborts by throwing rather than by calling
 * `next(err)`.
 *
 * That guard had no test of any kind before this file, on either mechanism, so
 * the upgrade would have swapped one untested error path for another. It is
 * the one hook here doing something other than stamping a timestamp, and the
 * one whose behaviour — not just whose signature — changed.
 *
 * These run the hooks directly through the schema's kareem instance rather
 * than through `save()`, which would need a live connection and would put them
 * in the integration suite. The trade is a reach into `schema.s.hooks`: it is
 * how Mongoose invokes middleware internally, and a release that moves it
 * fails this file loudly rather than quietly stopping to check anything.
 */

const User = require('../src/models/User');
const Guild = require('../src/models/Guild');
const Conversation = require('../src/models/Conversation');
const Syndicate = require('../src/models/Syndicate');

/** Runs a model's registered pre('save') middleware against `doc`. */
const runPreSave = (Model, doc) => Model.schema.s.hooks.execPre('save', doc, []);

describe('pre-save hooks run under Mongoose 9', () => {
    describe('every model stamps updatedAt', () => {
        const cases = [
            ['User', User, { userId: 'u1', guildId: 'g1' }],
            ['Guild', Guild, { guildId: 'g1' }],
            ['Conversation', Conversation, { guildId: 'g1', channelId: 'c1', userId: 'u1' }],
            ['Syndicate', Syndicate, { syndicateId: 's1', guildId: 'g1', name: 'The Crew' }],
        ];

        test.each(cases)('%s', async (_name, Model, attrs) => {
            const doc = new Model(attrs);
            doc.updatedAt = undefined;

            await runPreSave(Model, doc);

            expect(doc.updatedAt).toBeInstanceOf(Date);
        });
    });

    test('Syndicate derives nameLower for the case-insensitive unique index', async () => {
        const doc = new Syndicate({ syndicateId: 's1', guildId: 'g1', name: 'The Crew' });

        await runPreSave(Syndicate, doc);

        expect(doc.nameLower).toBe('the crew');
    });

    describe('User rejects duplicate achievement ids', () => {
        test('a save carrying two of the same id does not go through', async () => {
            const doc = new User({
                userId: 'u1',
                guildId: 'g1',
                achievements: [{ id: 'first_blood' }, { id: 'first_blood' }],
            });

            await expect(runPreSave(User, doc))
                .rejects.toThrow('User achievements contains duplicate id values');
        });

        test('distinct ids are left alone', async () => {
            const doc = new User({
                userId: 'u1',
                guildId: 'g1',
                achievements: [{ id: 'first_blood' }, { id: 'big_spender' }],
            });

            await expect(runPreSave(User, doc)).resolves.not.toThrow();
        });

        test('a user with no achievements at all is not a duplicate', async () => {
            const doc = new User({ userId: 'u1', guildId: 'g1' });

            await expect(runPreSave(User, doc)).resolves.not.toThrow();
        });
    });
});
