'use strict';

/**
 * #873, pass 14 — the item and effect surface: `/shop buy`, `/use`, and the
 * event shop's effect purchases.
 *
 * Every earlier pass keyed a credit that read nothing back. This one is the
 * same shape, one layer over. The debits here were sound: a guarded
 * compare-and-set on the balance, the stock or the inventory slot, read back.
 * What followed them was not:
 *
 *   - `/shop buy` handed coins back with bare `$inc`s it never read, under a
 *     reply that said "refunded", and a throw from the stock write or the grant
 *     skipped the refund entirely;
 *   - `/use` consumed the item atomically and then persisted the effect, or the
 *     revived pet, with a `save()` that could fail with the item already spent,
 *     and that wrote the whole array back from a snapshot when it did not;
 *   - `/use` looked a role item's shop entry up by display name, which a
 *     dashboard item's generated id never matches, and lost the item when the
 *     role could not be added;
 *   - the event shop charged for `quantity` copies of an effect that does not
 *     stack.
 *
 * The store evaluates the guards for real (tests/helpers/fakeCollection.js), so
 * a refusal here is a refusal and "one write" means one write.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, inventory: [], activeEffects: [], pets: [], deceasedPets: [], paidPayouts: [], eventCurrency: [],
});
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/itemImageHelper', () => ({
    getItemImageAttachment: jest.fn(async () => null),
    attachItemThumbnail: jest.fn(async () => null),
}));

const { activateEffect } = require('../src/services/effectsService');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const use = require('../src/commands/economy/use');
const shop = require('../src/commands/economy/shop');
const eventshop = require('../src/commands/economy/eventshop');

const GUILD = 'guild-1';
const USER = 'user-1';
const WHO = { userId: USER, guildId: GUILD };
const HOUR = 3_600_000;

const stored = () => mockUsers.get(USER);
const slot = itemId => stored().inventory.find(e => e.itemId === itemId);
const effectsOf = type => stored().activeEffects.filter(e => e.type === type);
const saves = () => [...mockUsers.writes, ...mockGuilds.writes].filter(w => w.op === 'save');

// A test that intercepts a model method swaps its implementation, and neither
// clearAllMocks nor restoreAllMocks puts a plain jest.fn's back — so the real
// ones are kept here and reinstated before every test.
const REAL = {
    userUpdate:  mockUsers.model.findOneAndUpdate.getMockImplementation(),
    guildUpdate: mockGuilds.model.findOneAndUpdate.getMockImplementation(),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockUsers.model.findOneAndUpdate.mockImplementation(REAL.userUpdate);
    mockGuilds.model.findOneAndUpdate.mockImplementation(REAL.guildUpdate);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockGuilds.reset();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

// ── activateEffect ────────────────────────────────────────────────────────────

describe('activateEffect starts an effect in one guarded write', () => {
    test('consumes the item and pushes the effect in the same write', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'lucky_charm', quantity: 2 }] });

        const result = await activateEffect(mockUsers.model, WHO, 'lucky_charm', { consumeItemId: 'lucky_charm' });

        expect(result.status).toBe('activated');
        expect(slot('lucky_charm').quantity).toBe(1);
        expect(effectsOf('lucky_charm')).toHaveLength(1);
        const claim = mockUsers.writes.find(w => w.update?.$push?.activeEffects);
        expect(claim.update.$inc).toEqual({ 'inventory.$[inv].quantity': -1 });
    });

    test('refuses while the effect is live, and consumes nothing', async () => {
        mockUsers.seed({
            ...WHO,
            inventory: [{ itemId: 'lucky_charm', quantity: 2 }],
            activeEffects: [{ type: 'lucky_charm', expiresAt: new Date(Date.now() + HOUR), charges: -1 }],
        });

        const result = await activateEffect(mockUsers.model, WHO, 'lucky_charm', { consumeItemId: 'lucky_charm' });

        expect(result.status).toBe('refused');
        expect(slot('lucky_charm').quantity).toBe(2);
        expect(effectsOf('lucky_charm')).toHaveLength(1);
    });

    test('a second activation racing the first spends one item, not two', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'lucky_charm', quantity: 5 }] });

        const [a, b] = await Promise.all([
            activateEffect(mockUsers.model, WHO, 'lucky_charm', { consumeItemId: 'lucky_charm' }),
            activateEffect(mockUsers.model, WHO, 'lucky_charm', { consumeItemId: 'lucky_charm' }),
        ]);

        expect([a.status, b.status].sort()).toEqual(['activated', 'refused']);
        expect(slot('lucky_charm').quantity).toBe(4);
        expect(effectsOf('lucky_charm')).toHaveLength(1);
    });

    test('replaces an expired or spent entry of the same type', async () => {
        mockUsers.seed({
            ...WHO,
            inventory: [{ itemId: 'padlock', quantity: 1 }],
            activeEffects: [
                { type: 'padlock', expiresAt: null, charges: 0 },
                { type: 'shield', expiresAt: new Date(Date.now() - 1000), charges: -1 },
            ],
        });

        expect((await activateEffect(mockUsers.model, WHO, 'padlock', { consumeItemId: 'padlock' })).status).toBe('activated');
        expect(effectsOf('padlock')).toEqual([expect.objectContaining({ charges: 1 })]);
        // Only this type's stale entries are pruned; the rest is not its business.
        expect(effectsOf('shield')).toHaveLength(1);
    });

    test('refuses when the item is gone, and starts nothing', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'lucky_charm', quantity: 0 }] });

        const result = await activateEffect(mockUsers.model, WHO, 'lucky_charm', { consumeItemId: 'lucky_charm' });

        expect(result.status).toBe('refused');
        expect(effectsOf('lucky_charm')).toHaveLength(0);
    });

    test('an unknown effect type writes nothing', async () => {
        mockUsers.seed({ ...WHO });
        expect((await activateEffect(mockUsers.model, WHO, 'not_an_effect')).status).toBe('unknown');
        expect(mockUsers.writes).toEqual([]);
    });
});

// ── /use ──────────────────────────────────────────────────────────────────────

const runUse = async (item, patch = {}) => {
    const interaction = makeInteraction({ options: { item } });
    Object.assign(interaction, patch);
    await use.execute(interaction);
    return interaction;
};

describe('/use', () => {
    test('an effect item is activated without a save()', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'lucky_charm', quantity: 1 }] });
        mockGuilds.seed({ guildId: GUILD });

        const interaction = await runUse('lucky_charm');

        expect(repliedText(interaction)).toContain('Activated: Lucky Charm');
        expect(effectsOf('lucky_charm')).toHaveLength(1);
        expect(slot('lucky_charm')).toBeUndefined();
        expect(saves()).toEqual([]);
    });

    test('the revive scroll brings the pet back in the write that spends it', async () => {
        mockUsers.seed({
            ...WHO,
            inventory: [{ itemId: 'revive_scroll', quantity: 1 }],
            deceasedPets: [{ _id: 'dead-1', petId: 'cat', name: 'Mittens', level: 4 }],
            pets: [], petSlots: 0,
        });
        mockGuilds.seed({ guildId: GUILD });

        const interaction = await runUse('revive_scroll');

        expect(repliedText(interaction)).toContain('Mittens Returns');
        expect(stored().pets).toEqual([expect.objectContaining({ petId: 'cat', level: 4, hunger: 50 })]);
        expect(stored().deceasedPets).toEqual([]);
        expect(saves()).toEqual([]);
        const revive = mockUsers.writes.find(w => w.update?.$push?.pets);
        expect(revive.update.$pull).toEqual({ deceasedPets: { _id: 'dead-1' } });
        expect(revive.update.$inc).toEqual({ 'inventory.$[inv].quantity': -1 });
        // The "no second copy" check rides the write, not just the read.
        expect(revive.query['pets.petId']).toEqual({ $ne: 'cat' });
    });

    test('a role item made in the dashboard is found by its generated id', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'item_abc123', quantity: 1 }] });
        mockGuilds.seed({ guildId: GUILD, shop: [{ name: 'VIP Pass', itemId: 'item_abc123', roleId: 'role-9' }] });

        const add = jest.fn().mockResolvedValue(undefined);
        const interaction = makeInteraction({ options: { item: 'item_abc123' } });
        interaction.guild.members.fetch = jest.fn().mockResolvedValue({ roles: { cache: { has: () => false }, add } });
        await use.execute(interaction);

        expect(add).toHaveBeenCalledWith('role-9', expect.stringContaining('VIP Pass'));
        expect(repliedText(interaction)).toContain('Used: VIP Pass');
    });

    test('a role that cannot be added gives the item back', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'item_abc123', quantity: 1 }] });
        mockGuilds.seed({ guildId: GUILD, shop: [{ name: 'VIP Pass', itemId: 'item_abc123', roleId: 'role-9' }] });

        const add = jest.fn().mockRejectedValue(new Error('Missing Permissions'));
        const interaction = makeInteraction({ options: { item: 'item_abc123' } });
        interaction.guild.members.fetch = jest.fn().mockResolvedValue({ roles: { cache: { has: () => false }, add } });
        await use.execute(interaction);

        expect(slot('item_abc123').quantity).toBe(1);
        expect(stored().paidPayouts.some(p => p.key === `use:${interaction.id}:role-refund`)).toBe(true);
        expect(repliedText(interaction)).toContain('was returned');
    });

    test('a restore that will not land is recorded as owed, and says so', async () => {
        mockUsers.seed({ ...WHO, inventory: [{ itemId: 'item_abc123', quantity: 1 }] });
        mockGuilds.seed({ guildId: GUILD, shop: [{ name: 'VIP Pass', itemId: 'item_abc123', roleId: 'role-9' }] });

        const interaction = makeInteraction({ options: { item: 'item_abc123' } });
        // The document is gone by the time the item is returned: after the
        // spend, when the role is refused.
        const add = jest.fn().mockImplementation(async () => { mockUsers.reset(); throw new Error('nope'); });
        interaction.guild.members.fetch = jest.fn().mockResolvedValue({ roles: { cache: { has: () => false }, add } });
        await use.execute(interaction);

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ kind: 'items', itemId: 'item_abc123', payoutKey: `use:${interaction.id}:role-refund` }),
        }));
        expect(repliedText(interaction)).toContain('recorded as owed');
    });
});

// ── /shop buy ─────────────────────────────────────────────────────────────────

const ITEM = { _id: 'shop-1', name: 'Party Hat', itemId: 'item_hat', price: 100, stock: 5 };

function seedShop({ balance = 1000, item = ITEM } = {}) {
    mockUsers.seed({ ...WHO, balance });
    mockGuilds.seed({ guildId: GUILD, name: 'Guild', economy: { currency: '💰' }, shop: [{ ...item }] });
}

const shelf = () => mockGuilds.get(GUILD).shop.find(i => i._id === ITEM._id);

async function runBuy(quantity = 1, patch = {}) {
    const interaction = makeInteraction({ subcommand: 'buy', options: { item: ITEM.name, quantity } });
    Object.assign(interaction, patch);
    await shop.execute(interaction);
    return interaction;
}

/** Make the next Guild update that touches `field` misbehave, leaving the rest alone. */
function interceptGuildUpdate(field, behaviour) {
    const real = REAL.guildUpdate;
    mockGuilds.model.findOneAndUpdate.mockImplementation(async (query, update, options) => {
        if (update?.$inc?.[field] !== undefined) return behaviour();
        return real(query, update, options);
    });
}

