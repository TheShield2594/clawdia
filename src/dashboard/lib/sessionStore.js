'use strict';

const connectMongo = require('connect-mongo');

/**
 * Resolves the connect-mongo store class across the library's export shapes.
 *
 * connect-mongo 6 (#801 bumped it from 5) is dual-published ESM/CJS, and its
 * CommonJS build no longer sets `module.exports = MongoStore`. `require()` now
 * lands on the namespace object — `{ MongoStore, createKrupteinAdapter,
 * createWebCryptoAdapter, default }` — so the pre-v6 `MongoStore.create(...)`
 * became `undefined is not a function` and the bot died on boot with
 * "TypeError: MongoStore.create is not a function" before the dashboard was
 * ever served.
 *
 * Nothing caught the bump because createApp() takes an injected `sessionStore`
 * and every test passes a MemoryStore, so the one line that touches
 * connect-mongo was never executed outside production.
 *
 * Both shapes are accepted rather than just the current one: the named export
 * (v6), then the ESM default interop (v5 and v6), then the module itself (v5,
 * where the class *is* the export). The next major that shuffles them again
 * should not be a startup crash.
 */
const MongoStore = connectMongo?.MongoStore ?? connectMongo?.default ?? connectMongo;

/**
 * Builds the Mongo-backed express-session store the dashboard runs on.
 *
 * Throws instead of returning a broken store when connect-mongo's export shape
 * is one none of the branches above understand — an explicit "connect-mongo did
 * not export ..." at boot is a fixable message, where handing express-session a
 * non-store is a confusing failure several layers away.
 */
function createSessionStore(mongoUrl = process.env.MONGODB_URI) {
    if (typeof MongoStore?.create !== 'function') {
        throw new TypeError(
            'connect-mongo did not export a session store with a static create(); ' +
            'the installed version has an export shape src/dashboard/lib/sessionStore.js does not understand.'
        );
    }

    return MongoStore.create({ mongoUrl, collectionName: 'sessions' });
}

module.exports = { MongoStore, createSessionStore };
