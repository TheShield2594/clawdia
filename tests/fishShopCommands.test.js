'use strict';

// `/fish shop` driven end to end: the dispatch, the browse pages, bait and
// consumable purchases, `use`, and location unlocks (#998).
//
// The folder measured 0.4% of branches — its files were required by other
// suites and never run. This drives the real handlers through `handleShop`
// against stores that evaluate the guarded writes they issue (the
// `balance: { $gte }` debit, the stack-cap `$expr` on the grant, the keyed
// refund pipeline), so a refusal and a success are told apart by what the
// store holds afterwards, not by which mock was called.
//
// The rod, upgrade and repair flows are in fishShopCommandsGear.test.js.

const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');
const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });
const mockProfiles = fakeCollection('GrindProfile', {}, { unique: ['userId', 'guildId', 'system'] });

// Failure switches the model mocks read, reset before every test.
//   grant      'before' | 'after' — GrindProfile.findOneAndUpdate throws without
//              committing, or commits and then loses its response
//   grindSave  'before' | 'after' — the same for a profile save
//   grindRead  GrindProfile.findOne rejects (the grant can't be read back)
//   userSave   a loaded User document's save rejects
//   credit     the keyed refund credit (a pipeline update) throws
//   debitNull  the guarded balance debit matches nothing
//   rollback   GrindProfile.updateOne (an unlock's rollback) throws
const mockFail = {};

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/utils/itemImageHelper', () => ({
    attachItemThumbnail: jest.fn(async () => []),
    getItemImageAttachment: jest.fn(async () => null),
}));
jest.mock('../src/utils/shopBrowse', () => ({ runShopBrowse: jest.fn(async () => {}) }));

jest.mock('../src/models/User', () => {
    const failingSave = doc => {
        if (doc && mockFail.userSave) doc.save = jest.fn(async () => { throw new Error('user save down'); });
        return doc;
    };
    return {
        ...mockUsers.model,
        findOne: jest.fn((...args) => {
            const query = mockUsers.model.findOne(...args);
            return { ...query, then: (res, rej) => query.then(failingSave).then(res, rej) };
        }),
        findOneAndUpdate: jest.fn(async (query, update, options = {}) => {
            if (mockFail.credit && options.updatePipeline) throw new Error('credit down');
            if (mockFail.debitNull && query.balance?.$gte !== undefined) return null;
            return failingSave(await mockUsers.model.findOneAndUpdate(query, update, options));
        }),
    };
});

jest.mock('../src/models/GrindProfile', () => {
    const clone = v => JSON.parse(JSON.stringify(v));
    const stored = self => mockProfiles.all().find(p =>
        p.userId === self.userId && p.guildId === self.guildId && p.system === self.system);
    const guardSave = async (commit) => {
        if (mockFail.grindSave === 'before') throw new Error('profile save down');
        const out = await commit();
        if (mockFail.grindSave === 'after') throw new Error('profile save response lost');
        return out;
    };

    function GrindProfile(fields) { Object.assign(this, fields); this.isNew = true; }
    GrindProfile.prototype.markModified = function () {};
    GrindProfile.prototype.save = function () {
        return guardSave(async () => {
            const { isNew, ...fields } = this;
            const existing = stored(this);
            if (existing) Object.assign(existing, clone(fields));
            else mockProfiles.seed(clone(fields));
            this.isNew = false;
            return this;
        });
    };

    GrindProfile.find = jest.fn(async query => (await mockProfiles.model.find(query)).map(doc => {
        const save = doc.save;
        doc.save = () => guardSave(() => save());
        return doc;
    }));
    GrindProfile.findOne = jest.fn((...args) => (mockFail.grindRead
        ? { lean: async () => { throw new Error('profile read down'); } }
        : mockProfiles.model.findOne(...args)));
    GrindProfile.findOneAndUpdate = jest.fn(async (...args) => {
        if (mockFail.grant === 'before') throw new Error('grant down');
        const result = await mockProfiles.model.findOneAndUpdate(...args);
        if (mockFail.grant === 'after') throw new Error('grant response lost');
        return result;
    });
    GrindProfile.updateOne = jest.fn(async (...args) => {
        if (mockFail.rollback) throw new Error('rollback down');
        return mockProfiles.model.updateOne(...args);
    });
    return GrindProfile;
});

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { runShopBrowse } = require('../src/utils/shopBrowse');
const { handleShop } = require('../src/commands/economy/fish/shop');
const { buildFishShopPages } = require('../src/commands/economy/fish/shop/list');
const { BAIT_PACKS, CONSUMABLES, LOCATIONS, LOCATION_LIST } = require('../src/data/fishData');

