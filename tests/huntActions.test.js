'use strict';

// The buttons a /hunt start result ends on: which appear when, what each one
// runs, and the gates a press has to pass — the same ones the command
// dispatcher applies to a typed /hunt, which a button would otherwise skip.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async u => u) }));
jest.mock('../src/utils/economyFreeze', () => ({
    commandIsFreezeGated: jest.fn(() => true),
    isEconomyFrozen: jest.fn().mockResolvedValue(false),
    FROZEN_NOTICE: 'frozen',
    FREEZE_UNKNOWN_NOTICE: 'freeze unknown',
}));
jest.mock('../src/utils/commandCooldowns', () => ({ claimIfAvailable: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/utils/economyLock', () => ({
    withEconomyLock: fn => fn,
}));

const User = require('../src/models/User');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { isEconomyFrozen } = require('../src/utils/economyFreeze');
const cooldownStore = require('../src/utils/commandCooldowns');
const { ensureHuntData, quoteRepair } = require('../src/services/huntService');
const { WEAPON_TIERS, AMMO_PACKS } = require('../src/data/huntData');
const {
    IDS, buildResultActions, repairAction, ammoAction, asHuntSubcommand, gateRefusal, attachResultActions,
} = require('../src/commands/economy/hunt/actions');

function makeUser(hunt = {}, weaponOver = {}) {
    const tier = weaponOver.tier ?? 1;
    const data = WEAPON_TIERS.find(w => w.tier === tier);
    const user = {
        userId: 'u1', guildId: 'g1', balance: 1000,
        markModified() {}, save: jest.fn().mockResolvedValue(),
        hunt: {
            weapons: [{
                name: data.name, tier, status: 'good', repairCount: 0,
                currentDurability: data.baseDurability, maxDurability: data.baseDurability, baseDurability: data.baseDurability,
                ...weaponOver,
            }],
            equippedWeaponIndex: 0,
            ...hunt,
        },
    };
    ensureHuntData(user);
    return user;
}

const labels = rows => rows[0].components.map(b => b.data.label);

describe('which buttons a result shows', () => {
    test('a healthy hunter gets Hunt again and the quick switch, nothing to fix', () => {
        const user = makeUser();
        expect(labels(buildResultActions(user, user.hunt.weapons[0], false)))
            .toEqual(['🏹 Hunt again', '⚡ Quick mode: Off']);
    });

    test('the quick switch reads its state', () => {
        const user = makeUser();
        const quick = buildResultActions(user, user.hunt.weapons[0], true)[0].components.at(-1);
        expect(quick.data.label).toBe('⚡ Quick mode: On');
    });

    test('a worn weapon offers a priced repair — in coins, since a button cannot draw a custom emoji', () => {
        const user = makeUser({}, { currentDurability: 2 });
        const weapon = user.hunt.weapons[0];
        const { cost } = quoteRepair(weapon);
        expect(labels(buildResultActions(user, weapon, false))).toContain(`🔧 Repair (${cost.toLocaleString()} coins)`);
    });

    test('a repair kit in the bag is used before coins are', () => {
        const user = makeUser({ consumables: { repair_kit_small: 1, repair_kit_large: 1 } }, { currentDurability: 2 });
        expect(repairAction(user, user.hunt.weapons[0])).toMatchObject({ kitId: 'repair_kit_large' });
    });

    test('a condemned weapon offers no repair at all', () => {
        const user = makeUser({}, { currentDurability: 1, maxDurability: 5 });
        expect(repairAction(user, user.hunt.weapons[0])).toBeNull();
    });

    test('a thin ammo pouch offers the pack the weapon takes', () => {
        const user = makeUser({ ammo: { steel_shot: 2 } }, { tier: 4 });
        const pack = AMMO_PACKS.find(p => p.ammoType === 'steel_shot');
        expect(ammoAction(user, user.hunt.weapons[0])).toEqual({
            itemId: pack.id, label: `${pack.emoji} Buy ${pack.name} (${pack.cost} coins)`,
        });
        expect(ammoAction(makeUser({ ammo: { steel_shot: 50 } }, { tier: 4 }), makeUser({}, { tier: 4 }).hunt.weapons[0])).toBeNull();
    });
});

