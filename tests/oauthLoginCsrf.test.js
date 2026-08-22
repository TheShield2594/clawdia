'use strict';

// Without `state: true`, passport-oauth2 installs its NullStore: no state
// parameter goes out on the authorize redirect and none is checked on the way
// back, so /auth/callback accepts any `code` from anyone with nothing tying it to
// the session that began the login. That is login CSRF — an attacker starts a
// login, grabs their own code, and gets an operator to open
// /auth/callback?code=..., which silently signs that operator into the attacker's
// Discord identity. Whatever they configure next lands in the attacker's guild.
//
// The fix is one option. This asserts it, and asserts what passport actually
// builds from it, because "we passed state: true" and "a state store is installed"
// are different claims and only the second one defends anything.

const { Strategy: DiscordStrategy } = require('../src/dashboard/lib/discordStrategy');
const { discordStrategyOptions } = require('../src/dashboard/server');

const CALLBACK = 'https://dash.example.com/auth/callback';

// The options read the app's Discord credentials from the environment; passport
// refuses to build a strategy without them, and these tests build real ones.
const savedEnv = {};
beforeAll(() => {
    for (const key of ['CLIENT_ID', 'CLIENT_SECRET']) {
        savedEnv[key] = process.env[key];
        process.env[key] = `test-${key.toLowerCase()}`;
    }
});
afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('discordStrategyOptions', () => {
    test('asks for a state parameter', () => {
        expect(discordStrategyOptions(CALLBACK).state).toBe(true);
    });

    test('still carries the credentials, callback and scopes the dashboard needs', () => {
        const { scope, callbackURL, clientID, clientSecret } = discordStrategyOptions(CALLBACK);
        expect(callbackURL).toBe(CALLBACK);
        expect(clientID).toBe(process.env.CLIENT_ID);
        expect(clientSecret).toBe(process.env.CLIENT_SECRET);
        expect(scope).toEqual(expect.arrayContaining(['identify', 'guilds']));
    });
});

describe('the strategy passport actually builds', () => {
    const build = options => new DiscordStrategy(options, () => {});

    test('installs a session-backed state store, not the null one', () => {
        const strategy = build(discordStrategyOptions(CALLBACK));

        // Named SessionStore in passport-oauth2's lib/state/store.js — it
        // generates a nonce into req.session and verifies it on the callback.
        expect(strategy._stateStore.constructor.name).not.toBe('NullStore');
        expect(typeof strategy._stateStore.store).toBe('function');
        expect(typeof strategy._stateStore.verify).toBe('function');
    });

    // The control: this is precisely the shape the dashboard shipped with, and it
    // is what the assertion above would silently become if the option were dropped.
    test('and would install NullStore without the option', () => {
        const { state, ...withoutState } = discordStrategyOptions(CALLBACK);
        expect(state).toBe(true);
        expect(build(withoutState)._stateStore.constructor.name).toBe('NullStore');
    });

    test('the store round-trips a state value it issued', done => {
        const strategy = build(discordStrategyOptions(CALLBACK));
        const req = { session: {} };

        strategy._stateStore.store(req, (err, issued) => {
            expect(err).toBeNull();
            expect(typeof issued).toBe('string');
            expect(issued.length).toBeGreaterThan(0);

            strategy._stateStore.verify(req, issued, (verifyErr, ok) => {
                expect(verifyErr).toBeNull();
                expect(ok).toBe(true);
                done();
            });
        });
    });

    test('the store rejects a state value it never issued — the attack itself', done => {
        const strategy = build(discordStrategyOptions(CALLBACK));
        const victimSession = { session: {} };

        strategy._stateStore.store(victimSession, () => {
            strategy._stateStore.verify(victimSession, 'state-from-the-attackers-login', (err, ok) => {
                expect(err).toBeNull();
                expect(ok).toBe(false);
                done();
            });
        });
    });

    test('a callback with no login in progress does not verify', done => {
        const strategy = build(discordStrategyOptions(CALLBACK));

        strategy._stateStore.verify({ session: {} }, 'anything', (err, ok) => {
            expect(err).toBeNull();
            expect(ok).toBe(false);
            done();
        });
    });
});
