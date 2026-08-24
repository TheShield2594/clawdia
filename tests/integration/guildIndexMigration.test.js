'use strict';

/**
 * #576, executed rather than described.
 *
 * tests/guildIndexes.test.js reads the schema and the migration as text and
 * checks they agree. That catches drift, but it cannot catch the thing that
 * actually goes wrong with an index: a `partialFilterExpression` MongoDB
 * refuses, a compound index over two arrays it will not build, an
 * `ensureIndex` that drops the wrong one. All of those are server decisions,
 * and until #631 there was no server here to make them.
 *
 * So this runs migration 001 and migration 015 against a real mongod, in that
 * order, and checks what is left on the guilds collection afterwards.
 */

const mongoose = require('mongoose');

const { useMongo } = require('../helpers/mongo');

useMongo();

const Guild = require('../../src/models/Guild');
const migration001 = require('../../src/migrations/001_add_indexes');
const migration015 = require('../../src/migrations/015_drop_dead_giveaway_index');

const names = async () => (await mongoose.connection.db.collection('guilds').indexes())
    .map(i => i.name)
    .sort();

/** The guilds collection has to exist before an index can be dropped from it. */
async function seedGuild() {
    await Guild.create({ guildId: '111111111111111111', name: 'Seed' });
}

describe('001 then 015, against a real server', () => {
    test('001 builds the guilds indexes it declares', async () => {
        await seedGuild();

        await migration001.up();

        expect(await names()).toEqual(expect.arrayContaining([
            'idx_giveaways_active',
            'idx_guilds_rssfeeds',
        ]));
    });

    // The migration is the reason the dead index goes away on an existing
    // deployment: Mongoose builds the indexes a schema declares, and never
    // drops the ones it stops declaring.
    test('015 drops the giveaway index and leaves the RSS one', async () => {
        await seedGuild();
        await migration001.up();

        await migration015.up();

        const after = await names();
        expect(after).not.toContain('idx_giveaways_active');
        expect(after).toContain('idx_guilds_rssfeeds');
    });

    // A fresh database has never run 001, so there is nothing to drop. The
    // runner treats a throw as a failed migration, so swallowing IndexNotFound
    // is what stops a first boot reporting one.
    test('015 is a no-op on a database that never ran 001', async () => {
        await seedGuild();

        await expect(migration015.up()).resolves.toBeUndefined();
    });

    // Not merely idempotent in principle — the runner leaves an optional
    // migration unrecorded when it fails, so it is re-run on the next boot.
    test('015 runs twice without failing the second time', async () => {
        await seedGuild();
        await migration001.up();

        await migration015.up();
        await expect(migration015.up()).resolves.toBeUndefined();
    });

    test('001 is safe to re-run, which is what 015.down() relies on', async () => {
        await seedGuild();
        await migration001.up();
        await migration015.up();

        await migration015.down();

        expect(await names()).toContain('idx_giveaways_active');
    });
});

describe('the schema indexes build alongside the migration ones', () => {
    // The order a real boot uses: migrations run, then Mongoose autoIndex
    // builds what the schemas declare. `idx_guilds_rssfeeds` is declared in
    // both places under one name and one spec, and this is the assertion that
    // the two really are identical — a spec that differed by so much as
    // `sparse` would make createIndexes throw IndexOptionsConflict here.
    test('re-declaring idx_guilds_rssfeeds after 001 built it is not a conflict', async () => {
        await seedGuild();
        await migration001.up();

        // Throwing is the failure: IndexOptionsConflict is what MongoDB answers
        // when an index of this name already exists with a different spec.
        await Guild.createIndexes();

        const built = await mongoose.connection.db.collection('guilds').indexes();
        const rss = built.filter(i => i.name === 'idx_guilds_rssfeeds');
        expect(rss).toHaveLength(1);
        expect(rss[0].key).toEqual({ 'rssFeeds.0': 1 });
    });

    test('the schema replaces the dropped index with one the sweep can use', async () => {
        await seedGuild();
        await migration001.up();
        await migration015.up();
        await Guild.createIndexes();

        const after = await names();
        expect(after).not.toContain('idx_giveaways_active');
        expect(after).toContain('idx_guilds_giveaways');
    });

    // The point of the replacement: the sweep's filter has to be answerable
    // *from* the index. Forcing the plan rather than reading `explain` on
    // purpose — on a collection holding three documents the planner is entitled
    // to prefer a collection scan, so asserting which plan it picked would be a
    // flake. A hinted query answers the stronger question: run only against
    // this index, does the filter still find the right guilds? A sparse index
    // that did not contain the entry would answer with nothing.
    test('the giveaway sweep is answerable from the index it was given', async () => {
        await Guild.create({
            guildId: '111111111111111111', name: 'Has one',
            giveaways: [{
                messageId: 'm1', channelId: 'c1', prize: 'A nice hat',
                endsAt: new Date(Date.now() + 3_600_000), hostId: '222222222222222222',
            }],
        });
        await Guild.create({ guildId: '333333333333333333', name: 'Has none' });
        await Guild.createIndexes();

        const found = await Guild.find({ 'giveaways.0': { $exists: true } })
            .hint('idx_guilds_giveaways');

        expect(found.map(g => g.guildId)).toEqual(['111111111111111111']);
    });
});