describe('a button dressed as the subcommand it runs', () => {
    const button = {
        id: 'btn-1', user: { id: 'u1' },
        reply() { return this.id; },
        get replied() { return false; },
    };

    test('answers the options the handler reads', () => {
        const i = asHuntSubcommand(button, { group: 'shop', sub: 'buy', strings: { item: 'x' }, integers: { quantity: 1 } });
        expect(i.options.getSubcommandGroup(false)).toBe('shop');
        expect(i.options.getSubcommand()).toBe('buy');
        expect(i.options.getString('item')).toBe('x');
        expect(i.options.getInteger('quantity')).toBe(1);
        expect(i.options.getString('zone')).toBeNull();
        expect(i.options.getBoolean('quick')).toBeNull();
        expect(i.commandName).toBe('hunt');
    });

    test('is otherwise the button — its id, user and methods bound to it', () => {
        const i = asHuntSubcommand(button, { sub: 'start' });
        expect(i.id).toBe('btn-1');
        expect(i.user.id).toBe('u1');
        expect(i.reply()).toBe('btn-1');
        expect(i.replied).toBe(false);
    });
});

describe('the gates a press passes', () => {
    const button = { user: { id: 'u1' }, member: { roles: { cache: new Map([['vip', {}]]) } }, channelId: 'c1', guild: { id: 'g1' }, client: { cooldowns: new Map() } };
    const command = { category: 'economy', cooldown: 5, data: { name: 'hunt' } };

    test('spends the same cooldown a typed /hunt does, and refuses while it runs', async () => {
        const until = Date.now() + 4_000;
        cooldownStore.claimIfAvailable.mockResolvedValueOnce(until);

        const refusal = await gateRefusal(button, command);

        expect(cooldownStore.claimIfAvailable).toHaveBeenLastCalledWith(button.client, {
            bucket: 'hunt', userId: 'u1', guildId: 'g1', cooldownMs: 5_000,
        });
        expect(refusal).toBe(`Please wait, you are on cooldown. You can use \`/hunt\` again <t:${Math.round(until / 1000)}:R>.`);
    });

    test('honours an admin\'s per-role cooldown override', async () => {
        getGuildSettings.mockResolvedValueOnce({
            commandPolicies: { cooldownOverrides: [{ command: 'hunt', roleId: 'vip', cooldownSeconds: 60 }] },
        });
        await gateRefusal(button, command);
        expect(cooldownStore.claimIfAvailable.mock.calls.at(-1)[1].cooldownMs).toBe(60_000);
    });

    test('a press that runs no command spends no cooldown', async () => {
        cooldownStore.claimIfAvailable.mockClear();
        expect(await gateRefusal(button, command, { claimCooldown: false })).toBeNull();
        expect(cooldownStore.claimIfAvailable).not.toHaveBeenCalled();
    });

    test('a blocked press is refused before any cooldown is spent', async () => {
        cooldownStore.claimIfAvailable.mockClear();
        isEconomyFrozen.mockResolvedValueOnce(true);
        await gateRefusal(button, command);
        expect(cooldownStore.claimIfAvailable).not.toHaveBeenCalled();
    });

    test('a server policy blocking /hunt here blocks the button too', async () => {
        getGuildSettings.mockResolvedValueOnce({
            commandPolicies: { enabled: true, rules: [{ command: 'hunt', effect: 'deny', channelIds: ['c1'] }] },
        });
        expect(await gateRefusal(button, command)).toMatch(/blocked by server policy/);
    });

    test('a frozen economy is refused', async () => {
        isEconomyFrozen.mockResolvedValueOnce(true);
        expect(await gateRefusal(button, command)).toBe('frozen');
    });

    test('a freeze that cannot be read fails closed', async () => {
        isEconomyFrozen.mockRejectedValueOnce(new Error('db'));
        expect(await gateRefusal(button, command)).toBe('freeze unknown');
    });

    test('otherwise the press goes ahead', async () => {
        expect(await gateRefusal(button, command)).toBeNull();
    });
});

