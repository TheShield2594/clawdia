'use strict';

// #1015 — the first-response half of the Mod SLA. `firstActionAt` marks when a
// moderator first acted on a case after it was opened, and the load-bearing
// property is that it is set *once*: the first note or close stamps it, a later
// one must not move it. Both writers express that as a pipeline update with
// `$ifNull`, so the mark is filled only when empty, atomically, with no
// read-back to race.

jest.mock('../src/models/Case', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const Case = require('../src/models/Case');
const { addNote, closeCase } = require('../src/services/caseService');

// Pull the one `$set` stage out of a pipeline update passed to findOneAndUpdate.
function setStage(call) {
    const [, update] = call;
    expect(Array.isArray(update)).toBe(true); // a pipeline, not a plain update
    const stage = update.find(s => s.$set);
    return stage.$set;
}

beforeEach(() => {
    jest.clearAllMocks();
    Case.findOneAndUpdate.mockResolvedValue({ caseId: 1 });
});

describe('addNote', () => {
    test('stamps firstActionAt only if unset, and appends the note', async () => {
        await addNote('g1', 1, 'mod-1', 'looking into it');

        const set = setStage(Case.findOneAndUpdate.mock.calls[0]);
        expect(set.firstActionAt).toEqual({ $ifNull: ['$firstActionAt', '$$NOW'] });
        // The note is appended to whatever notes already exist, not replaced.
        expect(set.notes.$concatArrays[0]).toEqual({ $ifNull: ['$notes', []] });
        expect(set.notes.$concatArrays[1][0]).toMatchObject({ moderatorId: 'mod-1', content: 'looking into it' });
    });
});

describe('closeCase', () => {
    test('a close counts as a first response for an untouched case', async () => {
        await closeCase('g1', 1, 'mod-2', 'resolved');

        const set = setStage(Case.findOneAndUpdate.mock.calls[0]);
        expect(set.status).toBe('closed');
        expect(set.resolvedBy).toBe('mod-2');
        expect(set.resolvedAt).toBe('$$NOW');
        expect(set.firstActionAt).toEqual({ $ifNull: ['$firstActionAt', '$$NOW'] });
    });
});
