'use strict';

/**
 * #1058. A gathering-shop purchase is a debit on User and a grant on the
 * buyer's GrindProfile with no shared key, so a grant that committed but lost
 * its response looked identical to one that never ran — and the refund fired on
 * both, handing back the coins for an item the player kept.
 *
 * The grant now stamps the purchase's key into `grantKeys` on the profile in the
 * same write, and `resolveShopGrant` reads it back after a throw to tell a
 * committed grant from an absent one. What these pin is the classification: the
 * refund must run only when the grant is confirmed absent, and a write whose
 * outcome cannot be read at all must not be refunded blind.
 */

jest.mock('../src/models/GrindProfile', () => ({ findOne: jest.fn() }));

const GrindProfile = require('../src/models/GrindProfile');
const { grantKeyPush, stampGrantKey, resolveShopGrant, GRANT_KEY_CAP } = require('../src/utils/shopGrant');

const IDENTITY = { userId: 'u1', guildId: 'g1', system: 'fishing' };

/** `GrindProfile.findOne(...).lean()` resolving to `doc`. */
function stubRead(doc) {
    GrindProfile.findOne.mockReturnValue({ lean: async () => doc });
}

beforeEach(() => {
    jest.resetAllMocks();
    stubRead(null);
});

describe('grantKeyPush', () => {
    test('stamps the key and front-evicts past the cap so the array stays bounded', () => {
        const push = grantKeyPush('k1');
        expect(push.grantKeys.$each[0].key).toBe('k1');
        expect(push.grantKeys.$each[0].at).toBeInstanceOf(Date);
        expect(push.grantKeys.$slice).toBe(-GRANT_KEY_CAP);
    });
});

describe('stampGrantKey', () => {
    test('appends the key to a profile that has none', () => {
        const profile = {};
        expect(stampGrantKey(profile, 'k1')).toBe(true);
        expect(profile.grantKeys.map(e => e.key)).toEqual(['k1']);
    });

    test('does not duplicate a key already present', () => {
        const profile = { grantKeys: [{ key: 'k1', at: new Date() }] };
        stampGrantKey(profile, 'k1');
        expect(profile.grantKeys.filter(e => e.key === 'k1')).toHaveLength(1);
    });

    test('keeps at most the cap, newest last', () => {
        const profile = { grantKeys: Array.from({ length: GRANT_KEY_CAP }, (_, i) => ({ key: `old${i}`, at: new Date() })) };
        stampGrantKey(profile, 'newest');
        expect(profile.grantKeys).toHaveLength(GRANT_KEY_CAP);
        expect(profile.grantKeys[profile.grantKeys.length - 1].key).toBe('newest');
        expect(profile.grantKeys[0].key).toBe('old1'); // old0 evicted from the front
    });

    test('is a no-op with no profile', () => {
        expect(stampGrantKey(null, 'k1')).toBe(false);
    });
});

describe('resolveShopGrant', () => {
    test('a grant write that returned a document is applied without a read', async () => {
        const state = await resolveShopGrant({ result: { data: {} }, threw: false, identity: IDENTITY, key: 'k1' });
        expect(state).toBe('applied');
        expect(GrindProfile.findOne).not.toHaveBeenCalled();
    });

    // The stack-cap `$expr` (or a missing profile) makes the write match nothing,
    // which resolves null without committing — a genuine no-grant, and never a
    // lost response. It refunds as before, and costs no extra read.
    test('a resolved null with no throw is absent, and reads nothing back', async () => {
        const state = await resolveShopGrant({ result: null, threw: false, identity: IDENTITY, key: 'k1' });
        expect(state).toBe('absent');
        expect(GrindProfile.findOne).not.toHaveBeenCalled();
    });

    // The bug's core case: the grant committed server-side, the response was
    // lost, so the write threw — but its key is on the profile.
    test('a thrown grant whose key is on the profile is applied, not refunded', async () => {
        stubRead({ grantKeys: [{ key: 'other' }, { key: 'k1' }] });
        const state = await resolveShopGrant({ result: null, threw: true, identity: IDENTITY, key: 'k1' });
        expect(state).toBe('applied');
    });

    test('a thrown grant whose key is absent is refunded', async () => {
        stubRead({ grantKeys: [{ key: 'other' }] });
        expect(await resolveShopGrant({ result: null, threw: true, identity: IDENTITY, key: 'k1' })).toBe('absent');
    });

    test('a thrown grant on a profile with no keys at all is refunded', async () => {
        stubRead({});
        expect(await resolveShopGrant({ result: null, threw: true, identity: IDENTITY, key: 'k1' })).toBe('absent');
    });

    test('a thrown grant with no profile document is refunded', async () => {
        stubRead(null);
        expect(await resolveShopGrant({ result: null, threw: true, identity: IDENTITY, key: 'k1' })).toBe('absent');
    });

    // Both the grant write and the read that would classify it failed. The grant
    // may have committed, so refunding blind risks the over-credit — leave it for
    // reconciliation instead.
    test('a thrown grant whose state cannot be read back is unresolved, not refunded', async () => {
        const errs = jest.spyOn(console, 'error').mockImplementation(() => {});
        GrindProfile.findOne.mockReturnValue({ lean: async () => { throw new Error('db down'); } });

        expect(await resolveShopGrant({ result: null, threw: true, identity: IDENTITY, key: 'k1' })).toBe('unresolved');
        errs.mockRestore();
    });
});