const USER = 'user-1';
const GUILD = 'guild-1';
const GRANT_KEY = 'shop:interaction-1:grant';
const REFUND_KEY = 'shop:interaction-1:refund';

/** A player with a stored wallet and fishing profile. */
function seedPlayer({ balance = 10_000, fishing = {} } = {}) {
    mockUsers.seed({ userId: USER, guildId: GUILD, balance, paidPayouts: [] });
    mockProfiles.seed({
        userId: USER, guildId: GUILD, system: 'fishing',
        data: {
            level: 1, unlockedLocations: ['pond'], activeLocation: 'pond',
            rods: [], equippedRodIndex: -1, bait: {}, consumables: {},
            ...fishing,
        },
    });
}

const balance = () => mockUsers.get(USER)?.balance;
const profile = () => mockProfiles.all().find(p => p.userId === USER && p.system === 'fishing');
const fishing = () => profile()?.data;

/** Lets presses delivered on the next tick, and everything they await, finish. */
async function settle() {
    for (let i = 0; i < 25; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Runs `/fish shop <sub>`, then waits out any confirmation it opened. */
async function run(sub, { options = {}, components = [], between, prepare } = {}) {
    const interaction = makeInteraction({ subcommand: sub, options, components });
    if (prepare) prepare(interaction);
    await handleShop(interaction, sub);
    // Anything the store should look like by the time the button is pressed,
    // which is after the prompt was drawn from the old state.
    if (between) between();
    await settle();
    return interaction;
}

const confirm = customId => [{ customId }];
/** Makes every editReply reject, as it does once the interaction token has expired. */
const expiredToken = interaction => { interaction.editReply = jest.fn(async () => { throw new Error('Unknown interaction'); }); };
const packName = id => BAIT_PACKS.find(p => p.id === id).name;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockProfiles.reset();
    for (const key of Object.keys(mockFail)) delete mockFail[key];
    recordOwedPayout.mockResolvedValue(true);
    Guild.findOne.mockResolvedValue({ economy: { enabled: true, currency: '🪙' } });
});

afterEach(() => jest.restoreAllMocks());

describe('the shop dispatch', () => {
    test('a server with the economy off is refused before the player is read', async () => {
        Guild.findOne.mockResolvedValue({ economy: { enabled: false } });
        const interaction = await run('list');
        expect(repliedText(interaction)).toContain('economy is disabled');
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a server with no settings uses the default currency', async () => {
        Guild.findOne.mockResolvedValue(null);
        seedPlayer({ balance: 10, fishing: { level: 10 } });
        const interaction = await run('unlock', { options: { location: 'river' } });
        expect(repliedText(interaction)).toContain('costs **💰2,500**');
    });

    test('a player with no document yet is created on the way in', async () => {
        const interaction = await run('unlock', { options: { location: 'river' } });
        expect(mockUsers.get(USER)).toMatchObject({ userId: USER, guildId: GUILD, balance: 0 });
        expect(repliedText(interaction)).toContain('You are Level **1**');
    });

    test('an unknown subcommand renders nothing', async () => {
        seedPlayer();
        const interaction = makeInteraction();
        await expect(handleShop(interaction, 'nonsense')).resolves.toBeUndefined();
        expect(interaction.replies).toHaveLength(0);
    });
});

