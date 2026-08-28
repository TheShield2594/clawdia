'use strict';

// The two AI content services whose output is read by code, not just by people
// (#830): the DM campaign, which parses HP changes back out of the model's
// prose, and the newspaper, which has to print something even when the model
// says nothing at all.
//
// The damage regex is the sharp one. It is scoped to the acting player by name
// or by "you", because a scene that says "the goblin takes 12 damage" must not
// take 12 HP off the character who swung at it — and a name is user input, so
// it goes through an escape before it becomes a pattern.

jest.mock('../src/models/DmSession', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/Case', () => ({ countDocuments: jest.fn() }));
jest.mock('../src/models/Transaction', () => ({ find: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ findOne: jest.fn() }));
jest.mock('../src/utils/netWorth', () => ({ topByNetWorth: jest.fn(async () => []) }));

const mockGetCompletion = jest.fn();
jest.mock('../src/services/aiService', () => ({
    resolveProviderConfig: () => ({ provider: 'mock', model: 'mock-1', apiKey: 'k', mcpServers: [], baseUrl: null, rateLimit: {} }),
    getCompletion: (...args) => mockGetCompletion(...args),
}));

const DmSession = require('../src/models/DmSession');
const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const Case = require('../src/models/Case');
const Transaction = require('../src/models/Transaction');
const GrindProfile = require('../src/models/GrindProfile');

const { takeAction } = require('../src/services/dmService');
const { generateNewspaper } = require('../src/services/newspaperService');

let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Guild.findOne.mockResolvedValue({ guildId: 'g1', ai: { enabled: true, provider: 'mock' } });
});

afterEach(() => errorSpy.mockRestore());

