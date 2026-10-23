'use strict';

// The "Dig again" button on a /mine dig result (mine/actions.js). Driven through
// a real replay session over a fake message, with the lock and settings stubbed.

const { EventEmitter } = require('events');

jest.mock('../src/utils/economyLock', () => ({ withEconomyLock: fn => fn }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({})) }));
jest.mock('../src/utils/economyFreeze', () => ({
    commandIsFreezeGated: () => true, isEconomyFrozen: jest.fn(async () => false),
    FROZEN_NOTICE: 'frozen', FREEZE_UNKNOWN_NOTICE: 'unknown',
}));
jest.mock('../src/utils/commandCooldowns', () => ({ claimIfAvailable: jest.fn().mockResolvedValue(0) }));

const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { isEconomyFrozen } = require('../src/utils/economyFreeze');
const { attachResultActions, buildResultActions, IDS } = require('../src/commands/economy/mine/actions');

const ids = rows => rows.flatMap(r => r.toJSON().components.map(c => c.custom_id));

function setup({ execute = jest.fn(async () => ({ started: true })) } = {}) {
    const collector = new EventEmitter();
    collector.ended = false;
    collector.resetTimer = jest.fn();
    collector.stop = jest.fn(reason => { collector.ended = true; collector.emit('end', null, reason); });
    const message = { createMessageComponentCollector: () => collector };
    const edits = [];
    const interaction = {
        id: 'dig1',
        user: { id: 'u1', toString: () => '<@u1>' },
        guild: { id: 'g1' },
        fetchReply: async () => message,
        editReply: async p => { edits.push(p); },
    };
    const command = { execute, category: 'economy', cooldown: 5, data: { name: 'mine' } };
    const press = async (customId, userId = 'u1') => {
        const button = {
            customId, user: { id: userId }, guild: { id: 'g1' }, member: {}, channelId: 'c1',
            client: { commands: new Map([['mine', command]]), cooldowns: new Map() },
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

test('a result carries one button: dig again', () => {
    expect(ids(buildResultActions())).toEqual([IDS.again]);
});

test('Dig again runs /mine dig at the same depth, opens the survey, then takes this button off', async () => {
    const { interaction, edits, press, command, collector } = setup();
    await attachResultActions(interaction, { depthId: 'iron_mines' });
    await press(IDS.again);

    const proxied = command.execute.mock.calls[0][0];
    expect(proxied.commandName).toBe('mine');
    expect(proxied.options.getSubcommandGroup()).toBeNull();
    expect(proxied.options.getSubcommand()).toBe('dig');
    expect(proxied.options.getString('depth')).toBe('iron_mines');
    // No intensity: the new dig reads the rock and asks again.
    expect(proxied.options.getInteger('intensity')).toBeNull();
    expect(collector.stop).toHaveBeenCalledWith('replayed');
    expect(edits.at(-1)).toEqual({ components: [] });
});

test('a dig that did not start (cooldown, say) leaves the button up', async () => {
    const { interaction, press, collector } = setup({ execute: jest.fn(async () => undefined) });
    await attachResultActions(interaction, {});
    await press(IDS.again);
    expect(collector.stop).not.toHaveBeenCalled();
    expect(collector.resetTimer).toHaveBeenCalled();
});

test('a server policy that blocks /mine blocks the button too', async () => {
    getGuildSettings.mockResolvedValueOnce({ commandPolicies: { enabled: true, rules: [{ command: 'mine', effect: 'deny' }] } });
    const { interaction, press, command } = setup();
    await attachResultActions(interaction, {});
    const button = await press(IDS.again);
    expect(command.execute).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/blocked by server policy/) }));
});

test('a frozen economy blocks the button', async () => {
    isEconomyFrozen.mockResolvedValueOnce(true);
    const { interaction, press, command } = setup();
    await attachResultActions(interaction, {});
    const button = await press(IDS.again);
    expect(command.execute).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'frozen' }));
});

test('someone else pressing it is turned away', async () => {
    const { interaction, press, command } = setup();
    await attachResultActions(interaction, {});
    const button = await press(IDS.again, 'u2');
    expect(command.execute).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('/mine dig') }));
});
