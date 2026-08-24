'use strict';

/**
 * A real MongoDB, in-process, for the tests that need one (#631).
 *
 * The suite had 60 `jest.mock` calls against Mongoose models and not one
 * `mongoose` or `connect` anywhere, so nothing verified that the schemas
 * validate what they claim to, that the unique indexes are unique, or that the
 * aggregation-pipeline updates the economy is built on compute what they are
 * supposed to. A stubbed model answers whatever the stub was told to answer;
 * `{ $max: [0, { $subtract: ['$balance', 5] }] }` is either right or wrong
 * against a server, and against a stub it is neither.
 *
 * Standalone, not a replica set: PR #520 removed the MongoDB transactions this
 * codebase used, so nothing under test needs one, and a single mongod starts in
 * a fraction of the time.
 *
 * ── Running these ───────────────────────────────────────────────────────────
 *
 * `mongodb-memory-server` downloads a mongod binary on first use and caches it.
 * That download is the one thing here that can fail for reasons unrelated to
 * the code, so `useMongo()` fails with a message naming the cause and the two
 * ways out rather than a bare timeout:
 *
 *   MONGOMS_SYSTEM_BINARY=/path/to/mongod   use a mongod already installed
 *   MONGOMS_DOWNLOAD_URL=...                fetch it from a mirror
 *
 * A network that cannot reach either is a blocked suite, deliberately: skipping
 * on failure would make a green run mean "the integration tests did not run",
 * which is the state this file exists to end.
 */

const mongoose = require('mongoose');

// The binary download runs once per machine and is slow on a cold cache; every
// call after it is fast. Jest's default 5s would fail the first run on any
// clean checkout, including CI.
const BOOT_TIMEOUT_MS = 120_000;

/**
 * Boots a mongod for the calling test file and connects Mongoose to it.
 *
 * Registers its own before/after hooks, so a test file only has to call it once
 * at the top level. Documents and indexes are both cleared between tests:
 * leaking either into the next test is how an integration suite becomes
 * order-dependent, and the alternative — a fresh server per test — costs
 * seconds per case.
 *
 * Returns a handle whose `uri` is available once the server is up.
 */
function useMongo() {
    const handle = { uri: null, server: null };

    beforeAll(async () => {
        // Required lazily so that a checkout without the dev dependency
        // installed fails here, naming it, rather than at import time in a
        // file that has nothing to do with it.
        const { MongoMemoryServer } = require('mongodb-memory-server');

        try {
            handle.server = await MongoMemoryServer.create();
        } catch (err) {
            throw new Error(
                'Could not start an in-memory MongoDB.\n' +
                `  ${err.message}\n\n` +
                'mongodb-memory-server downloads a mongod binary on first use. If this\n' +
                'machine cannot reach fastdl.mongodb.org, point it at a mongod you\n' +
                'already have (MONGOMS_SYSTEM_BINARY=/path/to/mongod) or at a mirror\n' +
                '(MONGOMS_DOWNLOAD_URL=...). See tests/helpers/mongo.js.',
                { cause: err },
            );
        }

        handle.uri = handle.server.getUri();

        // autoIndex off. Mongoose otherwise builds every schema's indexes in
        // the background the moment it connects, without waiting — so a test
        // asserting that a unique index rejects a duplicate could run before
        // the index existed and fail, or run after and pass without ever having
        // asked for it. Here indexes exist only because a test called
        // buildIndexes(), which makes the index state of every test its own
        // statement rather than a race with the connection.
        await mongoose.connect(handle.uri, { autoIndex: false });
    }, BOOT_TIMEOUT_MS);

    afterEach(async () => {
        const collections = Object.values(mongoose.connection.collections);

        // Documents *and* indexes. Emptying the documents alone would leave an
        // index built by one test in place for the next, which is the whole
        // failure mode the index tests exist to catch — a test would then be
        // passing on a neighbour's setup.
        await Promise.all(collections.map(async c => {
            await c.deleteMany({});
            // dropIndexes leaves _id_ alone. NamespaceNotFound (26) is a
            // collection no test in this file ever created.
            await c.dropIndexes().catch(err => {
                if (err?.code !== 26) throw err;
            });
        }));
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await handle.server?.stop();
    });

    return handle;
}

/**
 * Builds the indexes every given model declares, and returns nothing.
 *
 * `useMongo` connects with autoIndex off, so nothing is indexed until a test
 * says so. This is how a test says so, and it waits for the build to finish.
 *
 * It is also an assertion in its own right: `createIndexes` is where a
 * malformed `partialFilterExpression` or an illegal parallel-array compound
 * index is rejected, and there is no other place that would ever notice.
 */
async function buildIndexes(...models) {
    for (const model of models) {
        await model.createIndexes();
    }
}

/** Index specs on a model's collection, keyed by index name. */
async function indexesByName(model) {
    const list = await model.collection.indexes();
    return Object.fromEntries(list.map(i => [i.name, i]));
}

module.exports = { useMongo, buildIndexes, indexesByName, BOOT_TIMEOUT_MS };