describe('shop list', () => {
    test('hands the five browse pages to the shared browser', async () => {
        seedPlayer({ fishing: { level: 12, unlockedLocations: ['pond', 'river'], activeLocation: 'river' } });
        await run('list');

        expect(runShopBrowse).toHaveBeenCalledTimes(1);
        const [, config] = runShopBrowse.mock.calls[0];
        expect(config).toMatchObject({ activity: 'fish', title: 'Fishing Shop', currency: '🪙', guildId: GUILD });
        expect(config.pages.map(p => p.id)).toEqual(['rods', 'upgrades', 'bait', 'consumables', 'locations']);
    });

    test('location entries read active, owned or locked with their price', () => {
        const pages = buildFishShopPages({
            fishing: { unlockedLocations: ['pond', 'river'], activeLocation: 'river' },
        }, '🪙');
        const locations = pages.find(p => p.id === 'locations');
        const byName = Object.fromEntries(locations.items.map(i => [i.name, i]));

        expect(byName[LOCATIONS.river.name]).toMatchObject({ badge: 'ACTIVE', subline: 'Currently fishing' });
        expect(byName[LOCATIONS.pond.name]).toMatchObject({ badge: 'OWNED', subline: 'Unlocked' });
        expect(byName[LOCATIONS.lake.name]).toMatchObject({ badge: 'Lv.20', subline: '🪙10,000' });

        expect(locations.listText).toContain(`**${LOCATIONS.river.name}** — ✅ **ACTIVE**`);
        expect(locations.listText).toContain(`**${LOCATIONS.pond.name}** — ✅ Unlocked`);
        expect(locations.listText).toContain(`**${LOCATIONS.lake.name}** — 🔒 Lv.20 / 🪙10,000`);
        expect(locations.items).toHaveLength(LOCATION_LIST.length);
    });

    test('rods, upgrades, bait and consumables list their commands; only bait and consumables are click-to-buy', () => {
        const pages = buildFishShopPages({ fishing: { unlockedLocations: ['pond'], activeLocation: 'pond' } }, '🪙');
        const page = id => pages.find(p => p.id === id);

        expect(page('rods').listText).toContain('`/fish shop rod type:bamboo_rod`');
        expect(page('rods').items[0]).toMatchObject({ badge: 'T1', price: 500 });
        expect(page('upgrades').listText).toContain('`/fish shop upgrade type:enhanced_line`');
        expect(page('upgrades').items[0].subline).toBe('~30% of rod');
        expect(page('bait').listText).toContain('`/fish shop buy item:worm_bait_pack`');
        expect(page('bait').items[0]).toMatchObject({ buyId: 'worm_bait_pack', price: 70 });
        // Hunter's Brew is crafted, not sold: it has no price (#873).
        expect(page('consumables').items.map(i => i.buyId))
            .toEqual(Object.keys(CONSUMABLES).filter(id => id !== 'hunters_brew'));

        expect(typeof page('bait').onBuy).toBe('function');
        expect(typeof page('consumables').onBuy).toBe('function');
        expect(page('rods').onBuy).toBeUndefined();
        expect(page('locations').onBuy).toBeUndefined();
    });

    test('a buy from the browse select runs the real purchase for the chosen item', async () => {
        seedPlayer({ balance: 1_000 });
        await run('list');
        const [, config] = runShopBrowse.mock.calls[0];
        const bait = config.pages.find(p => p.id === 'bait');

        const btn = makeInteraction({ components: confirm('fishbuy_confirm') });
        await bait.onBuy(btn, 'worm_bait_pack');
        await settle();

        expect(repliedText(btn)).toContain(`Bought **1× ${packName('worm_bait_pack')}**`);
        expect(balance()).toBe(930);
        expect(fishing().bait.worm_bait).toBe(20);
    });
});

describe('shop buy — refusals', () => {
    test('an unknown item', async () => {
        seedPlayer();
        const interaction = await run('buy', { options: { item: 'dynamite' } });
        expect(repliedText(interaction)).toBe('Unknown item.');
    });

    // It has no cost, so its total was NaN — and `balance < NaN` is never true,
    // so the purchase went ahead to a `$gte: NaN` debit (#873).
    test('refuses the crafted-only Hunter\'s Brew rather than pricing it at NaN', async () => {
        seedPlayer();
        const interaction = await run('buy', { options: { item: 'hunters_brew' } });
        expect(repliedText(interaction)).toBe('Unknown item.');
        expect(repliedText(interaction)).not.toContain('NaN');
    });

    test('not enough coins for the quantity asked', async () => {
        seedPlayer({ balance: 100 });
        const interaction = await run('buy', { options: { item: 'shrimp_bait_pack', quantity: 2 } });
        expect(repliedText(interaction)).toBe(
            `You need **🪙280** for 2× **${packName('shrimp_bait_pack')}**. You have **🪙100**.`);
        expect(balance()).toBe(100);
    });

    test('bait that would carry past 200', async () => {
        seedPlayer({ fishing: { bait: { worm_bait: 190 } } });
        const interaction = await run('buy', { options: { item: 'worm_bait_pack' } });
        expect(repliedText(interaction)).toContain("can't carry more than 200");
    });

    test('a consumable past its stack size', async () => {
        seedPlayer({ fishing: { consumables: { repair_kit_small: 4 } } });
        const interaction = await run('buy', { options: { item: 'repair_kit_small', quantity: 2 } });
        expect(repliedText(interaction)).toBe('You can only carry 5 **Repair Kit (Small)** at a time.');
    });
});