describe('/shop buy', () => {
    test('the item is granted under the purchase key, and the charge stands', async () => {
        seedShop();

        const interaction = await runBuy(2);

        expect(stored().balance).toBe(800);
        expect(slot('item_hat').quantity).toBe(2);
        expect(shelf().stock).toBe(3);
        expect(stored().paidPayouts.some(p => p.key === `servershop:${interaction.id}:grant`)).toBe(true);
        expect(JSON.stringify(interaction.replies)).toContain('Purchase Successful');
    });

    test('a sell-out race refunds through the keyed credit', async () => {
        seedShop();
        interceptGuildUpdate('shop.$.stock', async () => null);

        const interaction = await runBuy(1);

        expect(stored().balance).toBe(1000);
        expect(slot('item_hat')).toBeUndefined();
        expect(stored().paidPayouts.some(p => p.key === `servershop:${interaction.id}:refund`)).toBe(true);
        expect(repliedText(interaction)).toContain('just sold out — your coins were refunded');
    });

    test('a stock write that throws still refunds the charge', async () => {
        seedShop();
        interceptGuildUpdate('shop.$.stock', async () => { throw new Error('connection reset'); });

        const interaction = await runBuy(1);

        expect(stored().balance).toBe(1000);
        expect(repliedText(interaction)).toContain('your coins were refunded');
    });

    test('a grant that will not land is owed, not refunded', async () => {
        seedShop();
        // The document disappears after the charge, so the grant has nothing to
        // land on and is recorded for payouts:replay.
        const realUpdate = REAL.userUpdate;
        mockUsers.model.findOneAndUpdate.mockImplementation(async (q, u, o) => {
            const result = await realUpdate(q, u, o);
            if (u?.$inc?.balance < 0) mockUsers.reset();
            return result;
        });

        const interaction = await runBuy(1);

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ kind: 'items', itemId: 'item_hat', payoutKey: `servershop:${interaction.id}:grant` }),
        }));
        expect(repliedText(interaction)).toContain('recorded as owed');
        // One unwind, not two: the item is owed, so the coins are not also returned.
        expect(recordOwedPayout).toHaveBeenCalledTimes(1);
        expect(shelf().stock).toBe(4);
    });

    test('a grant neither landed nor recorded refunds, and puts the stock back', async () => {
        seedShop();
        recordOwedPayout.mockResolvedValue(false);
        const inventoryGrant = require('../src/utils/inventoryGrant');
        jest.spyOn(inventoryGrant, 'grantInventoryItem').mockRejectedValue(new Error('write concern timeout'));

        const interaction = await runBuy(1);

        expect(stored().balance).toBe(1000);
        expect(shelf().stock).toBe(5);
        expect(repliedText(interaction)).toContain('Purchase failed — your coins were refunded');
    });

    test('a role that cannot be added is not reported as granted', async () => {
        seedShop({ item: { ...ITEM, roleId: 'role-7' } });

        const interaction = await runBuy(1, {
            member: { id: USER, roles: { add: jest.fn().mockRejectedValue(new Error('Missing Permissions')) } },
        });

        const shown = JSON.stringify(interaction.replies);
        expect(shown).not.toContain('Role Granted');
        expect(shown).toContain('Role Not Granted Yet');
        expect(shown).toContain('/use item_hat');
        expect(slot('item_hat').quantity).toBe(1);
    });
});

