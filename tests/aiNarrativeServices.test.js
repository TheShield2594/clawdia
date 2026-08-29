'use strict';

// The two AI content services whose output is read by code, not just by people
// (#830): the DM campaign, which turns a narration into HP and inventory
// changes, and the newspaper, which has to print something even when the model
// says nothing at all.
//
// The campaign reads a structured `EFFECTS:` block now (#837) — which is what
// lets a trap hurt somebody who did not type, and a party actually be wiped
// out. The prose regex it replaced is still exercised below as what happens
// when a model ignores the format, which is its only remaining job.

jest.mock('../src/models/DmSession', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
// The turn lease is Mongo-backed (#837), and these tests have no Mongo. Granted
// by default; the contention test below is the one that takes it away.
jest.mock('../src/utils/activeGameLock', () => ({
    tryAcquire: jest.fn(async () => 'lease-token'),
    release: jest.fn(async () => true),
    holderActivity: jest.fn(async () => null),
    DEFAULT_TTL_MS: 60_000,
}));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../src/models/Case', () => ({ countDocuments: jest.fn() }));
jest.mock('../src/models/Transaction', () => ({ find: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ findOne: jest.fn() }));
// The signals the paper gained when its sections became a registry (#836).
jest.mock('../src/models/AiItem', () => ({ find: jest.fn() }));
jest.mock('../src/models/AiQuest', () => ({ find: jest.fn() }));
jest.mock('../src/models/WeeklyChampion', () => ({ find: jest.fn() }));
jest.mock('../src/utils/netWorth', () => ({ topByNetWorth: jest.fn(async () => []) }));

const mockGetCompletion = jest.fn();
jest.mock('../src/services/aiService', () => ({
    resolveProviderConfig: () => ({ provider: 'mock', model: 'mock-1', apiKey: 'k', mcpServers: [], baseUrl: null, rateLimit: {} }),
    getCompletion: (...args) => mockGetCompletion(...args),
}));

const DmSession = require('../src/models/DmSession');
const activeGameLock = require('../src/utils/activeGameLock');

// `DmSession.findOne` is awaited directly in some places and `.lean()`-ed in the
// two that resolve a turn, so the mock has to be both a promise and a query —
// the way a real Mongoose query is.
const asQuery = doc => Object.assign(Promise.resolve(doc), { lean: async () => doc });
const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const Case = require('../src/models/Case');
const Transaction = require('../src/models/Transaction');
const GrindProfile = require('../src/models/GrindProfile');
const AiItem = require('../src/models/AiItem');
const AiQuest = require('../src/models/AiQuest');
const WeeklyChampion = require('../src/models/WeeklyChampion');

const { takeAction } = require('../src/services/dmService');
const { generateNewspaper } = require('../src/services/newspaperService');

let errorSpy;

beforeEach(() => {
    jest.clearAllMocks();
    activeGameLock.tryAcquire.mockResolvedValue('lease-token');
    activeGameLock.release.mockResolvedValue(true);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Guild.findOne.mockResolvedValue({ guildId: 'g1', ai: { enabled: true, provider: 'mock' } });
});

afterEach(() => errorSpy.mockRestore());

// A `findOneAndUpdate` faithful enough for the turn write: the service asks for
// the post-write document (`new: true`) so a character who joined mid-turn is
// counted before the party is declared wiped, and a mock that hands back the
// pre-write party would report a wipe that did not happen — and hide one that
// did.
function applyingUpdate(doc) {
    return async (_filter, update) => {
        if (!update?.$push?.storyLog) return doc;
        const players = doc.players.map((p, i) => ({
            ...p,
            hp: update.$set?.[`players.$[p${i}].hp`] ?? p.hp,
            inventory: update.$set?.[`players.$[p${i}].inventory`] ?? p.inventory,
        }));
        return { ...doc, players };
    };
}

describe('the DM campaign reading HP out of the model\'s prose, when that is all there is', () => {
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

    // The HP write for one party slot, if there was one. Each character that
    // moved is written through its own array filter, so the index is the
    // character's position in the party — which is what lets a turn hurt two
    // people at once in the structured tests below.
    function writtenHp(index = 0) {
        const path = `players.$[p${index}].hp`;
        const call = DmSession.findOneAndUpdate.mock.calls.find(c => c[1]?.$set?.[path] !== undefined);
        return call ? call[1].$set[path] : null;
    }

    async function narrate(text, players) {
        const doc = session(players);
        DmSession.findOne.mockReturnValue(asQuery(doc));
        DmSession.findOneAndUpdate.mockImplementation(applyingUpdate(doc));
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
        DmSession.findOne.mockReturnValue(asQuery(session()));
        mockGetCompletion.mockRejectedValue(
            Object.assign(new Error('limit'), { rateLimited: true, limit: 5, windowMin: 10 })
        );

        const it = interaction();
        await takeAction(it);

        expect(it.editReply).toHaveBeenCalledWith(expect.stringMatching(/AI request limit \(5 per 10m\)/));
    });
});