describe('shop buy — the confirmation', () => {
    test('shows what is being bought and what the player has', async () => {
        seedPlayer({ fishing: { bait: { lure: 20 } } });
        const interaction = await run('buy', { options: { item: 'lure_pack', quantity: 3 } });
        const embed = interaction.replies[0].embeds[0].data;
        const field = name => embed.fields.find(f => f.name === name).value;
        expect(embed.title).toContain('Confirm Purchase');
        expect(field('Quantity')).toBe('60 lure');
        expect(field('Total Cost')).toBe('🪙630');
        expect(field('Currently')).toBe('20 in stock');
    });

    test('a consumable prompt shows its stack against the cap', async () => {
        seedPlayer({ fishing: { consumables: { chum_bait: 2 } } });
        const interaction = await run('buy', { options: { item: 'chum_bait' } });
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.fields.find(f => f.name === 'Quantity').value).toBe('1× Chum Bait');
        expect(embed.fields.find(f => f.name === 'Currently').value).toBe('2/10 in stock');
    });

    test('left alone, it times out and nothing is charged', async () => {
        seedPlayer();
        const interaction = await run('buy', { options: { item: 'worm_bait_pack' } });
        expect(repliedText(interaction)).toContain('Purchase timed out.');
        expect(balance()).toBe(10_000);
    });

    test('a timeout whose edit fails is swallowed', async () => {
        seedPlayer();
        const interaction = await run('buy', { options: { item: 'worm_bait_pack' }, prepare: expiredToken });
        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Purchase timed out.' }));
        expect(balance()).toBe(10_000);
    });

    test('cancel leaves the wallet and the bag alone', async () => {
        seedPlayer();
        const interaction = await run('buy', { options: { item: 'worm_bait_pack' }, components: confirm('fishbuy_cancel') });
        expect(repliedText(interaction)).toContain('Purchase cancelled.');
        expect(repliedText(interaction)).not.toContain('timed out');
        expect(balance()).toBe(10_000);
        expect(fishing().bait.worm_bait).toBeUndefined();
    });

    test('somebody else pressing Buy is turned away and buys nothing', async () => {
        seedPlayer();
        const interaction = await run('buy', {
            options: { item: 'worm_bait_pack' },
            components: [{ customId: 'fishbuy_confirm', user: 'user-2' }],
        });
        expect(repliedText(interaction)).toContain('This is not your confirmation.');
        expect(repliedText(interaction)).toContain('Purchase timed out.');
        expect(balance()).toBe(10_000);
    });
});

