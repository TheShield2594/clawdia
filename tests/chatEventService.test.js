'use strict';

// Ambient chat events — src/services/chatEventService.js. The claim paths used
// to award with a bare `$inc`, skip the economy freeze (these are collector
// buttons, so the command gate never sees them), ignore the Coin Booster, and
// write crate ledger rows with a fabricated zero balance. These hold the fixes.

const { EventEmitter } = require('events');
const { PermissionFlagsBits } = require('discord.js');

jest.mock('../src/models/User', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/utils/creditOrOwe', () => ({ creditCoinsOrOwe: jest.fn(), grantItemsOrOwe: jest.fn() }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/itemImageHelper', () => ({ attachItemThumbnail: jest.fn(async () => []) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/services/triviaQuestionService', () => ({ getQuestion: jest.fn() }));

const User = require('../src/models/User');
const { creditCoinsOrOwe, grantItemsOrOwe } = require('../src/utils/creditOrOwe');
const { logTransaction } = require('../src/utils/logTransaction');
const { getQuestion } = require('../src/services/triviaQuestionService');
const COLORS = require('../src/utils/embedColors');
const chatEventService = require('../src/services/chatEventService');

const { spawnAirdrop, spawnCrate, spawnTrivia, guildState, MIN_MESSAGES_BETWEEN } = chatEventService.__test__;

function makeCollector() {
    const collector = new EventEmitter();
    collector.stop = jest.fn(reason => collector.emit('end', [], reason));
    return collector;
}

function makeMessage({ canPost = true } = {}) {
    const collector = makeCollector();
    const sent = {
        id: 'drop1',
        edit: jest.fn(async () => {}),
        createMessageComponentCollector: jest.fn(() => collector),
    };
    const perms = { has: jest.fn(() => canPost) };
    // A fresh author on every read, so loops of chat count as many people
    // talking; the fairness tests pin a single author instead.
    let authorSeq = 0;
    const message = {
        get author() { return { id: `author${authorSeq++}` }; },
        id: 'msg1',
        guild: { id: 'g1', members: { me: { id: 'bot' } } },
        channel: {
            isTextBased: () => true,
            isThread: () => false,
            permissionsFor: jest.fn(() => perms),
            send: jest.fn(async () => sent),
        },
    };
    return { message, sent, collector, perms };
}

function click(customId, userId = 'u1') {
    return {
        customId,
        user: { id: userId, bot: false, username: `user-${userId}` },
        member: { displayName: `Player ${userId}` },
        reply: jest.fn(async () => {}),
        update: jest.fn(async () => {}),
        deferUpdate: jest.fn(async () => {}),
        editReply: jest.fn(async () => {}),
    };
}

// The collector's 'collect' handlers are async and not awaited by the emitter.
async function collect(collector, interaction) {
    const [handler] = collector.listeners('collect');
    await handler(interaction);
}

const lean = value => ({ lean: async () => value });

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Math, 'random').mockReturnValue(0); // airdrop base = AIRDROP_MIN (500); crate = Lucky Charm
    User.findOne.mockReturnValue(lean({ balance: 4_000, activeEffects: [] }));
    creditCoinsOrOwe.mockResolvedValue({ credited: true, owed: false, doc: { balance: 4_500 } });
    grantItemsOrOwe.mockResolvedValue({ granted: true, owed: false, doc: { balance: 4_000 } });
});

afterEach(() => jest.restoreAllMocks());