describe('the DM campaign reading HP back out of the story', () => {
    const PLAYER = { userId: 'u1', name: 'Aric', characterClass: 'Warrior', hp: 120, inventory: ['Longsword'] };

    function session(players = [PLAYER]) {
        return {
            sessionId: 'g1:c1', guildId: 'g1', channelId: 'c1', hostId: 'u1',
            players, storyLog: ['The gate stands open.'], active: true,
        };
    }

    function interaction() {
        return {
            user: { id: 'u1' },
            guild: { id: 'g1' },
            channel: { id: 'c1', send: jest.fn(async () => ({ id: 'm1' })), messages: { fetch: jest.fn() } },
            channelId: 'c1',
            options: { getString: () => 'swing at the goblin' },
            deferReply: jest.fn(async () => {}),
            editReply: jest.fn(async payload => payload),
            reply: jest.fn(async payload => payload),
        };
    }

    // The HP write, if there was one: the update sets it through an arrayFilter
    // so only the acting player's slot moves.
    function writtenHp() {
        const call = DmSession.findOneAndUpdate.mock.calls.find(c => c[1]?.$set?.['players.$[elem].hp'] !== undefined);
        return call ? call[1].$set['players.$[elem].hp'] : null;
    }

    async function narrate(text, players) {
        const doc = session(players);
        DmSession.findOne.mockResolvedValue(doc);
        DmSession.findOneAndUpdate.mockResolvedValue(doc);
        mockGetCompletion.mockResolvedValue(text);
        const it = interaction();
        await takeAction(it);
        return it;
    }

    test('takes damage the scene attributes to the acting character', async () => {
        await narrate('The goblin lunges and Aric takes 15 damage before staggering back.');
        expect(writtenHp()).toBe(105);
    });

    test('reads the second person too, which is how the model usually writes it', async () => {
        await narrate('You take 20 damage as the blade bites.');
        expect(writtenHp()).toBe(100);
    });

    // The bug the scoping exists for: an enemy taking damage is the *good*
    // outcome, and an unscoped regex would charge it to the player.
    test('leaves HP alone when it is the enemy taking the hit', async () => {
        await narrate('Your blow lands cleanly and the goblin takes 12 damage, howling.');
        expect(writtenHp()).toBeNull();
    });

    test('does not charge one character for what happened to another', async () => {
        const lyra = { userId: 'u2', name: 'Lyra', characterClass: 'Mage', hp: 70, inventory: [] };
        await narrate('Lyra takes 30 damage from the falling rubble.', [PLAYER, lyra]);
        expect(writtenHp()).toBeNull();
    });

    // A party member is named rather than introduced, so nothing in the sentence
    // marks them as a new subject except the name itself. Without the party in
    // the scoping, the acting player being mentioned first was enough to charge
    // him for his companion's wound.
    test('nor when the acting character is named earlier in the same sentence', async () => {
        const lyra = { userId: 'u2', name: 'Lyra', characterClass: 'Mage', hp: 70, inventory: [] };
        await narrate('Aric swings wide, and Lyra takes 30 damage from the counterblow.', [PLAYER, lyra]);
        expect(writtenHp()).toBeNull();
    });

    test('and the acting character is still charged for their own wound', async () => {
        const lyra = { userId: 'u2', name: 'Lyra', characterClass: 'Mage', hp: 70, inventory: [] };
        await narrate('Lyra shouts a warning, but Aric takes 20 damage anyway.', [PLAYER, lyra]);
        expect(writtenHp()).toBe(100);
    });

    test('reads the other verbs the model reaches for', async () => {
        await narrate('Aric suffers 25 damage from the blast.');
        expect(writtenHp()).toBe(95);
    });

    test('heals, but never above the class maximum', async () => {
        await narrate('A warm light washes over you; Aric heals 40 HP.', [{ ...PLAYER, hp: 100 }]);
        expect(writtenHp()).toBe(120);
    });

    test('cannot take a character below zero', async () => {
        await narrate('The ogre roars and Aric takes 999 damage.', [{ ...PLAYER, hp: 30 }]);
        expect(writtenHp()).toBe(0);
    });

    // A character name is whatever the player typed at /dm join, so it reaches
    // the regex through an escape. Unescaped, `A(ric` is a syntax error and the
    // whole action fails; `A.ic` would match another player's name.
    test('a name full of regex metacharacters does not break the scene', async () => {
        const odd = { ...PLAYER, name: 'A(ric.*' };
        const it = await narrate('A(ric.* takes 10 damage from the trap.', [odd]);

        expect(writtenHp()).toBe(110);
        expect(it.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    });

    test('ends the session when the last character standing falls', async () => {
        await narrate('The ogre roars and Aric takes 200 damage.', [{ ...PLAYER, hp: 30 }]);

        const closed = DmSession.findOneAndUpdate.mock.calls.some(c => c[1]?.$set?.active === false);
        expect(closed).toBe(true);
    });

    test('a limit refusal says so instead of "try again"', async () => {
        DmSession.findOne.mockResolvedValue(session());
        mockGetCompletion.mockRejectedValue(
            Object.assign(new Error('limit'), { rateLimited: true, limit: 5, windowMin: 10 })
        );

        const it = interaction();
        await takeAction(it);

        expect(it.editReply).toHaveBeenCalledWith(expect.stringMatching(/AI request limit \(5 per 10m\)/));
    });
});

describe('the newspaper when the model does not deliver', () => {
    const guildDoc = (overrides = {}) => ({
        guildId: 'g1',
        name: 'Test Server',
        ai: { enabled: true, provider: 'mock' },
        economy: { currency: '💰' },
        newspaper: { sections: {} },
        ...overrides,
    });

    const client = { guilds: { fetch: jest.fn(async () => null) } };

    beforeEach(() => {
        require('../src/utils/netWorth').topByNetWorth.mockResolvedValue([
            { userId: 'u1', netWorth: 4_200 },
        ]);
        User.find.mockReturnValue({
            sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [{ userId: 'u1', level: 9, xp: 100 }] }) }) }),
        });
        User.countDocuments.mockResolvedValue(3);
        Case.countDocuments.mockResolvedValue(2);
        Transaction.find.mockReturnValue({
            sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }),
        });
        GrindProfile.findOne.mockReturnValue({
            sort: () => ({ select: () => ({ lean: async () => null }) }),
        });
    });

    test('prints the model\'s edition when there is one', async () => {
        mockGetCompletion.mockResolvedValue('**Big news!** The server thrived this week.');

        const embed = await generateNewspaper(client, guildDoc());

        expect(embed.data.description).toMatch(/Big news!/);
    });

    // The paper goes out on a schedule. A provider outage on delivery day must
    // not mean an empty channel, so the stats it already collected get printed
    // without a narrator.
    test('falls back to the plain edition when the AI call fails', async () => {
        mockGetCompletion.mockRejectedValue(new Error('provider down'));

        const embed = await generateNewspaper(client, guildDoc());

        expect(embed.data.description).toMatch(/Top Earners/);
        expect(embed.data.description).toMatch(/4,200/);
        expect(embed.data.description).toMatch(/Level Leaders/);
    });

    test('falls back when the model returns nothing at all', async () => {
        mockGetCompletion.mockResolvedValue('');

        const embed = await generateNewspaper(client, guildDoc());

        expect(embed.data.description).toMatch(/Test Server Weekly/);
    });

    test('and when the guild has no AI configured to begin with', async () => {
        const embed = await generateNewspaper(client, guildDoc({ ai: { enabled: false } }));

        expect(mockGetCompletion).not.toHaveBeenCalled();
        expect(embed.data.description).toMatch(/Top Earners/);
    });

    // The exception: an on-demand /newspaper preview refused by the guild's own
    // AI limit should say so, not hand back the AI-less paper as though nothing
    // was ever configured.
    test('a limit refusal on a requested preview is raised, not swallowed', async () => {
        mockGetCompletion.mockRejectedValue(Object.assign(new Error('limit'), { rateLimited: true }));

        await expect(generateNewspaper(client, guildDoc(), null, { userId: 'u1', channelId: 'c1' }))
            .rejects.toMatchObject({ rateLimited: true });
    });

    test('but the scheduled run still prints something', async () => {
        mockGetCompletion.mockRejectedValue(Object.assign(new Error('limit'), { rateLimited: true }));

        const embed = await generateNewspaper(client, guildDoc());

        expect(embed.data.description).toMatch(/Top Earners/);
    });
});