describe('shop buy — bait', () => {
    const buy = (opts = {}) => run('buy', {
        options: { item: 'worm_bait_pack', quantity: 2 }, components: confirm('fishbuy_confirm'), ...opts,
    });

    test('charges once, grants the bait and stamps the purchase key in the same write', async () => {
        seedPlayer({ fishing: { bait: { worm_bait: 10 } } });
        const interaction = await buy();

        expect(balance()).toBe(10_000 - 140);
        expect(fishing().bait.worm_bait).toBe(50);
        expect(profile().grantKeys.map(k => k.key)).toEqual([GRANT_KEY]);

        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.description).toBe(`Bought **2× ${packName('worm_bait_pack')}** (+40 worm bait).`);
        expect(embed.fields.find(f => f.name === 'Balance').value).toBe('🪙9,860');
        expect(embed.fields.find(f => f.name === 'Stock').value).toBe('50 worm bait');
    });

    // #873. The result replies were returned without being awaited, so one that
    // failed (an expired token) escaped the collector's try as an unhandled
    // rejection instead of reaching its catch.
    test('a result reply that fails is caught and logged, and the purchase stands', async () => {
        seedPlayer({ fishing: { bait: { worm_bait: 10 } } });
        const escaped = [];
        const onUnhandled = reason => escaped.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            await buy({ prepare: expiredToken });
            await settle();
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }

        expect(escaped).toEqual([]);
        expect(console.error).toHaveBeenCalledWith('[fishshop buy] purchase error:', expect.any(Error));
        expect(balance()).toBe(10_000 - 140);
        expect(fishing().bait.worm_bait).toBe(50);
    });

    test('a player who has never fished gets a profile written before the grant', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 500, paidPayouts: [] });
        const interaction = await buy({ options: { item: 'worm_bait_pack' } });
        expect(repliedText(interaction)).toContain(`Bought **1× ${packName('worm_bait_pack')}**`);
        expect(balance()).toBe(430);
        expect(fishing().bait.worm_bait).toBe(20);
    });

    test('a wallet emptied since the prompt is not charged', async () => {
        seedPlayer();
        const interaction = await buy({ between: () => { mockUsers.get(USER).balance = 50; } });
        expect(repliedText(interaction)).toContain('Purchase failed. Conditions may have changed');
        expect(balance()).toBe(50);
        expect(fishing().bait.worm_bait).toBeUndefined();
    });

    test('a stack filled since the prompt is refunded under its key', async () => {
        seedPlayer({ fishing: { bait: { worm_bait: 100 } } });
        const interaction = await buy({ between: () => { fishing().bait.worm_bait = 190; } });

        expect(repliedText(interaction)).toContain('Purchase failed — your coins were refunded.');
        expect(balance()).toBe(10_000);
        expect(mockUsers.get(USER).paidPayouts.map(p => p.key)).toContain(REFUND_KEY);
        expect(fishing().bait.worm_bait).toBe(190);
    });

    test('a grant that threw without landing is refunded', async () => {
        seedPlayer();
        mockFail.grant = 'before';
        const interaction = await buy();
        expect(repliedText(interaction)).toContain('your coins were refunded');
        expect(balance()).toBe(10_000);
        expect(fishing().bait.worm_bait).toBeUndefined();
    });

    test('a grant that landed but lost its response is kept, not refunded', async () => {
        seedPlayer();
        mockFail.grant = 'after';
        const interaction = await buy();
        expect(repliedText(interaction)).toContain(`Bought **2× ${packName('worm_bait_pack')}**`);
        expect(balance()).toBe(10_000 - 140);
        expect(fishing().bait.worm_bait).toBe(40);
        // The profile write's result was lost, so the reply falls back to the
        // in-memory count plus what was added.
        expect(interaction.replies.at(-1).embeds[0].data.fields.find(f => f.name === 'Stock').value)
            .toBe('40 worm bait');
    });

    test('a grant whose outcome cannot be read back is left for an admin, not refunded', async () => {
        seedPlayer();
        mockFail.grant = 'before';
        mockFail.grindRead = true;
        const interaction = await buy();
        expect(repliedText(interaction)).toContain('outcome could not be confirmed');
        expect(repliedText(interaction)).toContain('**not** been refunded');
        expect(balance()).toBe(10_000 - 140);
    });

    test('a refund that will not land is recorded as owed and said so', async () => {
        seedPlayer();
        mockFail.grant = 'before';
        mockFail.credit = true;
        const interaction = await buy();
        expect(repliedText(interaction)).toContain('the 🪙140 charged could not be returned automatically');
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({ service: 'fish', jobName: 'shopRefund' }));
        expect(balance()).toBe(10_000 - 140);
    });

    test('a refund that can be neither paid nor recorded points at an admin', async () => {
        seedPlayer();
        mockFail.grant = 'before';
        mockFail.credit = true;
        recordOwedPayout.mockResolvedValue(false);
        const interaction = await buy();
        expect(repliedText(interaction)).toContain('could not be returned or recorded — please contact a server admin');
    });

    test('a failure outside the grant gets the generic apology', async () => {
        // A new player's profile is written first; that write failing throws
        // before any coins move.
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 500, paidPayouts: [] });
        mockFail.grindSave = 'before';
        const interaction = await buy({ options: { item: 'worm_bait_pack' } });
        expect(repliedText(interaction)).toContain('Something went wrong. Please try again.');
        expect(balance()).toBe(500);
    });
});