describe('the session on the card', () => {
    function harness() {
        let collector;
        const message = {
            createMessageComponentCollector: opts => {
                collector = {
                    opts, handlers: {}, ended: false,
                    on(ev, fn) { this.handlers[ev] = fn; return this; },
                    resetTimer() {},
                    stop(reason) { this.ended = true; this.handlers.end?.(new Map(), reason); },
                };
                return collector;
            },
        };
        const interaction = {
            user: { id: 'u1', toString: () => '<@u1>' },
            guild: { id: 'g1' },
            fetchReply: jest.fn().mockResolvedValue(message),
            editReply: jest.fn().mockResolvedValue(),
        };
        const execute = jest.fn();
        const press = async customId => {
            const btn = {
                customId, user: { id: 'u1' }, guild: { id: 'g1' }, channelId: 'c1', member: {},
                client: { cooldowns: new Map(), commands: new Map([['hunt', { category: 'economy', data: { name: 'hunt' }, execute }]]) },
                reply: jest.fn().mockResolvedValue(), deferUpdate: jest.fn().mockResolvedValue(),
            };
            await collector.handlers.collect(btn);
            return btn;
        };
        return { interaction, execute, press, get collector() { return collector; } };
    }

    test('Hunt again runs /hunt start, and retires this card once the new hunt starts', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        h.execute.mockResolvedValueOnce({ started: true });

        await h.press(IDS.again);

        const dispatched = h.execute.mock.calls[0][0];
        expect(dispatched.options.getSubcommand()).toBe('start');
        expect(h.collector.ended).toBe(true);
        expect(h.interaction.editReply).toHaveBeenCalledWith({ components: [] });
    });

    test('a refused hunt (still on cooldown) keeps the card\'s buttons', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        h.execute.mockResolvedValueOnce(undefined);

        await h.press(IDS.again);
        expect(h.collector.ended).toBe(false);
    });

    test('Repair runs /hunt shop repair on the weapon the hunt used, then redraws the buttons', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        const worn = makeUser({}, { currentDurability: 2 });
        User.findOne.mockResolvedValue(worn);

        await h.press(IDS.repair);

        const dispatched = h.execute.mock.calls[0][0];
        expect(dispatched.options.getSubcommandGroup()).toBe('shop');
        expect(dispatched.options.getSubcommand()).toBe('repair');
        expect(dispatched.options.getString('method')).toBe('shop');
        expect(h.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));
    });

    test('Repair refuses when a different weapon is equipped now', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        const user = makeUser({}, { currentDurability: 2 });
        user.hunt.weapons.push({ ...user.hunt.weapons[0] });
        user.hunt.equippedWeaponIndex = 1;
        User.findOne.mockResolvedValue(user);

        const btn = await h.press(IDS.repair);
        expect(h.execute).not.toHaveBeenCalled();
        expect(btn.reply.mock.calls[0][0].content).toMatch(/equipped a different weapon/);
    });

    test('Buy ammo buys one of the pack the weapon takes', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        User.findOne.mockResolvedValue(makeUser({ ammo: { steel_shot: 1 } }, { tier: 4 }));

        await h.press(IDS.ammo);

        const dispatched = h.execute.mock.calls[0][0];
        expect(dispatched.options.getSubcommand()).toBe('buy');
        expect(dispatched.options.getString('item')).toBe('steel_shot_pack');
        expect(dispatched.options.getInteger('quantity')).toBe(1);
    });

    test('the quick switch flips the stored preference and relabels itself', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        const user = makeUser({ quickHunt: false });
        User.findOne.mockResolvedValue(user);

        cooldownStore.claimIfAvailable.mockClear();
        const btn = await h.press(IDS.quick);

        expect(cooldownStore.claimIfAvailable).not.toHaveBeenCalled();
        expect(btn.deferUpdate).toHaveBeenCalled();
        expect(user.hunt.quickHunt).toBe(true);
        expect(user.save).toHaveBeenCalled();
        const rows = h.interaction.editReply.mock.calls.at(-1)[0].components;
        expect(labels(rows)).toContain('⚡ Quick mode: On');
    });

    test('Hunt again on cooldown is refused privately and runs nothing', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        cooldownStore.claimIfAvailable.mockResolvedValueOnce(Date.now() + 3_000);

        const btn = await h.press(IDS.again);
        expect(h.execute).not.toHaveBeenCalled();
        expect(btn.reply.mock.calls[0][0].content).toMatch(/you are on cooldown/);
    });

    test('a blocked press is refused privately and runs nothing', async () => {
        const h = harness();
        await attachResultActions(h.interaction, 0);
        isEconomyFrozen.mockResolvedValueOnce(true);

        const btn = await h.press(IDS.again);
        expect(h.execute).not.toHaveBeenCalled();
        expect(btn.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'frozen' }));
    });
});
