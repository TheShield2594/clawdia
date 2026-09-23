'use strict';

/**
 * #786. `/use` is 165 lines at 8.5% lines and 0% branches — the highest
 * branch-per-line density in the economy set, since it is a switchboard: an
 * active effect, a streak freeze, a black-market contract, a stamina upgrade,
 * a pet slot, a revive scroll, a seasonal loot box, or a plain role-granting
 * shop item. None of those branches had ever run, and every one of them
 * consumes an item.
 *
 * Each consumption is a compare-and-set on the inventory slot, which is the
 * thing worth pinning: a read-then-save would let two clicks spend one item
 * twice. tests/helpers/fakeCollection.js evaluates the `$elemMatch` guard and
 * binds the positional `$`, so a refusal here is a real refusal.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', { balance: 0, inventory: [], activeEffects: [], pets: [] });
const mockGuilds = fakeCollection('Guild');

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/models/AiItem', () => ({
    find: jest.fn(() => ({ lean: async () => [
        { itemId: 'ai_1787098249128_rg760', name: 'Ember of the Last Oath', emoji: '🔥', rarity: 'Epic' },
    ] })),
}));
jest.mock('../src/utils/inventoryGrant', () => ({
    grantInventoryItem: jest.fn(async () => true),
    inventoryAddExpr: jest.fn(() => ({})),
}));

const use = require('../src/commands/economy/use');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

const seedUser = (fields = {}) => mockUsers.seed({ userId: USER_ID, guildId: GUILD_ID, ...fields });
const seedGuild = (fields = {}) => mockGuilds.seed({ guildId: GUILD_ID, economy: { currency: '💰' }, ...fields });

const run = async (item, { channels } = {}) => {
    const interaction = makeInteraction({ options: { item }, channels });
    await use.execute(interaction);
    return interaction;
};

/** The stored slot for an item, or undefined once it is gone. */
const slot = itemId => mockUsers.get(USER_ID).inventory.find(e => e.itemId === itemId);

beforeEach(() => {
    mockUsers.reset();
    mockGuilds.reset();
    jest.clearAllMocks();
});

describe('nothing to use', () => {
    it('refuses an empty inventory', async () => {
        seedUser({ inventory: [] });
        seedGuild();

        const interaction = await run('lucky_charm');

        expect(repliedText(interaction)).toContain('inventory is empty');
        expect(mockUsers.writes).toEqual([]);
    });

    it('refuses an item the player does not hold', async () => {
        seedUser({ inventory: [{ itemId: 'streak_freeze', quantity: 1 }] });
        seedGuild();

        const interaction = await run('lucky_charm');

        expect(repliedText(interaction)).toContain("don't have **lucky_charm**");
        expect(mockUsers.writes).toEqual([]);
    });

    it('refuses a slot that has run down to zero', async () => {
        seedUser({ inventory: [{ itemId: 'lucky_charm', quantity: 0 }] });
        seedGuild();

        const interaction = await run('lucky_charm');

        expect(repliedText(interaction)).toContain("don't have");
        expect(mockUsers.writes).toEqual([]);
    });

    it('matches the item however the player capitalised it', async () => {
        seedUser({ inventory: [{ itemId: 'lucky_charm', quantity: 1 }] });
        seedGuild();

        const interaction = await run('Lucky_Charm');

        expect(repliedText(interaction)).toContain('Activated');
        expect(slot('lucky_charm')).toBeUndefined();
    });
});

