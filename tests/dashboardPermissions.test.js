'use strict';

const { hasManagePermission } = require('../src/dashboard/lib/permissions');
const { BoundedRateLimiter } = require('../src/utils/boundedRateLimiter');

const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

describe('hasManagePermission', () => {
    it('accepts MANAGE_GUILD and ADMINISTRATOR', () => {
        expect(hasManagePermission({ permissions: MANAGE_GUILD.toString() })).toBe(true);
        expect(hasManagePermission({ permissions: ADMINISTRATOR.toString() })).toBe(true);
    });

    it('accepts the guild owner regardless of bitfield', () => {
        expect(hasManagePermission({ owner: true, permissions: '0' })).toBe(true);
    });

    it('rejects a member with unrelated permissions', () => {
        const sendMessages = 1n << 11n;
        expect(hasManagePermission({ permissions: sendMessages.toString() })).toBe(false);
    });

    it('survives bitfields wider than 32 bits', () => {
        // The old `permissions & 0x20` check ran the value through ToInt32,
        // discarding everything above bit 31. Bit 5 happened to survive that,
        // but the check was only accidentally correct — these assert the real
        // contract on values Discord actually sends today.
        const highBit = 1n << 46n;
        expect(hasManagePermission({ permissions: (highBit | MANAGE_GUILD).toString() })).toBe(true);
        expect(hasManagePermission({ permissions: highBit.toString() })).toBe(false);
    });

    it('survives bitfields beyond Number.MAX_SAFE_INTEGER without losing low bits', () => {
        // Number("...") would round here and could flip bit 5 either way.
        const beyondSafe = 1n << 62n;
        expect(hasManagePermission({ permissions: (beyondSafe | MANAGE_GUILD).toString() })).toBe(true);
        expect(hasManagePermission({ permissions: beyondSafe.toString() })).toBe(false);
    });

    it('fails closed on missing or malformed input', () => {
        expect(hasManagePermission(undefined)).toBe(false);
        expect(hasManagePermission(null)).toBe(false);
        expect(hasManagePermission({})).toBe(false);
        expect(hasManagePermission({ permissions: 'not-a-number' })).toBe(false);
        expect(hasManagePermission({ permissions: {} })).toBe(false);
    });
});

describe('BoundedRateLimiter', () => {
    it('allows up to the limit inside the window, then blocks', () => {
        const rl = new BoundedRateLimiter(100);
        for (let i = 0; i < 3; i++) expect(rl.check('u1', 60_000, 3)).toBe(true);
        expect(rl.check('u1', 60_000, 3)).toBe(false);
    });

    it('tracks keys independently', () => {
        const rl = new BoundedRateLimiter(100);
        expect(rl.check('u1', 60_000, 1)).toBe(true);
        expect(rl.check('u1', 60_000, 1)).toBe(false);
        expect(rl.check('u2', 60_000, 1)).toBe(true);
    });

    it('never exceeds its key ceiling under a flood of unique keys', () => {
        // The reason this class exists: an unbounded Map keyed by user or
        // channel ID grows with every distinct key the bot ever sees.
        const rl = new BoundedRateLimiter(50);
        for (let i = 0; i < 5_000; i++) rl.check(`user-${i}`, 60_000, 5);
        expect(rl.size).toBeLessThanOrEqual(50);
    });

    it('forgets requests that have aged out of the window', () => {
        const rl = new BoundedRateLimiter(100);
        expect(rl.check('u1', 1, 1)).toBe(true);
        // A 1ms window means the recorded request is already outside it.
        return new Promise(resolve => setTimeout(() => {
            expect(rl.check('u1', 1, 1)).toBe(true);
            resolve();
        }, 5));
    });

    it('cleanup drops keys whose requests have all expired', async () => {
        const rl = new BoundedRateLimiter(100);
        rl.check('u1', 60_000, 5);
        expect(rl.size).toBe(1);
        await new Promise(r => setTimeout(r, 5));
        rl.cleanup(1);
        expect(rl.size).toBe(0);
    });
});
