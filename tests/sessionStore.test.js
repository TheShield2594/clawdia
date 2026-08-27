'use strict';

const fs = require('fs');
const path = require('path');
const session = require('express-session');

const { MongoStore, createSessionStore } = require('../src/dashboard/lib/sessionStore');

// #801 bumped connect-mongo from 5 to 6, and v6's CommonJS build stopped
// setting `module.exports = MongoStore`. The dashboard's `MongoStore.create(...)`
// therefore became a call on the namespace object, and the bot died on boot:
//
//   TypeError: MongoStore.create is not a function
//       at createApp (src/dashboard/server.js:254)
//
// Nothing in the suite noticed, because createApp() takes an injected
// `sessionStore` and every test hands it a MemoryStore — the line that touches
// connect-mongo was only ever executed in production. These tests execute it.

const SAVED_URI = process.env.MONGODB_URI;

afterEach(() => {
    if (SAVED_URI === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = SAVED_URI;
    jest.restoreAllMocks();
});

describe('the store resolved from the installed connect-mongo', () => {
    it('has the static create() the dashboard calls', () => {
        expect(typeof MongoStore.create).toBe('function');
    });

    it('is an express-session store, which is what session() will accept', () => {
        expect(MongoStore.prototype).toBeInstanceOf(session.Store);
    });
});

describe('createSessionStore()', () => {
    it('builds the store from MONGODB_URI, in the sessions collection', () => {
        const create = jest.spyOn(MongoStore, 'create').mockReturnValue('the store');
        process.env.MONGODB_URI = 'mongodb://mongo.example:27017/clawdia';

        expect(createSessionStore()).toBe('the store');
        expect(create).toHaveBeenCalledWith({
            mongoUrl: 'mongodb://mongo.example:27017/clawdia',
            collectionName: 'sessions',
        });
    });

    it('takes an explicit URL over the environment', () => {
        const create = jest.spyOn(MongoStore, 'create').mockReturnValue('the store');
        process.env.MONGODB_URI = 'mongodb://from-the-environment/clawdia';

        createSessionStore('mongodb://explicit/clawdia');
        expect(create).toHaveBeenCalledWith({
            mongoUrl: 'mongodb://explicit/clawdia',
            collectionName: 'sessions',
        });
    });
});

// The resolution is deliberately version-tolerant, so each shape it claims to
// understand is asserted against a stand-in for that version of the library.
describe('the export shapes it understands', () => {
    afterEach(() => {
        jest.dontMock('connect-mongo');
    });

    function resolveAgainst(moduleExports) {
        let module;
        jest.isolateModules(() => {
            jest.doMock('connect-mongo', () => moduleExports);
            module = require('../src/dashboard/lib/sessionStore');
        });
        return module;
    }

    it('takes the named export, which is where connect-mongo 6 puts the class', () => {
        class Store6 { static create() { return 'v6 store'; } }
        const resolved = resolveAgainst({
            MongoStore: Store6,
            default: Store6,
            createKrupteinAdapter: () => {},
            createWebCryptoAdapter: () => {},
        });

        expect(resolved.MongoStore).toBe(Store6);
        expect(resolved.createSessionStore('mongodb://x/y')).toBe('v6 store');
    });

    it('takes the module itself, which is what connect-mongo 5 exported', () => {
        class Store5 { static create() { return 'v5 store'; } }
        const resolved = resolveAgainst(Store5);

        expect(resolved.MongoStore).toBe(Store5);
        expect(resolved.createSessionStore('mongodb://x/y')).toBe('v5 store');
    });

    it('names connect-mongo when the shape is one it cannot read, instead of handing session() a non-store', () => {
        const resolved = resolveAgainst({ somethingElse: true });

        expect(() => resolved.createSessionStore('mongodb://x/y'))
            .toThrow(/connect-mongo did not export a session store/);
    });
});

it('is the only place the dashboard reaches for connect-mongo', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'server.js'), 'utf8');
    expect(server).not.toMatch(/require\(['"]connect-mongo['"]\)/);
});