describe('coin drop', () => {
    test('pays through the keyed credit and logs the real balance', async () => {
        const { message, sent, collector } = makeMessage();
        await spawnAirdrop(message, {});

        const i = click('chatev_air_msg1');
        await collect(collector, i);

        expect(creditCoinsOrOwe).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' }, 500,
            expect.objectContaining({ payoutKey: 'chatevent:airdrop:drop1' }),
        );
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 500, balance: 4_500 }));
        expect(collector.stop).toHaveBeenCalledWith('claimed');
        expect(i.deferUpdate).toHaveBeenCalled();
        const card = i.editReply.mock.calls[0][0].embeds[0].toJSON();
        expect(card.color).toBe(parseInt(COLORS.SUCCESS.slice(1), 16));
        expect(card.description).toContain('+500');
        // A claimed drop is not overwritten with the "drifted away" card.
        const titles = sent.edit.mock.calls.map(([p]) => p.embeds[0].toJSON().title);
        expect(titles.some(t => t.includes('drifted'))).toBe(false);
    });

    test('a second click after the claim is told it was too slow', async () => {
        const { message, collector } = makeMessage();
        await spawnAirdrop(message, {});
        await collect(collector, click('chatev_air_msg1', 'u1'));

        const late = click('chatev_air_msg1', 'u2');
        await collect(collector, late);
        expect(late.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Too slow') }));
        expect(creditCoinsOrOwe).toHaveBeenCalledTimes(1);
    });

    test('a frozen member is refused and the drop stays up for someone else', async () => {
        const { message, collector } = makeMessage();
        await spawnAirdrop(message, {});

        User.findOne.mockReturnValueOnce(lean({ balance: 10, economyFrozen: true, activeEffects: [] }));
        const frozen = click('chatev_air_msg1', 'frozen');
        await collect(collector, frozen);
        expect(frozen.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('frozen') }));
        expect(creditCoinsOrOwe).not.toHaveBeenCalled();
        expect(collector.stop).not.toHaveBeenCalled();

        await collect(collector, click('chatev_air_msg1', 'u2'));
        expect(creditCoinsOrOwe).toHaveBeenCalledWith(
            { userId: 'u2', guildId: 'g1' }, 500, expect.anything(),
        );
    });

    test('an active Coin Booster doubles the prize', async () => {
        const { message, collector } = makeMessage();
        await spawnAirdrop(message, {});

        User.findOne.mockReturnValueOnce(lean({
            balance: 0,
            activeEffects: [{ type: 'coin_booster_2x', expiresAt: new Date(Date.now() + 60_000) }],
        }));
        const i = click('chatev_air_msg1');
        await collect(collector, i);

        expect(creditCoinsOrOwe).toHaveBeenCalledWith(expect.anything(), 1_000, expect.anything());
        expect(i.editReply.mock.calls[0][0].embeds[0].toJSON().description).toContain('Coin Booster');
    });

    test('a credit that will not land is owed — announced as such, not logged as paid', async () => {
        creditCoinsOrOwe.mockResolvedValueOnce({ credited: false, owed: true, doc: null });
        const { message, collector } = makeMessage();
        await spawnAirdrop(message, {});

        const i = click('chatev_air_msg1');
        await collect(collector, i);

        expect(logTransaction).not.toHaveBeenCalled();
        expect(collector.stop).toHaveBeenCalledWith('claimed');
        const card = i.editReply.mock.calls[0][0].embeds[0].toJSON();
        expect(card.color).toBe(parseInt(COLORS.WARN.slice(1), 16));
        expect(card.description).toContain('recorded');
    });

    test('a claimant with no document gets one before the keyed credit', async () => {
        User.findOne
            .mockReturnValueOnce(lean(null))
            .mockReturnValueOnce(lean({ balance: 0, activeEffects: [] }));
        const { message, collector } = makeMessage();
        await spawnAirdrop(message, {});
        await collect(collector, click('chatev_air_msg1', 'newbie'));

        expect(User.updateOne).toHaveBeenCalledWith(
            { userId: 'newbie', guildId: 'g1' },
            { $setOnInsert: { userId: 'newbie', guildId: 'g1' } },
            { upsert: true },
        );
        expect(creditCoinsOrOwe).toHaveBeenCalled();
    });

    test('a failed claimant read releases the drop', async () => {
        User.findOne.mockReturnValueOnce({ lean: async () => { throw new Error('db down'); } });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const { message, collector } = makeMessage();
        await spawnAirdrop(message, {});

        const first = click('chatev_air_msg1', 'u1');
        await collect(collector, first);
        expect(first.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('try again') }));

        await collect(collector, click('chatev_air_msg1', 'u2'));
        expect(creditCoinsOrOwe).toHaveBeenCalledWith({ userId: 'u2', guildId: 'g1' }, 500, expect.anything());
    });

    test('an unclaimed drop expires into the neutral card', async () => {
        const { message, sent, collector } = makeMessage();
        await spawnAirdrop(message, {});
        collector.emit('end', [], 'time');
        expect(sent.edit.mock.calls.at(-1)[0].embeds[0].toJSON().title).toContain('drifted away');
    });
});