describe('an active-effect item', () => {
    it('consumes one and starts the effect', async () => {
        seedUser({ inventory: [{ itemId: 'lucky_charm', quantity: 3 }] });
        seedGuild();

        const interaction = await run('lucky_charm');

        expect(repliedText(interaction)).toContain('Activated: Lucky Charm');
        expect(slot('lucky_charm').quantity).toBe(2);
        expect(mockUsers.get(USER_ID).activeEffects.map(e => e.type)).toContain('lucky_charm');
    });

    it('consumes it and starts the effect in one compare-and-set, not a read then a save', async () => {
        seedUser({ inventory: [{ itemId: 'lucky_charm', quantity: 3 }] });
        seedGuild();

        await run('lucky_charm');

        // The effect rides the same write (#873, pass 14), so the slot is
        // addressed by arrayFilters rather than the positional `$`.
        const consume = mockUsers.writes.find(w => w.update?.$inc?.['inventory.$[inv].quantity'] === -1);
        expect(consume.query.inventory.$elemMatch).toEqual({ itemId: 'lucky_charm', quantity: { $gt: 0 } });
        expect(consume.update.$push.activeEffects).toMatchObject({ type: 'lucky_charm' });
    });

    it('refuses while the same effect is already running, and consumes nothing', async () => {
        seedUser({
            inventory: [{ itemId: 'lucky_charm', quantity: 3 }],
            activeEffects: [{ type: 'lucky_charm', expiresAt: new Date(Date.now() + 3_600_000) }],
        });
        seedGuild();

        const interaction = await run('lucky_charm');

        expect(repliedText(interaction)).toContain('already active');
        expect(slot('lucky_charm').quantity).toBe(3);
        expect(mockUsers.writes).toEqual([]);
    });

    it('drops the slot with a $pull once it empties, never a whole-array $set', async () => {
        // A save() would write the array back from a snapshot and erase
        // anything bought or gifted in between, which is what the $pull is for.
        seedUser({ inventory: [{ itemId: 'lucky_charm', quantity: 1 }] });
        seedGuild();

        await run('lucky_charm');

        const cleanup = mockUsers.writes.find(w => w.update?.$pull?.inventory);
        expect(cleanup.update.$pull.inventory).toEqual({ quantity: { $lte: 0 } });
        expect(mockUsers.writes.some(w => w.update?.$set?.inventory)).toBe(false);
        expect(slot('lucky_charm')).toBeUndefined();
    });
});

describe('the streak freeze', () => {
    it('banks one and consumes the item', async () => {
        seedUser({ inventory: [{ itemId: 'streak_freeze', quantity: 2 }], streak: { current: 5, freezes: 0 } });
        seedGuild();

        const interaction = await run('streak_freeze');

        expect(repliedText(interaction)).toContain('Streak Freeze Banked');
        expect(mockUsers.get(USER_ID).streak.freezes).toBe(1);
        expect(slot('streak_freeze').quantity).toBe(1);
    });

    it('refuses at the cap, and consumes nothing', async () => {
        seedUser({ inventory: [{ itemId: 'streak_freeze', quantity: 2 }], streak: { current: 5, freezes: 2 } });
        seedGuild();

        const interaction = await run('streak_freeze');

        expect(repliedText(interaction)).toContain('max 2');
        expect(slot('streak_freeze').quantity).toBe(2);
        expect(mockUsers.get(USER_ID).streak.freezes).toBe(2);
    });

    it('carries the cap in the write, so two clicks cannot both bank', async () => {
        seedUser({ inventory: [{ itemId: 'streak_freeze', quantity: 2 }], streak: { current: 5, freezes: 1 } });
        seedGuild();

        await run('streak_freeze');

        const bank = mockUsers.writes.find(w => w.update?.$inc?.['streak.freezes'] === 1);
        expect(bank.query['streak.freezes']).toEqual({ $lt: 2 });
    });
});

describe('the black market contract', () => {
    it('adds a stack and consumes the contract', async () => {
        seedUser({ inventory: [{ itemId: 'black_market_contract', quantity: 1 }], crimeContractStacks: 0 });
        seedGuild();

        await run('black_market_contract');

        expect(mockUsers.get(USER_ID).crimeContractStacks).toBe(1);
        expect(slot('black_market_contract')).toBeUndefined();
    });

    it('refuses past three stacks', async () => {
        seedUser({ inventory: [{ itemId: 'black_market_contract', quantity: 1 }], crimeContractStacks: 3 });
        seedGuild();

        const interaction = await run('black_market_contract');

        expect(repliedText(interaction)).toContain('max 3');
        expect(slot('black_market_contract').quantity).toBe(1);
    });
});

describe('the stamina upgrade', () => {
    it('applies one and consumes the item', async () => {
        seedUser({ inventory: [{ itemId: 'permanent_stamina', quantity: 1 }], staminaUpgrades: 0 });
        seedGuild();

        await run('permanent_stamina');

        expect(mockUsers.get(USER_ID).staminaUpgrades).toBe(1);
        expect(slot('permanent_stamina')).toBeUndefined();
    });

    it('refuses at the cap', async () => {
        const { MAX_STAMINA_UPGRADES } = require('../src/data/crossSystemData');
        seedUser({ inventory: [{ itemId: 'permanent_stamina', quantity: 1 }], staminaUpgrades: MAX_STAMINA_UPGRADES });
        seedGuild();

        const interaction = await run('permanent_stamina');

        expect(repliedText(interaction)).toContain('already have all');
        expect(slot('permanent_stamina').quantity).toBe(1);
    });
});

