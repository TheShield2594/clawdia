'use strict';

// utils/grindRecord — the server record a result card marks on its gauge, and
// where a payout stands against it.

const GrindProfile = require('../src/models/GrindProfile');
const { serverBest, standing } = require('../src/utils/grindRecord');

function chain(result) {
    const q = { sort: jest.fn(() => q), maxTimeMS: jest.fn(() => q), lean: jest.fn(() => result) };
    return q;
}

describe('serverBest', () => {
    afterEach(() => { delete GrindProfile.findOne; });

    test('reads the named system\'s named field, highest-first, bounded, excluding the player', async () => {
        const q = chain(Promise.resolve({ data: { bestHaul: 7200 } }));
        GrindProfile.findOne = jest.fn(() => q);

        expect(await serverBest('g1', 'exploration', 'bestHaul', 'u1')).toBe(7200);
        const [filter, projection] = GrindProfile.findOne.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', system: 'exploration', userId: { $ne: 'u1' }, 'data.bestHaul': { $gt: 0 } });
        expect(projection).toEqual({ 'data.bestHaul': 1 });
        expect(q.sort).toHaveBeenCalledWith({ 'data.bestHaul': -1 });
        expect(q.maxTimeMS).toHaveBeenCalledWith(2000);
    });

    test('is zero when nobody else has one, and unknown when the read fails', async () => {
        GrindProfile.findOne = jest.fn(() => chain(Promise.resolve(null)));
        expect(await serverBest('g1', 'mining', 'bestPayout', 'u1')).toBe(0);
        GrindProfile.findOne = jest.fn(() => chain(Promise.reject(new Error('timeout'))));
        expect(await serverBest('g1', 'mining', 'bestPayout', 'u1')).toBeNull();
        GrindProfile.findOne = jest.fn(() => { throw new Error('not connected'); });
        expect(await serverBest('g1', 'mining', 'bestPayout', 'u1')).toBeNull();
    });

    test('gives up on a read that never settles (buffered while disconnected) after ~2s', async () => {
        jest.useFakeTimers();
        try {
            GrindProfile.findOne = jest.fn(() => chain(new Promise(() => {})));
            const pending = serverBest('g1', 'hunt', 'bestPayout', 'u1');
            await jest.advanceTimersByTimeAsync(1999);
            let settled = false;
            pending.then(() => { settled = true; });
            await Promise.resolve();
            expect(settled).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(await pending).toBeNull();
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('clears its timer when the read settles, either way', async () => {
        jest.useFakeTimers();
        try {
            GrindProfile.findOne = jest.fn(() => chain(Promise.resolve({ data: { bestPayout: 10 } })));
            expect(await serverBest('g1', 'hunt', 'bestPayout', 'u1')).toBe(10);
            expect(jest.getTimerCount()).toBe(0);
            GrindProfile.findOne = jest.fn(() => chain(Promise.reject(new Error('boom'))));
            expect(await serverBest('g1', 'hunt', 'bestPayout', 'u1')).toBeNull();
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('every field a card asks for has an index to serve it', () => {
        const indexed = GrindProfile.schema.indexes().map(([fields]) => Object.keys(fields).join(','));
        expect(indexed).toContain('guildId,system,data.bestPayout');
        expect(indexed).toContain('guildId,system,data.bestHaul');
    });
});

describe('standing', () => {
    test('beating everyone\'s best is a server record, and a personal best too', () => {
        expect(standing(5000, { priorBest: 3000, othersBest: 4000 }))
            .toEqual({ best: 3000, record: 4000, personalBest: true, serverRecord: true });
    });

    test('the record counts the player\'s own best when it is the biggest', () => {
        expect(standing(4500, { priorBest: 5000, othersBest: 4000 })).toMatchObject({ record: 5000, personalBest: false, serverRecord: false });
    });

    test('a first-ever payout is not a personal best, and an unknown record claims nothing', () => {
        expect(standing(100, { priorBest: 0, othersBest: 50 }).personalBest).toBe(false);
        expect(standing(1e9, { priorBest: 10, othersBest: null })).toMatchObject({ record: null, serverRecord: false });
        expect(standing(0)).toEqual({ best: 0, record: null, personalBest: false, serverRecord: false });
    });
});