describe('supply crate', () => {
    test('grants through the keyed path and logs the wallet balance, not zero', async () => {
        const { message, collector } = makeMessage();
        await spawnCrate(message, {});

        const i = click('chatev_crate_msg1');
        await collect(collector, i);

        expect(grantItemsOrOwe).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' }, 'lucky_charm', 1,
            expect.objectContaining({ payoutKey: 'chatevent:crate:drop1', upsert: true }),
        );
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 0, balance: 4_000 }));
        // The "cracking it open" beat, then the reveal.
        expect(i.update.mock.calls[0][0].embeds[0].toJSON().title).toContain('Cracking');
        const reveal = i.editReply.mock.calls[0][0].embeds[0].toJSON();
        expect(reveal.description).toContain('Lucky Charm');
        expect(reveal.fields.map(f => f.name)).toEqual(expect.arrayContaining(['Rarity', 'Shop value']));
    });

    test('a frozen member cannot open it', async () => {
        User.findOne.mockReturnValueOnce(lean({ economyFrozen: true }));
        const { message, collector } = makeMessage();
        await spawnCrate(message, {});
        const i = click('chatev_crate_msg1');
        await collect(collector, i);
        expect(grantItemsOrOwe).not.toHaveBeenCalled();
        expect(i.update).not.toHaveBeenCalled();
    });
});

describe('flash trivia', () => {
    beforeEach(() => {
        getQuestion.mockResolvedValue({
            question: 'Capital of France?', category: 'Geography',
            correct_answer: 'Paris', incorrect_answers: ['Rome', 'Madrid', 'Berlin'],
        });
    });

    test('a wrong guess spends that member\'s guess; the right one pays', async () => {
        const { message, collector } = makeMessage();
        await spawnTrivia(message, {});
        const row = message.channel.send.mock.calls[0][0].components[0].toJSON();
        const idOf = label => row.components.find(b => b.label === label).custom_id;

        const wrong = click(idOf('Rome'), 'u1');
        await collect(collector, wrong);
        expect(wrong.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Not **Rome**') }));

        const again = click(idOf('Paris'), 'u1');
        await collect(collector, again);
        expect(again.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('already used') }));

        const right = click(idOf('Paris'), 'u2');
        await collect(collector, right);
        expect(creditCoinsOrOwe).toHaveBeenCalledWith(
            { userId: 'u2', guildId: 'g1' }, 1_000,
            expect.objectContaining({ payoutKey: 'chatevent:trivia:drop1' }),
        );
        const payload = right.editReply.mock.calls[0][0];
        expect(payload.embeds[0].toJSON().description).toContain('1 wrong guess');
        const buttons = payload.components[0].toJSON().components;
        expect(buttons.every(b => b.disabled)).toBe(true);
        expect(buttons.find(b => b.label === 'Paris').emoji.name).toBe('✅');
    });
});

