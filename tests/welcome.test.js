'use strict';

// Mock the canvas module so tests don't require native binaries.
// The factory captures shared instances so all calls to createCanvas() return
// the same ctx — this lets us assert on save/restore/clip calls.
jest.mock('canvas', () => {
    const mockCtx = {
        fillStyle: '',
        font: '',
        fillRect: jest.fn(),
        fillText: jest.fn(),
        beginPath: jest.fn(),
        arc: jest.fn(),
        closePath: jest.fn(),
        clip: jest.fn(),
        drawImage: jest.fn(),
        save: jest.fn(),
        restore: jest.fn(),
        measureText: jest.fn(text => ({ width: text.length * 10 })),
    };
    const mockCanvas = {
        getContext: jest.fn(() => mockCtx),
        width: 800,
        height: 300,
        toBuffer: jest.fn(() => Buffer.from('fake-image')),
    };
    return {
        createCanvas: jest.fn(() => mockCanvas),
        loadImage: jest.fn().mockResolvedValue({}),
        registerFont: jest.fn(),
    };
});

// Mock heavy service/model dependencies so the event module loads cleanly
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/services/raidService', () => ({ handleMemberJoin: jest.fn() }));
jest.mock('../src/services/antiNukeService', () => ({ enforceJoinGate: jest.fn().mockResolvedValue(false) }));

const { _applyVariables } = require('../src/events/guildMemberAdd');
const { createWelcomeCard } = require('../src/utils/cardGenerator');
const { createCanvas, loadImage } = require('canvas');

// ---------------------------------------------------------------------------
// Shared mock member — includes displayAvatarURL so the card function doesn't throw
// ---------------------------------------------------------------------------

const mockMember = {
    id: '123456789012345678',
    user: {
        globalName: 'TestDisplay',
        username: 'testuser',
        displayName: 'TestDisplay',
        tag: 'testuser#0',
        displayAvatarURL: jest.fn().mockReturnValue('https://cdn.discordapp.com/avatars/test.png'),
    },
    guild: { name: 'Test Server', memberCount: 42 },
    displayName: 'TestDisplay',
};

// ---------------------------------------------------------------------------
// applyVariables
// ---------------------------------------------------------------------------

describe('applyVariables', () => {
    test('replaces {user} with a mention', () => {
        expect(_applyVariables('{user}', mockMember)).toBe('<@123456789012345678>');
    });

    test('replaces {username} with the display name', () => {
        expect(_applyVariables('{username}', mockMember)).toBe('TestDisplay');
    });

    test('falls back to username when displayName is absent', () => {
        const m = { ...mockMember, user: { ...mockMember.user, displayName: undefined } };
        expect(_applyVariables('{username}', m)).toBe('testuser');
    });

    test('replaces {tag} with user tag', () => {
        expect(_applyVariables('{tag}', mockMember)).toBe('testuser#0');
    });

    test('replaces {server} with guild name', () => {
        expect(_applyVariables('{server}', mockMember)).toBe('Test Server');
    });

    test('replaces {memberCount} with member count', () => {
        expect(_applyVariables('{memberCount}', mockMember)).toBe('42');
    });

    test('handles a full welcome template', () => {
        const result = _applyVariables('Welcome {user} to {server}! You are member #{memberCount}.', mockMember);
        expect(result).toBe('Welcome <@123456789012345678> to Test Server! You are member #42.');
    });

    test('replaces all occurrences of the same variable', () => {
        expect(_applyVariables('{user} {user}', mockMember)).toBe(
            '<@123456789012345678> <@123456789012345678>'
        );
    });

    test('leaves a template with no variables unchanged', () => {
        expect(_applyVariables('Hello World!', mockMember)).toBe('Hello World!');
    });
});

// ---------------------------------------------------------------------------
// createWelcomeCard
// ---------------------------------------------------------------------------

describe('createWelcomeCard', () => {
    beforeEach(() => {
        // Reset call counts between tests so assertions are isolated
        const ctx = createCanvas().getContext();
        ctx.save.mockClear();
        ctx.restore.mockClear();
        ctx.clip.mockClear();
        loadImage.mockClear();
        loadImage.mockResolvedValue({});
    });

    test('returns a Buffer', async () => {
        const result = await createWelcomeCard(mockMember);
        expect(Buffer.isBuffer(result)).toBe(true);
    });

    test('resolves even when avatar load fails', async () => {
        loadImage.mockRejectedValueOnce(new Error('network error'));
        await expect(createWelcomeCard(mockMember)).resolves.toBeDefined();
    });

    test('calls save and restore around the avatar clip', async () => {
        await createWelcomeCard(mockMember);
        const ctx = createCanvas().getContext();
        expect(ctx.save).toHaveBeenCalled();
        expect(ctx.restore).toHaveBeenCalled();
    });

    test('does not call clip when avatar load fails', async () => {
        loadImage.mockRejectedValueOnce(new Error('timeout'));
        await createWelcomeCard(mockMember);
        const ctx = createCanvas().getContext();
        expect(ctx.clip).not.toHaveBeenCalled();
    });
});
