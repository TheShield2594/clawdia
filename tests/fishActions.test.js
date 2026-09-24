'use strict';

// The buttons on a /fish cast result (fish/actions.js): cast again, and keep or
// release a landed fish. Driven through a real replay session over a fake
// message, with the database and the lock stubbed.

const { EventEmitter } = require('events');

jest.mock('../src/utils/economyLock', () => ({ withEconomyLock: fn => fn }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({})) }));
jest.mock('../src/utils/economyFreeze', () => ({
    commandIsFreezeGated: () => true, isEconomyFrozen: jest.fn(async () => false),
    FROZEN_NOTICE: 'frozen', FREEZE_UNKNOWN_NOTICE: 'unknown',
}));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async () => {}) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn() }));
jest.mock('../src/utils/balanceDebit', () => ({ chargeExact: jest.fn(), refundCharge: jest.fn(async () => {}) }));
jest.mock('../src/utils/commandCooldowns', () => ({ claimIfAvailable: jest.fn().mockResolvedValue(0) }));

const User = require('../src/models/User');
const { chargeExact, refundCharge } = require('../src/utils/balanceDebit');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { EmbedBuilder } = require('discord.js');
const cooldownStore = require('../src/utils/commandCooldowns');
const { attachResultActions, buildResultActions, gateRefusal, IDS } = require('../src/commands/economy/fish/actions');
const { RELEASE_KARMA_MAX } = require('../src/services/fishService');

const ids = rows => rows.flatMap(r => r.toJSON().components.map(c => c.custom_id));

function angler(pending) {
    return {
        userId: 'u1', guildId: 'g1', balance: 900,
        fishing: {
            level: 3, xp: 100, prestige: 0, totalEarned: 5000, dailyCoins: 800, releaseKarma: 0, fishReleased: 0,
            pendingRelease: pending, rods: [], catalog: {},
        },
        markModified() {}, unmarkModified: jest.fn(), save: jest.fn(async () => {}),
    };
}

const CDN = 'https://cdn.discordapp.com/attachments/c1/m1';
const PENDING = { castId: 'cast1', fishId: 'bass', fishName: 'Largemouth Bass', payout: 300, xp: 40 };

function setup({ execute = jest.fn(async () => ({ started: true })) } = {}) {
    const collector = new EventEmitter();
    collector.ended = false;
    collector.resetTimer = jest.fn();
    collector.stop = jest.fn(reason => { collector.ended = true; collector.emit('end', null, reason); });
    const message = { createMessageComponentCollector: () => collector };
    const edits = [];
    const interaction = {
        id: 'cast1',
        user: { id: 'u1', toString: () => '<@u1>' },
        guild: { id: 'g1' },
        fetchReply: async () => message,
        editReply: async p => { edits.push(p); },
    };
    const textEmbed = new EmbedBuilder().setTitle('Largemouth Bass').addFields({ name: 'Balance', value: '🪙900' });
    const command = { execute, category: 'economy', cooldown: 5, data: { name: 'fish' } };
    const press = async (customId, userId = 'u1') => {
        const button = {
            customId, user: { id: userId }, guild: { id: 'g1' }, member: {}, channelId: 'c1',
            client: { commands: new Map([['fish', command]]), cooldowns: new Map() },
            // As fetched: the card's image is the resolved CDN link, not attachment://.
            message: {
                embeds: [new EmbedBuilder().setImage(`${CDN}/fish-result.png?ex=1&is=2`).toJSON(), textEmbed.toJSON()],
                attachments: new Map([['a1', { name: 'fish-result.png', url: `${CDN}/fish-result.png?ex=1&is=2` }]]),
            },
            reply: jest.fn(async () => {}), deferUpdate: jest.fn(async () => {}), followUp: jest.fn(async () => {}),
        };
        collector.emit('collect', button);
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        return button;
    };
    return { interaction, edits, press, command, collector };
}

beforeEach(() => jest.clearAllMocks());