describe('shop buy — consumables', () => {
    const buy = (opts = {}) => run('buy', {
        options: { item: 'anglers_luck', quantity: 3 }, components: confirm('fishbuy_confirm'), ...opts,
    });

    test('charges once and adds to the stack', async () => {
        seedPlayer({ fishing: { consumables: { anglers_luck: 2 } } });
        const interaction = await buy();

        expect(balance()).toBe(10_000 - 165);
        expect(fishing().consumables.anglers_luck).toBe(5);
        expect(profile().grantKeys.map(k => k.key)).toEqual([GRANT_KEY]);

        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.description).toBe("Bought **3× Angler's Luck**.");
        expect(embed.fields.find(f => f.name === 'Stock').value).toBe('5 owned');
        expect(embed.footer.text).toBe('Use /fish shop use anglers_luck to activate it');
    });

    test('a wallet emptied since the prompt is not charged', async () => {
        seedPlayer();
        const interaction = await buy({ between: () => { mockUsers.get(USER).balance = 10; } });
        expect(repliedText(interaction)).toContain('Purchase failed. Conditions may have changed');
        expect(fishing().consumables.anglers_luck).toBeUndefined();
    });

    test('a stack filled since the prompt is refunded', async () => {
        seedPlayer();
        const interaction = await buy({ between: () => { fishing().consumables.anglers_luck = 9; } });
        expect(repliedText(interaction)).toContain('your coins were refunded');
        expect(balance()).toBe(10_000);
        expect(fishing().consumables.anglers_luck).toBe(9);
    });

    test('a grant that landed but lost its response is kept', async () => {
        seedPlayer();
        mockFail.grant = 'after';
        const interaction = await buy();
        expect(repliedText(interaction)).toContain("Bought **3× Angler's Luck**");
        expect(fishing().consumables.anglers_luck).toBe(3);
        expect(balance()).toBe(10_000 - 165);
    });

    test('a grant whose outcome cannot be read back is not refunded', async () => {
        seedPlayer();
        mockFail.grant = 'before';
        mockFail.grindRead = true;
        const interaction = await buy();
        expect(repliedText(interaction)).toContain('outcome could not be confirmed');
        expect(balance()).toBe(10_000 - 165);
    });

    test('a refund that will not land is recorded as owed', async () => {
        seedPlayer();
        mockFail.grant = 'before';
        mockFail.credit = true;
        const interaction = await buy();
        expect(repliedText(interaction)).toContain('recorded as owed');
    });
});

describe('shop use', () => {
    test('an unknown consumable', async () => {
        seedPlayer();
        const interaction = await run('use', { options: { item: 'nope' } });
        expect(repliedText(interaction)).toBe('Unknown consumable.');
    });

    test('one the player has none of', async () => {
        seedPlayer();
        const interaction = await run('use', { options: { item: 'chum_bait' } });
        expect(repliedText(interaction)).toBe("You don't have any **Chum Bait**.");
    });

    test('bait is activated, taken from the bag and listed as a buff', async () => {
        seedPlayer({ fishing: { consumables: { chum_bait: 2 } } });
        const interaction = await run('use', { options: { item: 'chum_bait' } });

        expect(fishing()).toMatchObject({ activeBait: 'chum_bait', activeBaitCastsLeft: 3 });
        expect(fishing().consumables.chum_bait).toBe(1);
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toBe(`${CONSUMABLES.chum_bait.emoji} Chum Bait Activated!`);
        expect(embed.fields[0].value).toBe('🐟 chum bait active (3 casts left)');
    });

    test('every queued buff is listed', async () => {
        seedPlayer({ fishing: { consumables: { anglers_luck: 1 }, activeXpScroll: true } });
        const interaction = await run('use', { options: { item: 'anglers_luck' } });
        expect(fishing().activeLuck).toBe(true);
        expect(interaction.replies[0].embeds[0].data.fields[0].value)
            .toBe("🍀 Angler's Luck queued for next cast\n📜 XP Scroll queued for next cast");
    });

    test('a stamina item leaves no buff to list', async () => {
        seedPlayer({ fishing: { consumables: { energy_drink: 1 }, stamina: 0, staminaLastRegen: new Date() } });
        const interaction = await run('use', { options: { item: 'energy_drink' } });
        expect(fishing().stamina).toBe(3);
        expect(fishing().consumables.energy_drink).toBe(0);
        expect(interaction.replies[0].embeds[0].data.fields[0].value).toBe('None');
    });

    test('a cross-system item with no fishing entry still renders', async () => {
        seedPlayer({ fishing: { consumables: { predators_eye: 1 } } });
        const interaction = await run('use', { options: { item: 'predators_eye' } });
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toBe('✅ predators_eye Activated!');
        expect(embed.description).toBe('*Effect applied.*');
        expect(fishing().activeBait).toBe('predators_eye');
    });

    test('a save that fails says so', async () => {
        seedPlayer({ fishing: { consumables: { fish_xp_scroll: 1 } } });
        mockFail.userSave = true;
        const interaction = await run('use', { options: { item: 'fish_xp_scroll' } });
        expect(repliedText(interaction)).toBe('Something went wrong. Please try again.');
        expect(fishing().consumables.fish_xp_scroll).toBe(1);
        expect(fishing().activeXpScroll).toBeFalsy();
    });
});