describe('spawning', () => {
    beforeEach(() => guildState.clear());

    test('a channel the bot cannot post in does not spend the cooldown', async () => {
        const { message } = makeMessage({ canPost: false });
        for (let n = 0; n < MIN_MESSAGES_BETWEEN; n++) {
            await chatEventService.maybeTriggerChatEvent(message, {});
        }
        expect(message.channel.send).not.toHaveBeenCalled();
        const state = guildState.get('g1');
        expect(state.lastEventAt).toBe(0);
        expect(state.messagesSince).toBe(MIN_MESSAGES_BETWEEN);
    });

    test('checks the thread send permission inside a thread', async () => {
        const { message, perms } = makeMessage({ canPost: false });
        message.channel.isThread = () => true;
        for (let n = 0; n < MIN_MESSAGES_BETWEEN; n++) {
            await chatEventService.maybeTriggerChatEvent(message, {});
        }
        expect(perms.has).toHaveBeenCalledWith(expect.arrayContaining([PermissionFlagsBits.SendMessagesInThreads]));
    });

    test('fires once the bot can post', async () => {
        const { message } = makeMessage();
        for (let n = 0; n < MIN_MESSAGES_BETWEEN; n++) {
            await chatEventService.maybeTriggerChatEvent(message, {});
        }
        expect(message.channel.send).toHaveBeenCalledTimes(1);
        expect(guildState.get('g1').messagesSince).toBe(0);
    });
});

describe('admin controls', () => {
    const { FREQUENCY_PRESETS } = chatEventService.__test__;
    beforeEach(() => guildState.clear());

    async function chat(message, settings, times) {
        for (let n = 0; n < times; n++) await chatEventService.maybeTriggerChatEvent(message, settings);
    }

    test('the master switch stops everything', async () => {
        const { message } = makeMessage();
        await chat(message, { economy: { chatEventsEnabled: false } }, 50);
        expect(message.channel.send).not.toHaveBeenCalled();
        expect(guildState.size).toBe(0);
    });

    test('the frequency preset sets the message threshold', async () => {
        const { message } = makeMessage();
        const settings = { economy: { chatEventFrequency: 'low' } };
        await chat(message, settings, FREQUENCY_PRESETS.low.minMessages - 1);
        expect(message.channel.send).not.toHaveBeenCalled();
        await chat(message, settings, 1);
        expect(message.channel.send).toHaveBeenCalledTimes(1);

        guildState.clear();
        const fast = makeMessage();
        await chat(fast.message, { economy: { chatEventFrequency: 'high' } }, FREQUENCY_PRESETS.high.minMessages);
        expect(fast.message.channel.send).toHaveBeenCalledTimes(1);
    });

    test('an unknown frequency falls back to normal', async () => {
        const { message } = makeMessage();
        await chat(message, { economy: { chatEventFrequency: 'ludicrous' } }, FREQUENCY_PRESETS.normal.minMessages);
        expect(message.channel.send).toHaveBeenCalledTimes(1);
    });

    test('chat in an excluded channel never counts, nor does chat in its threads', async () => {
        const { message } = makeMessage();
        message.channel.id = 'serious';
        const settings = { economy: { chatEventExcludedChannelIds: ['serious'] } };
        await chat(message, settings, 50);
        expect(guildState.get('g1')).toBeUndefined();

        const thread = makeMessage();
        thread.message.channel.id = 'thread1';
        thread.message.channel.parentId = 'serious';
        await chat(thread.message, settings, 50);
        expect(thread.message.channel.send).not.toHaveBeenCalled();
    });

    test('an events channel receives the event instead of the chat channel', async () => {
        const { message } = makeMessage();
        const events = makeMessage().message.channel;
        events.id = 'events';
        message.guild.channels = { cache: new Map([['events', events]]) };

        await chat(message, { economy: { chatEventChannelId: 'events' } }, MIN_MESSAGES_BETWEEN);
        expect(message.channel.send).not.toHaveBeenCalled();
        expect(events.send).toHaveBeenCalledTimes(1);
    });

    test('a missing events channel holds the event and keeps the cooldown', async () => {
        const { message } = makeMessage();
        message.guild.channels = { cache: new Map() };
        await chat(message, { economy: { chatEventChannelId: 'gone' } }, MIN_MESSAGES_BETWEEN);
        expect(message.channel.send).not.toHaveBeenCalled();
        expect(guildState.get('g1').lastEventAt).toBe(0);
    });

    test('per-kind switches choose among what is left on', async () => {
        // Math.random is pinned to 0, which picks the first enabled kind.
        const { message } = makeMessage();
        getQuestion.mockResolvedValue({ question: 'Q?', correct_answer: 'A', incorrect_answers: ['B'] });
        await chat(message, {
            economy: { chatEventAirdropsEnabled: false, chatEventCratesEnabled: false },
        }, MIN_MESSAGES_BETWEEN);
        expect(message.channel.send.mock.calls[0][0].embeds[0].toJSON().title).toContain('Trivia');
    });

    test('with every kind off nothing fires', async () => {
        const { message } = makeMessage();
        await chat(message, {
            economy: { chatEventAirdropsEnabled: false, chatEventCratesEnabled: false, chatEventTriviaEnabled: false },
        }, 50);
        expect(message.channel.send).not.toHaveBeenCalled();
    });
});