// ── /eventshop effect purchases ───────────────────────────────────────────────

function seedEvent({ snowflakes = 500, effects = [] } = {}) {
    mockUsers.seed({ ...WHO, eventCurrency: [{ currencyId: 'snowflakes', amount: snowflakes }], activeEffects: effects });
    mockGuilds.seed({
        guildId: GUILD,
        activeEvent: {
            type: 'winter_wonderland',
            endsAt: new Date(Date.now() + 24 * HOUR),
            eventShop: [{ itemId: 'coin_booster_2x', name: '2x Coin Booster', cost: 80, stock: -1 }],
        },
    });
}

async function runEventBuy(quantity) {
    const interaction = makeInteraction({ subcommand: 'buy', options: { item: 'coin_booster_2x', quantity } });
    await eventshop.execute(interaction);
    return interaction;
}

const snowflakes = () => stored().eventCurrency.find(e => e.currencyId === 'snowflakes').amount;

describe('/eventshop effect items', () => {
    test('are sold one at a time, refused before anything is charged', async () => {
        seedEvent();

        const interaction = await runEventBuy(3);

        expect(repliedText(interaction)).toContain('one at a time');
        expect(snowflakes()).toBe(500);
        expect(mockUsers.writes).toEqual([]);
    });

    test('are refused while the same effect is running', async () => {
        seedEvent({ effects: [{ type: 'coin_booster_2x', expiresAt: new Date(Date.now() + HOUR), charges: -1 }] });

        const interaction = await runEventBuy(1);

        expect(repliedText(interaction)).toContain('already active');
        expect(snowflakes()).toBe(500);
    });

    test('start the effect without a save()', async () => {
        seedEvent();

        const interaction = await runEventBuy(1);

        expect(JSON.stringify(interaction.replies)).toContain('Purchase Successful');
        expect(snowflakes()).toBe(420);
        expect(effectsOf('coin_booster_2x')).toHaveLength(1);
        expect(saves()).toEqual([]);
    });
});