describe('the pet slot expansion', () => {
    it('adds a slot and consumes the item', async () => {
        seedUser({ inventory: [{ itemId: 'pet_slot_expansion', quantity: 1 }], petSlots: 0 });
        seedGuild();

        await run('pet_slot_expansion');

        expect(mockUsers.get(USER_ID).petSlots).toBe(1);
        expect(slot('pet_slot_expansion')).toBeUndefined();
    });

    it('refuses once every expansion is bought', async () => {
        const { MAX_SLOT_EXPANSIONS } = require('../src/services/petService');
        seedUser({ inventory: [{ itemId: 'pet_slot_expansion', quantity: 1 }], petSlots: MAX_SLOT_EXPANSIONS });
        seedGuild();

        const interaction = await run('pet_slot_expansion');

        expect(repliedText(interaction)).toContain('already have all');
        expect(slot('pet_slot_expansion').quantity).toBe(1);
    });
});

describe('the revive scroll', () => {
    const fallen = { _id: 'dead-1', petId: 'cat', name: 'Mittens', level: 4, battleWins: 2, battleLosses: 1 };

    it('refuses when no pet has starved', async () => {
        seedUser({ inventory: [{ itemId: 'revive_scroll', quantity: 1 }], deceasedPets: [] });
        seedGuild();

        const interaction = await run('revive_scroll');

        expect(repliedText(interaction)).toContain('finds no one to call back');
        expect(slot('revive_scroll').quantity).toBe(1);
    });

    it('brings the pet back, weak but whole, and consumes the scroll', async () => {
        seedUser({
            inventory: [{ itemId: 'revive_scroll', quantity: 1 }],
            deceasedPets: [fallen], pets: [], petSlots: 0,
        });
        seedGuild();

        const interaction = await run('revive_scroll');

        expect(repliedText(interaction)).toContain('Mittens Returns');
        const stored = mockUsers.get(USER_ID);
        expect(stored.pets).toHaveLength(1);
        expect(stored.pets[0]).toMatchObject({ petId: 'cat', name: 'Mittens', level: 4, hunger: 50, starving: false });
        // The old record has to go, or a second click revives the same pet.
        expect(stored.deceasedPets).toEqual([]);
        expect(slot('revive_scroll')).toBeUndefined();
    });

    it('refuses when the same pet is already back', async () => {
        seedUser({
            inventory: [{ itemId: 'revive_scroll', quantity: 1 }],
            deceasedPets: [fallen], pets: [{ petId: 'cat', name: 'Mittens 2' }],
        });
        seedGuild();

        const interaction = await run('revive_scroll');

        expect(repliedText(interaction)).toContain("won't make a second");
        expect(slot('revive_scroll').quantity).toBe(1);
    });
});