describe('fairness', () => {
    const { FREQUENCY_PRESETS, AUTHOR_COUNT_GAP_MS } = chatEventService.__test__;
    beforeEach(() => guildState.clear());

    const pinAuthor = (message, id) => Object.defineProperty(message, 'author', { value: { id }, configurable: true });

    test('every event posts locked, then unlocks', async () => {
        const { message, sent } = makeMessage();
        await spawnAirdrop(message, {});
        const posted = message.channel.send.mock.calls[0][0];
        expect(posted.components[0].toJSON().components[0].disabled).toBe(true);
        expect(posted.embeds[0].toJSON().description).toContain('Unlocks in a moment');

        const live = sent.edit.mock.calls[0][0];
        expect(live.components[0].toJSON().components[0].disabled).toBe(false);
        expect(live.embeds[0].toJSON().description).toMatch(/<t:\d+:R>/);
    });

    test('one person spamming never earns an event', async () => {
        const { message } = makeMessage();
        pinAuthor(message, 'spammer');
        for (let n = 0; n < 200; n++) await chatEventService.maybeTriggerChatEvent(message, {});
        expect(message.channel.send).not.toHaveBeenCalled();
        // A burst inside the gap counts once.
        expect(guildState.get('g1').messagesSince).toBe(1);
    });

    test('the same author counts again once the gap has passed', async () => {
        const { message } = makeMessage();
        pinAuthor(message, 'steady');
        const now = jest.spyOn(Date, 'now');
        let t = 1_000_000;
        now.mockImplementation(() => t);
        for (let n = 0; n < 5; n++) {
            await chatEventService.maybeTriggerChatEvent(message, {});
            t += AUTHOR_COUNT_GAP_MS;
        }
        expect(guildState.get('g1').messagesSince).toBe(5);
    });

    test('an event needs enough different people', async () => {
        const { message } = makeMessage();
        const pace = FREQUENCY_PRESETS.normal;
        const now = jest.spyOn(Date, 'now');
        let t = 1_000_000;
        now.mockImplementation(() => t);
        // Two people trading messages well past the message bar.
        for (let n = 0; n < pace.minMessages * 2; n++) {
            pinAuthor(message, n % 2 ? 'alice' : 'bob');
            await chatEventService.maybeTriggerChatEvent(message, {});
            t += AUTHOR_COUNT_GAP_MS;
        }
        expect(message.channel.send).not.toHaveBeenCalled();

        pinAuthor(message, 'carol');
        await chatEventService.maybeTriggerChatEvent(message, {});
        expect(message.channel.send).toHaveBeenCalledTimes(1);
        expect(guildState.get('g1').authors.size).toBe(0);
    });
});