describe('shop unlock', () => {
    const unlock = location => run('unlock', { options: { location } });

    test('an unknown location', async () => {
        seedPlayer();
        expect(repliedText(await unlock('moon'))).toBe('Unknown location.');
    });

    test('one already unlocked', async () => {
        seedPlayer({ fishing: { level: 15, unlockedLocations: ['pond', 'river'] } });
        expect(repliedText(await unlock('river'))).toBe(`**${LOCATIONS.river.name}** is already unlocked.`);
    });

    test('below the level it needs', async () => {
        seedPlayer({ fishing: { level: 12 } });
        expect(repliedText(await unlock('lake'))).toBe(
            `You need Fisher Level **20** to unlock **${LOCATIONS.lake.name}**. You are Level **12**.`);
    });

    test('without the coins', async () => {
        seedPlayer({ balance: 2_000, fishing: { level: 10 } });
        expect(repliedText(await unlock('river'))).toBe(
            `Unlocking **${LOCATIONS.river.name}** costs **🪙2,500**. You have **🪙2,000**.`);
        expect(fishing().unlockedLocations).toEqual(['pond']);
    });

    test('unlocks, charges, and makes it the active spot', async () => {
        seedPlayer({ fishing: { level: 10 } });
        const interaction = await unlock('river');

        expect(balance()).toBe(10_000 - 2_500);
        expect(fishing()).toMatchObject({ unlockedLocations: ['pond', 'river'], activeLocation: 'river' });
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toContain(`${LOCATIONS.river.name} Unlocked!`);
        expect(embed.fields.find(f => f.name === 'Cost Paid').value).toBe('🪙2,500');
        expect(embed.fields.find(f => f.name === 'Balance').value).toBe('🪙7,500');
    });

    test('a claim that fails is refused without charging', async () => {
        seedPlayer({ fishing: { level: 10 } });
        mockFail.grant = 'before';
        const interaction = await unlock('river');
        expect(repliedText(interaction)).toContain('Purchase failed. Conditions may have changed');
        expect(balance()).toBe(10_000);
        expect(fishing().unlockedLocations).toEqual(['pond']);
    });

    test('a debit that fails is still refused when the rollback itself fails', async () => {
        seedPlayer({ fishing: { level: 10 } });
        mockFail.debitNull = true;
        mockFail.rollback = true;
        const interaction = await unlock('river');
        expect(repliedText(interaction)).toContain('Purchase failed. Conditions may have changed');
        expect(balance()).toBe(10_000);
    });

    test('a debit that fails rolls the unlock back', async () => {
        seedPlayer({ fishing: { level: 10 } });
        mockFail.debitNull = true;
        const interaction = await unlock('river');
        expect(repliedText(interaction)).toContain('Purchase failed. Conditions may have changed');
        expect(balance()).toBe(10_000);
        expect(fishing()).toMatchObject({ unlockedLocations: ['pond'], activeLocation: 'pond' });
    });

});