describe('/eventshop charges the currency it names', () => {
    test("another event's currency cannot cover a purchase racing past the balance check", async () => {
        // 100 snowflakes pays for one 80-snowflake box, not two. The old guard's
        // two dotted conditions could each match a different entry, so the 500
        // leftover candy satisfied `amount >= 80` for the second purchase.
        mockUsers.seed({
            ...WHO,
            eventCurrency: [{ currencyId: 'snowflakes', amount: 100 }, { currencyId: 'candy', amount: 500 }],
        });
        mockGuilds.seed({
            guildId: GUILD,
            activeEvent: {
                type: 'winter_wonderland',
                endsAt: new Date(Date.now() + 24 * HOUR),
                eventShop: [{ itemId: 'winter_loot_box', name: 'Winter Loot Box', cost: 80, stock: -1 }],
            },
        });

        const buy = () => {
            const interaction = makeInteraction({ subcommand: 'buy', options: { item: 'winter_loot_box', quantity: 1 } });
            return eventshop.execute(interaction).then(() => interaction);
        };
        const [a, b] = await Promise.all([buy(), buy()]);

        const balances = Object.fromEntries(stored().eventCurrency.map(e => [e.currencyId, e.amount]));
        expect(balances).toEqual({ snowflakes: 20, candy: 500 });
        expect(slot('winter_loot_box').quantity).toBe(1);
        const texts = [JSON.stringify(a.replies), JSON.stringify(b.replies)];
        expect(texts.filter(t => t.includes('Purchase Successful'))).toHaveLength(1);
    });
});