describe('drop variants', () => {
    const { rollDropVariant, spawnSplitDrop, SPLIT_SHARES, GOLDEN_MULTIPLIER } = chatEventService.__test__;

    test('the roll is mostly standard, sometimes split, rarely golden', () => {
        Math.random.mockReturnValue(0.5);
        expect(rollDropVariant()).toBe('standard');
        Math.random.mockReturnValue(0.85);
        expect(rollDropVariant()).toBe('split');
        Math.random.mockReturnValue(0.97);
        expect(rollDropVariant()).toBe('golden');
    });

    test('a golden drop pays the multiplied amount and says so', async () => {
        const { message, collector } = makeMessage();
        await spawnAirdrop(message, {}, 'golden');
        expect(message.channel.send.mock.calls[0][0].embeds[0].toJSON().title).toContain('GOLDEN');

        const i = click('chatev_air_msg1');
        await collect(collector, i);
        expect(creditCoinsOrOwe).toHaveBeenCalledWith(expect.anything(), 500 * GOLDEN_MULTIPLIER, expect.anything());
        expect(i.editReply.mock.calls[0][0].embeds[0].toJSON().title).toContain('Golden');
    });

    test('a split drop pays one share to each of the first grabbers', async () => {
        const { message, sent, collector } = makeMessage();
        await spawnSplitDrop(message, {});
        // Math.random 0 → the minimum pot, 1,500, so 500 a share.
        for (let n = 1; n <= SPLIT_SHARES; n++) await collect(collector, click('chatev_split_msg1', `u${n}`));

        expect(creditCoinsOrOwe).toHaveBeenCalledTimes(SPLIT_SHARES);
        for (let n = 1; n <= SPLIT_SHARES; n++) {
            expect(creditCoinsOrOwe).toHaveBeenCalledWith(
                { userId: `u${n}`, guildId: 'g1' }, 500,
                expect.objectContaining({ payoutKey: 'chatevent:split:drop1' }),
            );
        }
        expect(collector.stop).toHaveBeenCalledWith('claimed');
        await Promise.resolve();
        const last = sent.edit.mock.calls.at(-1)[0];
        expect(last.embeds[0].toJSON().title).toContain('shared out');
        expect(last.components).toEqual([]);

        const late = click('chatev_split_msg1', 'u9');
        await collect(collector, late);
        expect(late.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('every share is taken') }));
    });

    test('nobody gets two shares', async () => {
        const { message, collector } = makeMessage();
        await spawnSplitDrop(message, {});
        await collect(collector, click('chatev_split_msg1', 'u1'));
        const again = click('chatev_split_msg1', 'u1');
        await collect(collector, again);
        expect(again.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('already grabbed') }));
        expect(creditCoinsOrOwe).toHaveBeenCalledTimes(1);
    });

    test('a frozen member does not take a share from anyone', async () => {
        const { message, collector } = makeMessage();
        await spawnSplitDrop(message, {});
        User.findOne.mockReturnValueOnce(lean({ economyFrozen: true }));
        await collect(collector, click('chatev_split_msg1', 'frozen'));
        for (let n = 1; n <= SPLIT_SHARES; n++) await collect(collector, click('chatev_split_msg1', `u${n}`));
        expect(creditCoinsOrOwe).toHaveBeenCalledTimes(SPLIT_SHARES);
        expect(creditCoinsOrOwe).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'frozen' }), expect.anything(), expect.anything());
    });

    test('shares left at the timeout drift away; the claimed ones stand', async () => {
        const { message, sent, collector } = makeMessage();
        await spawnSplitDrop(message, {});
        await collect(collector, click('chatev_split_msg1', 'u1'));
        collector.emit('end', [], 'time');
        await new Promise(resolve => setImmediate(resolve));

        const card = sent.edit.mock.calls.at(-1)[0].embeds[0].toJSON();
        expect(card.title).toBe('🎁 Split drop over');
        expect(card.description).toContain('Player u1');
        expect(card.description).toContain(`${SPLIT_SHARES - 1} unclaimed shares drifted away`);
    });

    test('a split drop nobody grabs drifts away', async () => {
        const { message, sent, collector } = makeMessage();
        await spawnSplitDrop(message, {});
        collector.emit('end', [], 'time');
        await new Promise(resolve => setImmediate(resolve));
        expect(sent.edit.mock.calls.at(-1)[0].embeds[0].toJSON().title).toContain('drifted away');
    });
});