test('a landed fish offers keep and release, priced; anything else only another cast', () => {
    expect(ids(buildResultActions(PENDING))).toEqual([IDS.again, IDS.keep, IDS.release]);
    const labels = buildResultActions(PENDING)[0].toJSON().components.map(c => c.label);
    expect(labels[1]).toBe('💰 Keep (300 coins)');
    expect(labels[2]).toBe('🌊 Release (+40 XP, +1 karma)');
    expect(ids(buildResultActions(null))).toEqual([IDS.again]);
});

test('Cast again runs /fish cast at the same spot, then takes these buttons off', async () => {
    const { interaction, edits, press, command, collector } = setup();
    await attachResultActions(interaction, { locationId: 'river' });
    await press(IDS.again);

    const proxied = command.execute.mock.calls[0][0];
    expect(proxied.commandName).toBe('fish');
    expect(proxied.options.getSubcommandGroup()).toBeNull();
    expect(proxied.options.getSubcommand()).toBe('cast');
    expect(proxied.options.getString('location')).toBe('river');
    expect(collector.stop).toHaveBeenCalledWith('replayed');
    expect(edits.at(-1)).toEqual({ components: [] });
});

test('a cast that did not start (cooldown, say) leaves the buttons up', async () => {
    const { interaction, press, collector } = setup({ execute: jest.fn(async () => undefined) });
    await attachResultActions(interaction, { locationId: 'river' });
    await press(IDS.again);
    expect(collector.stop).not.toHaveBeenCalled();
    expect(collector.resetTimer).toHaveBeenCalled();
});

test('a server policy that blocks /fish blocks the button too', async () => {
    getGuildSettings.mockResolvedValueOnce({ commandPolicies: { enabled: true, rules: [{ command: 'fish', effect: 'deny' }] } });
    const { interaction, press, command } = setup();
    await attachResultActions(interaction, {});
    const button = await press(IDS.again);
    expect(command.execute).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/blocked by server policy/) }));
});

test('Release takes the coins back exactly, pays the XP and a karma charge, and says so', async () => {
    const user = angler({ ...PENDING });
    User.findOne.mockResolvedValue(user);
    chargeExact.mockResolvedValue({ balance: 600 });
    const { interaction, edits, press } = setup();
    await attachResultActions(interaction, {});
    await press(IDS.release);

    expect(chargeExact).toHaveBeenCalledWith(User, { userId: 'u1', guildId: 'g1' }, 300);
    expect(user.balance).toBe(600);
    expect(user.unmarkModified).toHaveBeenCalledWith('balance');
    expect(user.fishing).toMatchObject({ totalEarned: 4700, dailyCoins: 500, releaseKarma: 1, fishReleased: 1, pendingRelease: null });
    expect(user.fishing.xp).toBe(140);
    expect(user.save).toHaveBeenCalled();

    const last = edits.at(-1);
    expect(ids(last.components)).toEqual([IDS.again]);
    const call = last.embeds[1].data.fields.find(f => f.name === '🎣 Your Call').value;
    expect(call).toContain('Released the **Largemouth Bass**');
    expect(call).toContain('+40 XP');
});

test('karma charges stop at the cap', async () => {
    const user = angler({ ...PENDING });
    user.fishing.releaseKarma = RELEASE_KARMA_MAX;
    User.findOne.mockResolvedValue(user);
    chargeExact.mockResolvedValue({ balance: 600 });
    const { interaction, press } = setup();
    await attachResultActions(interaction, {});
    await press(IDS.release);
    expect(user.fishing.releaseKarma).toBe(RELEASE_KARMA_MAX);
});

test('an angler who has spent the coins cannot release, and nothing moves', async () => {
    const user = angler({ ...PENDING });
    User.findOne.mockResolvedValue(user);
    chargeExact.mockResolvedValue(null);
    const { interaction, edits, press } = setup();
    await attachResultActions(interaction, {});
    const button = await press(IDS.release);

    expect(user.save).not.toHaveBeenCalled();
    expect(user.fishing.pendingRelease).not.toBeNull();
    expect(button.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/no longer have the 300 coins/) }));
    expect(edits).toEqual([]);
});

