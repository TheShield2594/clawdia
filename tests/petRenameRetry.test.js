'use strict';

// /pet rename and /pet release are pure re-read → mutate → save units, so they
// now replay through withVersionRetry instead of bouncing a version conflict
// back to the user. These tests drive both through a User model whose save()
// can be made to lose a version race.

let mockDoc;        // the document resolveUser hands back
let mockSaveFails;  // how many save() calls fail with a VersionError before one lands
let mockLoads;      // how many times the command re-read the user

function mockVersionError() {
    const err = new Error('No matching document found for id "u1" version 1');
    err.name = 'VersionError';
    return err;
}

function mockBuildDoc(pets) {
    return {
        userId: 'u1',
        guildId: 'g1',
        pets,
        saves: 0,
        markModified: jest.fn(),
        async save() {
            this.saves++;
            if (this.saves <= mockSaveFails) throw mockVersionError();
        },
    };
}

jest.mock('../src/models/User', () => {
    const model = {
        DECEASED_PET_LIMIT: 5,
        findOneAndUpdate: jest.fn(async () => { mockLoads++; return mockDoc; }),
        findOne: jest.fn(async () => mockDoc),
        find: jest.fn(async () => []),
        countDocuments: jest.fn(async () => 0),
    };
    return model;
});

jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async (u) => u) }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(async () => ({ guildId: 'g1' })) }));

const petCommand = require('../src/commands/economy/pet.js');

function buildInteraction(sub, slot) {
    const state = { replies: [] };
    return {
        state,
        interaction: {
            guild: { id: 'g1' },
            guildId: 'g1',
            user: { id: 'u1', username: 'tester' },
            member: {},
            client: {},
            options: {
                getSubcommand: () => sub,
                get: (name) => (name === 'slot' ? { value: slot } : null),
                getString: (name) => (name === 'name' ? 'Rex' : null),
            },
            reply: jest.fn(async (p) => { state.replies.push(p); }),
            editReply: jest.fn(async (p) => { state.replies.push(p); }),
            followUp: jest.fn(async (p) => { state.replies.push(p); }),
            replied: false,
            deferred: false,
        },
    };
}

beforeEach(() => {
    mockSaveFails = 0;
    mockLoads = 0;
    mockDoc = mockBuildDoc([{ petId: 'dog', name: 'Buddy', slotRef: null }]);
    jest.clearAllMocks();
});

test('rename writes the new name', async () => {
    const { interaction, state } = buildInteraction('rename', '0');
    await petCommand.execute(interaction);

    expect(mockDoc.pets[0].name).toBe('Rex');
    expect(state.replies.at(-1).content).toContain('Rex');
});

test('rename replays after a lost version race instead of asking the user to retry', async () => {
    mockSaveFails = 1;
    const { interaction, state } = buildInteraction('rename', '0');
    await petCommand.execute(interaction);

    expect(mockLoads).toBe(2);          // re-read before the second attempt
    expect(mockDoc.saves).toBe(2);
    expect(mockDoc.pets[0].name).toBe('Rex');
    expect(state.replies.at(-1).content).toContain('Rex');
    expect(state.replies.at(-1).content).not.toContain('conflict');
});

test('rename reports a conflict once the retries are spent', async () => {
    mockSaveFails = Infinity;
    const { interaction, state } = buildInteraction('rename', '0');
    await petCommand.execute(interaction);

    expect(mockDoc.pets[0].name).toBe('Rex'); // local only — nothing persisted
    expect(state.replies.at(-1).content).toContain('Edit conflict');
});

test('renaming a slot that is not there reports no such pet, not a conflict', async () => {
    const { interaction, state } = buildInteraction('rename', '7');
    await petCommand.execute(interaction);

    expect(mockDoc.saves).toBe(0);
    expect(state.replies.at(-1).content).not.toContain('Edit conflict');
});