describe('a plain shop item', () => {
    it('consumes it and says what it was', async () => {
        seedUser({ inventory: [{ itemId: 'party_hat', quantity: 2 }] });
        seedGuild({ shop: [{ name: 'party_hat', description: 'A festive hat.' }] });

        const interaction = await run('party_hat');

        expect(repliedText(interaction)).toContain('Used: party_hat');
        expect(repliedText(interaction)).toContain('A festive hat.');
        expect(slot('party_hat').quantity).toBe(1);
        // The document read back is already net of the one just used.
        expect(repliedText(interaction)).toContain('1x');
    });

    it('grants the role a shop item carries', async () => {
        seedUser({ inventory: [{ itemId: 'vip_pass', quantity: 1 }] });
        seedGuild({ shop: [{ name: 'vip_pass', roleId: 'role-9' }] });

        const interaction = makeInteraction({ options: { item: 'vip_pass' } });
        const add = jest.fn().mockResolvedValue(undefined);
        interaction.guild.members.fetch = jest.fn().mockResolvedValue({
            roles: { cache: { has: () => false }, add },
        });

        await use.execute(interaction);

        expect(add).toHaveBeenCalledWith('role-9', expect.stringContaining('vip_pass'));
    });

    it('refuses a role item the member already has, and spends nothing', async () => {
        seedUser({ inventory: [{ itemId: 'vip_pass', quantity: 1 }] });
        seedGuild({ shop: [{ name: 'vip_pass', roleId: 'role-9' }] });

        const interaction = makeInteraction({ options: { item: 'vip_pass' } });
        const add = jest.fn();
        interaction.guild.members.fetch = jest.fn().mockResolvedValue({
            roles: { cache: { has: () => true }, add },
        });

        await use.execute(interaction);

        expect(add).not.toHaveBeenCalled();
        expect(repliedText(interaction)).toContain('already have');
        expect(slot('vip_pass').quantity).toBe(1);
        expect(mockUsers.writes).toEqual([]);
    });

    it('spends nothing when the member cannot be fetched', async () => {
        seedUser({ inventory: [{ itemId: 'vip_pass', quantity: 1 }] });
        seedGuild({ shop: [{ name: 'vip_pass', roleId: 'role-9' }] });

        const interaction = await run('vip_pass');   // the harness fetch resolves null

        expect(repliedText(interaction)).toContain("Couldn't check your roles");
        expect(slot('vip_pass').quantity).toBe(1);
        expect(mockUsers.writes).toEqual([]);
    });

    it('hands the item back when Discord refuses the role', async () => {
        seedUser({ inventory: [{ itemId: 'vip_pass', quantity: 1 }] });
        seedGuild({ shop: [{ name: 'vip_pass', roleId: 'role-9' }] });

        const interaction = makeInteraction({ options: { item: 'vip_pass' } });
        interaction.guild.members.fetch = jest.fn().mockResolvedValue({
            roles: { cache: { has: () => false }, add: jest.fn().mockRejectedValue(new Error('Missing Permissions')) },
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await use.execute(interaction);
        errorSpy.mockRestore();

        expect(grantInventoryItem).toHaveBeenCalledWith(USER_ID, GUILD_ID, 'vip_pass', 1, expect.anything());
        expect(repliedText(interaction)).toContain('was returned');
    });

    it('spends only one of two items when the role is redeemed twice at once', async () => {
        seedUser({ inventory: [{ itemId: 'vip_pass', quantity: 2 }] });
        seedGuild({ shop: [{ name: 'vip_pass', roleId: 'role-9' }] });

        // One member whose role cache fills in once the first add lands, shared
        // by both presses the way Discord's cache would be.
        const roles = new Set();
        const member = { roles: { cache: { has: id => roles.has(id) }, add: jest.fn(async id => { roles.add(id); }) } };
        const press = () => {
            const interaction = makeInteraction({ options: { item: 'vip_pass' } });
            interaction.guild.members.fetch = jest.fn().mockResolvedValue(member);
            return interaction;
        };
        const [first, second] = [press(), press()];

        await Promise.all([use.execute(first), use.execute(second)]);

        expect(member.roles.add).toHaveBeenCalledTimes(1);
        expect(slot('vip_pass').quantity).toBe(1);
        expect(repliedText(second)).toContain('already have');
    });

    it('fetches the member fresh, not from a cache that may be stale', async () => {
        seedUser({ inventory: [{ itemId: 'vip_pass', quantity: 1 }] });
        seedGuild({ shop: [{ name: 'vip_pass', roleId: 'role-9' }] });

        const interaction = makeInteraction({ options: { item: 'vip_pass' } });
        interaction.guild.members.fetch = jest.fn().mockResolvedValue({
            roles: { cache: { has: () => false }, add: jest.fn(async () => {}) },
        });
        await use.execute(interaction);

        expect(interaction.guild.members.fetch).toHaveBeenCalledWith({ user: USER_ID, force: true });
        // Private acknowledgement first, before any of the slow work…
        expect(interaction.deferReply).toHaveBeenCalledWith({ flags: expect.any(Number) });
        expect(interaction.deferReply.mock.invocationCallOrder[0])
            .toBeLessThan(interaction.guild.members.fetch.mock.invocationCallOrder[0]);
        // …and the result announced publicly.
        expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    });

    it('redeems a custom shop item with no role', async () => {
        seedUser({ inventory: [{ itemId: 'shoutout_ticket', quantity: 1 }] });
        seedGuild({ shop: [{ name: 'shoutout_ticket', description: 'Redeem for a shoutout.' }] });

        const interaction = await run('shoutout_ticket');

        expect(repliedText(interaction)).toContain('Used: shoutout_ticket');
        expect(slot('shoutout_ticket')).toBeUndefined();
    });
});

describe('items nothing in the game handles', () => {
    it.each(['mystery_thing', 'shift_booster', 'career_badge'])(
        'refuses %s rather than consuming it for nothing', async itemId => {
            seedUser({ inventory: [{ itemId, quantity: 1 }] });
            seedGuild();

            const interaction = await run(itemId);

            expect(repliedText(interaction)).toContain('Nothing was consumed');
            expect(slot(itemId).quantity).toBe(1);
            expect(mockUsers.writes).toEqual([]);
        });

    it('refuses an unknown item in a guild that has never saved settings', async () => {
        seedUser({ inventory: [{ itemId: 'shoutout_ticket', quantity: 1 }] });
        // No guild row at all: getGuildSettings answers null, which means "no
        // custom shop", not "the read failed".

        const interaction = await run('shoutout_ticket');

        expect(repliedText(interaction)).toContain('Nothing was consumed');
        expect(repliedText(interaction)).not.toContain("Couldn't load");
        expect(slot('shoutout_ticket').quantity).toBe(1);
        expect(mockUsers.writes).toEqual([]);
    });

    it('names a legacy /daily booster as the 2x booster it activates', async () => {
        seedUser({ inventory: [{ itemId: 'coin_booster', quantity: 1 }] });
        seedGuild();

        const pick = makeInteraction({ options: { focused: '' } });
        await use.autocomplete(pick);
        expect(pick.respond.mock.calls[0][0][0].name).toContain('2x Coin Booster');

        const interaction = await run('coin_booster');
        expect(repliedText(interaction)).toMatch(/2x coin/i);
    });

    it('activates the boosters /daily drops under their short ids', async () => {
        seedUser({ inventory: [{ itemId: 'coin_booster', quantity: 1 }] });
        seedGuild();

        const interaction = await run('coin_booster');

        expect(repliedText(interaction)).toContain('Activated: 2x Coin Booster');
        expect(mockUsers.get(USER_ID).activeEffects.map(e => e.type)).toContain('coin_booster_2x');
    });
});

describe('an item /use has nothing to do with', () => {
    it.each([
        ['pet_food', '/pet feed'],
        ['tier_skip_token', '/season tier-skip'],
        ['Whisperwood Charm', 'relic'],
        ['seashell', 'keepsake'],
        ['vip_badge', 'nothing to activate'],
    ])('refuses %s, points somewhere useful, and consumes nothing', async (itemId, hint) => {
        seedUser({ inventory: [{ itemId, quantity: 2 }] });
        seedGuild();

        const interaction = await run(itemId);

        expect(repliedText(interaction)).toContain(hint);
        expect(repliedText(interaction)).toContain('Nothing was consumed');
        expect(slot(itemId).quantity).toBe(2);
        expect(mockUsers.writes).toEqual([]);
    });

    it('names a forged item by its forged name and points at the market', async () => {
        seedUser({ inventory: [{ itemId: 'ai_1787098249128_rg760', quantity: 1 }] });
        seedGuild();

        const interaction = await run('ai_1787098249128_rg760');

        expect(repliedText(interaction)).toContain('🔥 Ember of the Last Oath');
        expect(repliedText(interaction)).toContain('/market list');
        expect(slot('ai_1787098249128_rg760').quantity).toBe(1);
        expect(mockUsers.writes).toEqual([]);
    });
});

describe('what the player typed', () => {
    it('finds an item by its display name', async () => {
        seedUser({ inventory: [{ itemId: 'lucky_charm', quantity: 2 }] });
        seedGuild();

        const interaction = await run('Lucky Charm');

        expect(repliedText(interaction)).toContain('Activated: Lucky Charm');
        expect(slot('lucky_charm').quantity).toBe(1);
    });
});

describe('autocomplete', () => {
    it('offers what the player is holding, with quantities', async () => {
        seedUser({ inventory: [
            { itemId: 'lucky_charm', quantity: 3 },
            { itemId: 'streak_freeze', quantity: 1 },
            { itemId: 'spent_thing', quantity: 0 },
        ] });

        const interaction = makeInteraction({ options: { focused: '' } });
        await use.autocomplete(interaction);

        expect(interaction.respond).toHaveBeenCalledWith([
            { name: '🍀 Lucky Charm — 3 held · lasts 2h', value: 'lucky_charm' },
            { name: '🧊 Streak Freeze — 1 held · 0/2 banked', value: 'streak_freeze' },
        ]);
    });

    it('narrows to what was typed', async () => {
        seedUser({ inventory: [
            { itemId: 'lucky_charm', quantity: 3 },
            { itemId: 'streak_freeze', quantity: 1 },
        ] });

        const interaction = makeInteraction({ options: { focused: 'streak' } });
        await use.autocomplete(interaction);

        expect(interaction.respond).toHaveBeenCalledWith([
            { name: '🧊 Streak Freeze — 1 held · 0/2 banked', value: 'streak_freeze' },
        ]);
    });

    it('matches on the display name as well as the id', async () => {
        seedUser({ inventory: [
            { itemId: 'coin_booster_2x', quantity: 6 },
            { itemId: 'lucky_charm', quantity: 1 },
        ] });

        const interaction = makeInteraction({ options: { focused: '2x coin' } });
        await use.autocomplete(interaction);

        expect(interaction.respond.mock.calls[0][0].map(c => c.value)).toEqual(['coin_booster_2x']);
    });

    it('leaves out what /use has nothing to do with', async () => {
        seedUser({ inventory: [
            { itemId: 'lucky_charm', quantity: 1 },
            { itemId: 'pet_food', quantity: 4 },
            { itemId: 'seashell', quantity: 2 },
            { itemId: 'Whisperwood Charm', quantity: 1 },
            { itemId: 'ai_1787098249128_rg760', quantity: 1 },
            { itemId: 'vip_badge', quantity: 1 },
        ] });

        const interaction = makeInteraction({ options: { focused: '' } });
        await use.autocomplete(interaction);

        expect(interaction.respond.mock.calls[0][0].map(c => c.value)).toEqual(['lucky_charm']);
    });

    it('lists an effect that is already running after the ready ones, saying so', async () => {
        seedUser({
            inventory: [
                { itemId: 'coin_booster_2x', quantity: 1 },
                { itemId: 'xp_booster_2x', quantity: 1 },
            ],
            activeEffects: [{ type: 'coin_booster_2x', expiresAt: new Date(Date.now() + 30 * 60_000), charges: -1 }],
        });

        const interaction = makeInteraction({ options: { focused: '' } });
        await use.autocomplete(interaction);

        const [ready, running] = interaction.respond.mock.calls[0][0];
        expect(ready.value).toBe('xp_booster_2x');
        expect(running.value).toBe('coin_booster_2x');
        expect(running.name).toMatch(/active · \d+m left$/);
    });

    it('marks a role item the member already has as blocked', async () => {
        seedUser({ inventory: [{ itemId: 'vip_pass', quantity: 1 }] });
        seedGuild({ shop: [{ name: 'vip_pass', roleId: 'role-9' }] });

        const interaction = makeInteraction({ options: { focused: '' } });
        interaction.member = { roles: { cache: { has: id => id === 'role-9' } } };
        await use.autocomplete(interaction);

        expect(interaction.respond.mock.calls[0][0][0].name).toContain('you already have the role');
    });

    it('answers with nothing rather than throwing when the lookup fails', async () => {
        mockUsers.model.findOne.mockImplementationOnce(() => { throw new Error('database down'); });

        const interaction = makeInteraction({ options: { focused: '' } });
        await use.autocomplete(interaction);

        expect(interaction.respond).toHaveBeenCalledWith([]);
    });
});

describe('what /daily drops', () => {
    // The drop table once handed out ids no effect was mapped to, so the item
    // could never be activated. Every drop that lands in the bag must be one
    // /use can do something with.
    it('is always something /use can activate', () => {
        const { DROP_TABLE, RARE_DROP_TABLE } = require('../src/data/dailyDropTable');
        const { resolveEffectType } = require('../src/services/effectsService');
        const bagged = [...DROP_TABLE, ...RARE_DROP_TABLE].filter(d => !d.streakFlag);
        for (const drop of bagged) expect([drop.itemId, resolveEffectType(drop.itemId)]).toEqual([drop.itemId, expect.any(String)]);
    });
});