test('a release from another cast (a stale result) is refused', async () => {
    User.findOne.mockResolvedValue(angler({ ...PENDING, castId: 'a-later-cast' }));
    const { interaction, press } = setup();
    await attachResultActions(interaction, {});
    const button = await press(IDS.release);
    expect(chargeExact).not.toHaveBeenCalled();
    expect(button.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: 'That fish is no longer yours to release.' }));
});

test('a release whose save fails hands the coins back', async () => {
    const user = angler({ ...PENDING });
    user.save.mockRejectedValue(new Error('db down'));
    User.findOne.mockResolvedValue(user);
    chargeExact.mockResolvedValue({ balance: 600 });
    const { interaction, press } = setup();
    await attachResultActions(interaction, {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await press(IDS.release);
    expect(refundCharge).toHaveBeenCalledWith(User, { userId: 'u1', guildId: 'g1' }, 300, 'fish release');
    console.error.mockRestore();
});

test('Keep closes the offer: the release is gone and only Cast again is left', async () => {
    const user = angler({ ...PENDING });
    User.findOne.mockResolvedValue(user);
    const { interaction, edits, press } = setup();
    await attachResultActions(interaction, {});
    await press(IDS.keep);
    expect(user.fishing.pendingRelease).toBeNull();
    expect(user.save).toHaveBeenCalled();
    expect(chargeExact).not.toHaveBeenCalled();
    expect(ids(edits.at(-1).components)).toEqual([IDS.again]);
});

test('the edited result points the card back at its attachment, so it is not shown twice', async () => {
    User.findOne.mockResolvedValue(angler({ ...PENDING }));
    const { interaction, edits, press } = setup();
    await attachResultActions(interaction, {});
    await press(IDS.keep);
    const [card, text] = edits.at(-1).embeds;
    expect(card.data.image.url).toBe('attachment://fish-result.png');
    expect(text.data.image).toBeUndefined();
});

test('someone else pressing the buttons is turned away', async () => {
    const { interaction, press, command } = setup();
    await attachResultActions(interaction, {});
    const button = await press(IDS.again, 'u2');
    expect(command.execute).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/belongs to <@u1>/) }));
});

describe('the command cooldown', () => {
    const button = { user: { id: 'u1' }, member: { roles: { cache: new Map([['vip', {}]]) } }, channelId: 'c1', guild: { id: 'g1' }, client: { cooldowns: new Map() } };
    const command = { category: 'economy', cooldown: 5, data: { name: 'fish' } };

    test('Cast again spends the same cooldown a typed /fish does, and refuses while it runs', async () => {
        const until = Date.now() + 4_000;
        cooldownStore.claimIfAvailable.mockResolvedValueOnce(until);
        const refusal = await gateRefusal(button, command);
        expect(cooldownStore.claimIfAvailable).toHaveBeenLastCalledWith(button.client, {
            bucket: 'fish', userId: 'u1', guildId: 'g1', cooldownMs: 5_000,
        });
        expect(refusal).toBe(`Please wait, you are on cooldown. You can use \`/fish\` again <t:${Math.round(until / 1000)}:R>.`);
    });

    test('honours an admin\'s per-role cooldown override', async () => {
        getGuildSettings.mockResolvedValueOnce({
            commandPolicies: { cooldownOverrides: [{ command: 'fish', roleId: 'vip', cooldownSeconds: 60 }] },
        });
        await gateRefusal(button, command);
        expect(cooldownStore.claimIfAvailable.mock.calls.at(-1)[1].cooldownMs).toBe(60_000);
    });

    test('keep and release run no command and spend no cooldown', async () => {
        User.findOne.mockResolvedValue(angler({ ...PENDING }));
        const { interaction, press } = setup();
        await attachResultActions(interaction, {});
        cooldownStore.claimIfAvailable.mockClear();
        await press(IDS.keep);
        expect(cooldownStore.claimIfAvailable).not.toHaveBeenCalled();
    });

    test('a Cast again on cooldown is refused without casting', async () => {
        cooldownStore.claimIfAvailable.mockResolvedValueOnce(Date.now() + 3_000);
        const { interaction, press, command } = setup();
        await attachResultActions(interaction, {});
        const button = await press(IDS.again);
        expect(command.execute).not.toHaveBeenCalled();
        expect(button.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/on cooldown/) }));
    });
});