// #837: what the narration actually did, as data.
//
// The prose reader above can only ever wound the character who typed, which is
// why a dragon's breath weapon used to hit exactly one person and a party wipe
// could not happen. The model now says what happened in a trailing block, and
// these are the cases that block exists for.
describe('the DM campaign applying a structured EFFECTS block', () => {
    const ARIC = { userId: 'u1', name: 'Aric', characterClass: 'Warrior', hp: 120, inventory: ['Longsword'] };
    const LYRA = { userId: 'u2', name: 'Lyra', characterClass: 'Mage', hp: 70, inventory: [] };

    function interaction(userId = 'u1') {
        return {
            user: { id: userId },
            guild: { id: 'g1' },
            channel: { id: 'c1', send: jest.fn(async () => ({ id: 'm1' })), messages: { fetch: jest.fn() } },
            channelId: 'c1',
            options: { getString: () => 'swing at the dragon' },
            deferReply: jest.fn(async () => {}),
            editReply: jest.fn(async payload => payload),
            reply: jest.fn(async payload => payload),
        };
    }

    async function narrate(text, players = [ARIC]) {
        const doc = {
            sessionId: 'g1:c1', guildId: 'g1', channelId: 'c1', hostId: 'u1',
            players, storyLog: ['The gate stands open.'], active: true, partyState: {},
        };
        DmSession.findOne.mockReturnValue(asQuery(doc));
        DmSession.findOneAndUpdate.mockImplementation(applyingUpdate(doc));
        mockGetCompletion.mockResolvedValue(text);
        const it = interaction();
        await takeAction(it);
        return it;
    }

    function writes() {
        const call = DmSession.findOneAndUpdate.mock.calls.find(c => c[1]?.$push?.storyLog);
        return { update: call?.[1] ?? {}, options: call?.[2] ?? {} };
    }

    function hp(index) {
        return writes().update.$set?.[`players.$[p${index}].hp`] ?? null;
    }

    function inventory(index) {
        return writes().update.$set?.[`players.$[p${index}].inventory`] ?? null;
    }

    const block = effects => `The dragon inhales.\nEFFECTS:${JSON.stringify(effects)}`;

    test('hurts the character the block names, not the one who typed', async () => {
        await narrate(block([{ type: 'damage', target: 'Lyra', amount: 30 }]), [ARIC, LYRA]);

        expect(hp(0)).toBeNull();
        expect(hp(1)).toBe(40);
    });

    // The whole point of the rewrite: an area effect reaches everyone, so the
    // party can lose.
    test('a party-wide effect reaches every living character', async () => {
        await narrate(block([{ type: 'damage', target: 'party', amount: 200 }]), [ARIC, LYRA]);

        expect(hp(0)).toBe(0);
        expect(hp(1)).toBe(0);
    });

    test('and a party that all falls at once ends the session', async () => {
        await narrate(block([{ type: 'damage', target: 'party', amount: 500 }]), [ARIC, LYRA]);

        const closed = DmSession.findOneAndUpdate.mock.calls.some(c => c[1]?.$set?.active === false);
        expect(closed).toBe(true);
    });

    // `/dm join` is a `$push` that runs outside the turn lease, so somebody can
    // enter the party while the scene is being written. The wipe is decided
    // from the party the write returns, not from the copy the turn worked with.
    test('does not bury a player who joined while the scene was being written', async () => {
        const doc = {
            sessionId: 'g1:c1', guildId: 'g1', channelId: 'c1', hostId: 'u1',
            players: [ARIC], storyLog: ['The gate stands open.'], active: true, partyState: {},
        };
        DmSession.findOne.mockReturnValue(asQuery(doc));
        DmSession.findOneAndUpdate.mockImplementation(async (_filter, update) => {
            if (!update?.$push?.storyLog) return doc;
            // The latecomer, pushed by a concurrent /dm join.
            return { ...doc, players: [{ ...ARIC, hp: 0 }, { ...LYRA, userId: 'u3', name: 'Kest' }] };
        });
        mockGetCompletion.mockResolvedValue(block([{ type: 'damage', target: 'Aric', amount: 500 }]));

        await takeAction(interaction());

        const closed = DmSession.findOneAndUpdate.mock.calls.some(c => c[1]?.$set?.active === false);
        expect(closed).toBe(false);
    });

    test('healing stops at the class ceiling', async () => {
        await narrate(block([{ type: 'heal', target: 'Aric', amount: 90 }]), [{ ...ARIC, hp: 60 }]);
        expect(hp(0)).toBe(120);
    });

    test('items are real now, in both directions', async () => {
        await narrate(block([
            { type: 'add_item', target: 'Aric', item: 'Rusty Key' },
            { type: 'remove_item', target: 'Aric', item: 'longsword' },
        ]));

        expect(inventory(0)).toEqual(['Rusty Key']);
    });

    test('the scene the block sets is where the party is', async () => {
        await narrate(block([{ type: 'set_scene', scene: 'The flooded lower vault' }]));

        expect(writes().update.$set['partyState.scene']).toBe('The flooded lower vault');
    });

    // A block is believed completely, including when it says nothing happened —
    // otherwise the prose reader would second-guess a model that got it right.
    test('a block that reports nothing overrides what the prose says', async () => {
        await narrate('Aric takes 40 damage — or seems to.\nEFFECTS:[]');
        expect(hp(0)).toBeNull();
    });

    test('a target nobody in the party answers to is dropped', async () => {
        await narrate(block([{ type: 'damage', target: 'the goblin', amount: 12 }]));
        expect(hp(0)).toBeNull();
    });

    test('a malformed block costs the effects, not the scene', async () => {
        const it = await narrate('The dragon inhales.\nEFFECTS:[{"type":"damage",');

        expect(hp(0)).toBeNull();
        expect(it.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    });

    // Mongo rejects an update naming an array filter no path uses, so a turn in
    // which nothing moved must carry none.
    test('a turn that changes nothing writes no array filters', async () => {
        await narrate('You look around the empty room.');
        expect(writes().options.arrayFilters).toBeUndefined();
    });

    test('and one that changes somebody carries exactly their filter', async () => {
        await narrate(block([{ type: 'damage', target: 'Lyra', amount: 10 }]), [ARIC, LYRA]);
        expect(writes().options.arrayFilters).toEqual([{ 'p1.userId': 'u2' }]);
    });
});

// #837: two players acting at the same moment used to both read the same
// history, both pay for a completion, and both append a narration written as
// though the other had not happened.
describe('the DM turn lease', () => {
    const PLAYER = { userId: 'u1', name: 'Aric', characterClass: 'Warrior', hp: 120, inventory: [] };

    function interaction() {
        return {
            user: { id: 'u1' },
            guild: { id: 'g1' },
            channel: { id: 'c1', send: jest.fn(async () => ({ id: 'm1' })), messages: { fetch: jest.fn() } },
            channelId: 'c1',
            options: { getString: () => 'push on' },
            deferReply: jest.fn(async () => {}),
            editReply: jest.fn(async payload => payload),
            reply: jest.fn(async payload => payload),
        };
    }

    beforeEach(() => {
        const doc = {
            sessionId: 'g1:c1', guildId: 'g1', channelId: 'c1', hostId: 'u1',
            players: [PLAYER], storyLog: ['The gate stands open.'], active: true, partyState: {},
        };
        DmSession.findOne.mockReturnValue(asQuery(doc));
        DmSession.findOneAndUpdate.mockResolvedValue(doc);
        mockGetCompletion.mockResolvedValue('The corridor narrows.');
    });

    test('is taken for the session, not for the player', async () => {
        await takeAction(interaction());
        expect(activeGameLock.tryAcquire).toHaveBeenCalledWith('dm:g1:c1', expect.any(Number), expect.any(String));
    });

    // Refused rather than queued: a turn that waits for the one in front of it
    // narrates from a story that has already moved on.
    test('turns a second player away without spending an AI call', async () => {
        activeGameLock.tryAcquire.mockResolvedValue(null);

        const it = interaction();
        await takeAction(it);

        expect(mockGetCompletion).not.toHaveBeenCalled();
        expect(it.editReply).toHaveBeenCalledWith(expect.stringMatching(/still being narrated/));
    });

    test('is released once the turn is over', async () => {
        await takeAction(interaction());
        expect(activeGameLock.release).toHaveBeenCalledWith('dm:g1:c1', 'lease-token');
    });

    // A throw inside the turn must free the campaign rather than park it until
    // the lease expires.
    test('and released when the turn throws', async () => {
        mockGetCompletion.mockRejectedValue(new Error('provider down'));

        await takeAction(interaction());

        expect(activeGameLock.release).toHaveBeenCalledWith('dm:g1:c1', 'lease-token');
    });
});

// #821: the roles the campaign history goes to the model with.
//
// The storyLog is a flat array of strings — the opening scene, then a player
// entry and a narration per action — and the role of each entry used to be its
// index's parity, on the assumption that index 0 was still the opening scene.
// The same write that appends the pair trims the log with `$slice: -20`, and a
// log that grows 1, 3, 5, … entries first overflows at 21: exactly one entry is
// dropped and every index shifts by one, permanently. From the 11th action on,
// the model was handed the player's actions as its own words and its own
// narration as the player's.
describe('the DM campaign history roles', () => {
    const PLAYER = { userId: 'u1', name: 'Aric', characterClass: 'Warrior', hp: 120, inventory: ['Longsword'] };

    function interaction() {
        return {
            user: { id: 'u1' },
            guild: { id: 'g1' },
            channel: { id: 'c1', send: jest.fn(async () => ({ id: 'm1' })), messages: { fetch: jest.fn() } },
            channelId: 'c1',
            options: { getString: () => 'push on' },
            deferReply: jest.fn(async () => {}),
            editReply: jest.fn(async payload => payload),
            reply: jest.fn(async payload => payload),
        };
    }

    // The history the model was handed for this action.
    async function historyFor(storyLog) {
        const doc = { sessionId: 'g1:c1', guildId: 'g1', channelId: 'c1', hostId: 'u1', players: [PLAYER], storyLog, active: true };
        DmSession.findOne.mockReturnValue(asQuery(doc));
        DmSession.findOneAndUpdate.mockResolvedValue(doc);
        mockGetCompletion.mockResolvedValue('The corridor narrows.');

        await takeAction(interaction());
        return mockGetCompletion.mock.calls.at(-1)[0].history;
    }

    // An untrimmed log: the opening scene, then (player, narration) pairs.
    const untrimmed = actions => [
        'The gate stands open.',
        ...Array.from({ length: actions }, (_, i) => [`Aric: action ${i}`, `Narration ${i}`]).flat(),
    ];

    test('the narration the player is answering is the assistant, the action is the user', async () => {
        const history = await historyFor(untrimmed(2));

        expect(history.map(m => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
        expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Narration 1' });
        expect(history.at(-2)).toEqual({ role: 'user', content: 'Aric: action 1' });
    });

    // The state the trim leaves behind: the opening scene is gone, so the log
    // now *starts* with a player entry and every forward index is off by one.
    test('and still does once the trim has dropped the opening scene', async () => {
        const history = await historyFor(untrimmed(10).slice(1));

        for (const entry of history) {
            expect(entry.role).toBe(entry.content.startsWith('Aric:') ? 'user' : 'assistant');
        }
        expect(history.map(m => m.role)).toContain('user');
    });

    // Every log the campaign can be in, at the depth the model actually sees.
    test('no length of log ever inverts them', async () => {
        for (let actions = 0; actions <= 12; actions++) {
            const full = untrimmed(actions);
            // What Mongo would hold after `$slice: -20` on each write.
            const stored = full.slice(-20);
            const history = await historyFor(stored);

            for (const entry of history) {
                expect(entry.role).toBe(entry.content.startsWith('Aric:') ? 'user' : 'assistant');
            }
        }
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
        User.aggregate.mockResolvedValue([]);
        const emptyList = {
            sort: () => emptyList,
            limit: () => emptyList,
            select: () => emptyList,
            lean: async () => [],
        };
        AiItem.find.mockReturnValue(emptyList);
        AiQuest.find.mockReturnValue(emptyList);
        WeeklyChampion.find.mockReturnValue(emptyList);
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
