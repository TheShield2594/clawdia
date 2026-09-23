'use strict';

// `/fish shop rod`, `upgrade` and `repair` driven end to end (#998).
//
// The folder measured 0.4% of branches — its files were required by other
// suites and never run. This drives the real handlers through `handleShop`
// against stores that evaluate the guarded writes they issue (the
// `balance: { $gte }` debit, the stack-cap `$expr` on the grant, the keyed
// refund pipeline), so a refusal and a success are told apart by what the
// store holds afterwards, not by which mock was called.
//
// The dispatch, browse, buy, use and unlock flows are in fishShopCommands.test.js.

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
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { getItemImageAttachment } = require('../src/utils/itemImageHelper');
const { handleShop } = require('../src/commands/economy/fish/shop');
const { ROD_BY_SLUG, ROD_UPGRADES } = require('../src/data/fishData');

const USER = 'user-1';
const GUILD = 'guild-1';
const GRANT_KEY = 'shop:interaction-1:grant';

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

const BAMBOO = ROD_BY_SLUG.bamboo_rod;
const FIBERGLASS = ROD_BY_SLUG.fiberglass_rod;

/** A stored rod, full and unupgraded unless told otherwise. */
function rod(slug = 'bamboo_rod', over = {}) {
    const data = ROD_BY_SLUG[slug];
    return {
        name: data.name, tier: data.tier, slug,
        currentDurability: data.baseDurability, maxDurability: data.baseDurability,
        baseDurability: data.baseDurability, repairCount: 0, upgrade: null, status: 'good',
        ...over,
    };
}

const equipped = (r = rod()) => ({ rods: [r], equippedRodIndex: 0 });
const field = (interaction, name) =>
    interaction.replies.at(-1).embeds[0].data.fields.find(f => f.name === name)?.value;

describe('shop rod', () => {
    const buy = (type, opts = {}) => run('rod', { options: { type }, components: confirm('buyrod_confirm'), ...opts });

    test('an unknown rod', async () => {
        seedPlayer();
        const interaction = await run('rod', { options: { type: 'stick' } });
        expect(repliedText(interaction)).toBe('Unknown rod type.');
    });

    test('without the coins', async () => {
        seedPlayer({ balance: 400 });
        const interaction = await run('rod', { options: { type: 'bamboo_rod' } });
        expect(repliedText(interaction)).toBe(
            `You need **🪙500** to buy the **${BAMBOO.name}**. You have **🪙400**.`);
    });

    test('the prompt spells out a rod with no bait and no boost', async () => {
        seedPlayer();
        const interaction = await run('rod', { options: { type: 'bamboo_rod' } });
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toBe(`${BAMBOO.emoji} Purchase ${BAMBOO.name}?`);
        expect(field({ replies: [interaction.replies[0]] }, 'Bait Type')).toBe('No bait needed');
        expect(field({ replies: [interaction.replies[0]] }, 'Rarity Boost')).toBe('None');
        expect(embed.thumbnail).toBeUndefined();
        expect(interaction.replies[0].files).toBeUndefined();
    });

    test('the prompt spells out a rod that needs bait, with its image when there is one', async () => {
        seedPlayer();
        getItemImageAttachment.mockResolvedValueOnce({ url: 'attachment://rod.png', attachment: 'rod-file' });
        const interaction = await run('rod', { options: { type: 'fiberglass_rod' } });
        const prompt = { replies: [interaction.replies[0]] };
        expect(field(prompt, 'Bait Type')).toBe('worm bait');
        expect(field(prompt, 'Rarity Boost')).toBe('+2%');
        expect(field(prompt, 'Success Rate')).toBe(`${Math.round(FIBERGLASS.successRate * 100)}%`);
        expect(interaction.replies[0].embeds[0].data.thumbnail.url).toBe('attachment://rod.png');
        expect(interaction.replies[0].files).toEqual(['rod-file']);
    });

    test('an image lookup that fails still draws the prompt', async () => {
        seedPlayer();
        getItemImageAttachment.mockRejectedValueOnce(new Error('no image store'));
        const interaction = await run('rod', { options: { type: 'bamboo_rod' } });
        expect(interaction.replies[0].embeds[0].data.title).toContain('Purchase');
    });

    test('left alone, it times out', async () => {
        seedPlayer();
        const interaction = await run('rod', { options: { type: 'bamboo_rod' } });
        expect(repliedText(interaction)).toContain('Purchase timed out.');
        expect(balance()).toBe(10_000);
    });

    test('a timeout whose edit fails is swallowed', async () => {
        seedPlayer();
        const interaction = await run('rod', { options: { type: 'bamboo_rod' }, prepare: expiredToken });
        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Purchase timed out.' }));
    });

    test('cancel buys nothing', async () => {
        seedPlayer();
        const interaction = await buy('bamboo_rod', { components: confirm('buyrod_cancel') });
        expect(repliedText(interaction)).toContain('Purchase cancelled.');
        expect(balance()).toBe(10_000);
        expect(fishing().rods).toEqual([]);
    });

    test('somebody else pressing Buy is turned away', async () => {
        seedPlayer();
        const interaction = await buy('bamboo_rod', { components: [{ customId: 'buyrod_confirm', user: 'user-2' }] });
        expect(repliedText(interaction)).toContain('This is not your confirmation.');
        expect(fishing().rods).toEqual([]);
        expect(balance()).toBe(10_000);
    });

    test('charges, adds a fresh rod and stamps the purchase key on the profile', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await buy('fiberglass_rod');

        expect(balance()).toBe(10_000 - 2_500);
        expect(fishing().rods).toHaveLength(2);
        expect(fishing().rods[1]).toMatchObject({
            name: FIBERGLASS.name, tier: 2, slug: 'fiberglass_rod',
            currentDurability: FIBERGLASS.baseDurability, maxDurability: FIBERGLASS.baseDurability,
            repairCount: 0, upgrade: null, status: 'good',
        });
        // Bought, not equipped.
        expect(fishing().equippedRodIndex).toBe(0);
        expect(profile().grantKeys.map(k => k.key)).toEqual([GRANT_KEY]);

        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.title).toBe(`${FIBERGLASS.emoji} ${FIBERGLASS.name} Purchased!`);
        expect(embed.description).toContain('`/fish equip 2`');
        expect(field(interaction, 'Balance')).toBe('🪙7,500');
    });

    test('a wallet emptied since the prompt is not charged', async () => {
        seedPlayer();
        const interaction = await buy('bamboo_rod', { between: () => { mockUsers.get(USER).balance = 100; } });
        expect(repliedText(interaction)).toContain('Insufficient funds. You need 🪙500.');
        expect(balance()).toBe(100);
        expect(fishing().rods).toEqual([]);
    });

    test('a save that never landed is refunded', async () => {
        seedPlayer();
        mockFail.userSave = true;
        const interaction = await buy('bamboo_rod');
        expect(repliedText(interaction)).toContain('your coins were refunded');
        expect(balance()).toBe(10_000);
        expect(fishing().rods).toEqual([]);
    });

    test('a save that landed but lost its response keeps the rod and the charge', async () => {
        seedPlayer();
        mockFail.grindSave = 'after';
        const interaction = await buy('bamboo_rod');
        expect(repliedText(interaction)).toContain(`${BAMBOO.name} Purchased!`);
        expect(balance()).toBe(9_500);
        expect(fishing().rods).toHaveLength(1);
    });

    test('a save whose outcome cannot be read back is left for an admin', async () => {
        seedPlayer();
        mockFail.userSave = true;
        mockFail.grindRead = true;
        const interaction = await buy('bamboo_rod');
        expect(repliedText(interaction)).toContain('could not be confirmed');
        expect(repliedText(interaction)).toContain('**not** been refunded');
        expect(balance()).toBe(9_500);
    });

    test('a refund that will not land is recorded as owed', async () => {
        seedPlayer();
        mockFail.userSave = true;
        mockFail.credit = true;
        const interaction = await buy('bamboo_rod');
        expect(repliedText(interaction)).toContain('the 🪙500 charged could not be returned automatically');
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({ service: 'fish', jobName: 'rodRefund' }));
    });

    test('a refund that can be neither paid nor recorded points at an admin', async () => {
        seedPlayer();
        mockFail.userSave = true;
        mockFail.credit = true;
        recordOwedPayout.mockResolvedValue(false);
        const interaction = await buy('bamboo_rod');
        expect(repliedText(interaction)).toContain('could not be returned or recorded — please contact a server admin');
    });
});

describe('shop upgrade', () => {
    const LINE = ROD_UPGRADES.enhanced_line;
    const LINE_COST = Math.round(BAMBOO.cost * LINE.costMultiplier);
    const install = (opts = {}) => run('upgrade', {
        options: { type: 'enhanced_line' }, components: confirm('upgrade_confirm'), ...opts,
    });

    test('with no rod equipped', async () => {
        seedPlayer();
        const interaction = await run('upgrade', { options: { type: 'enhanced_line' } });
        expect(repliedText(interaction)).toContain("You don't have a rod equipped");
    });

    test('an equipped index that points at nothing counts as no rod', async () => {
        seedPlayer({ fishing: { rods: [], equippedRodIndex: 2 } });
        const interaction = await run('upgrade', { options: { type: 'enhanced_line' } });
        expect(repliedText(interaction)).toContain("You don't have a rod equipped");
    });

    test('an unknown upgrade', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await run('upgrade', { options: { type: 'turbo' } });
        expect(repliedText(interaction)).toBe('Unknown upgrade.');
    });

    test('a rod that already has one', async () => {
        seedPlayer({ fishing: equipped(rod('bamboo_rod', { upgrade: 'polarized_lens' })) });
        const interaction = await run('upgrade', { options: { type: 'enhanced_line' } });
        expect(repliedText(interaction)).toBe(
            `Your **${BAMBOO.name}** already has the **polarized lens** upgrade. Each rod can only hold one upgrade.`);
    });

    test('without the coins, priced from the rod it goes on', async () => {
        seedPlayer({ balance: 100, fishing: equipped() });
        const interaction = await run('upgrade', { options: { type: 'enhanced_line' } });
        expect(repliedText(interaction)).toBe(
            `You need **🪙${LINE_COST}** to install **${LINE.name}**. You have **🪙100**.`);
    });

    test('the prompt names the rod and the price', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await run('upgrade', { options: { type: 'enhanced_line' } });
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toBe(`${LINE.emoji} Install ${LINE.name}?`);
        expect(embed.description).toContain(`Installing on **${BAMBOO.name}**`);
        expect(embed.fields.find(f => f.name === 'Cost').value).toBe(`🪙${LINE_COST}`);
        expect(repliedText(interaction)).toContain('Installation timed out.');
    });

    test('a timeout whose edit fails is swallowed', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await run('upgrade', { options: { type: 'enhanced_line' }, prepare: expiredToken });
        expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Installation timed out.' }));
    });

    test('cancel installs nothing', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await install({ components: confirm('upgrade_cancel') });
        expect(repliedText(interaction)).toContain('Installation cancelled.');
        expect(fishing().rods[0].upgrade).toBeNull();
        expect(balance()).toBe(10_000);
    });

    test('somebody else pressing Install is turned away', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await install({ components: [{ customId: 'upgrade_confirm', user: 'user-2' }] });
        expect(repliedText(interaction)).toContain('This is not your confirmation.');
        expect(fishing().rods[0].upgrade).toBeNull();
    });

    test('charges and installs it on the equipped rod', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await install();

        expect(balance()).toBe(10_000 - LINE_COST);
        expect(fishing().rods[0].upgrade).toBe('enhanced_line');
        expect(profile().grantKeys.map(k => k.key)).toEqual([GRANT_KEY]);
        const embed = interaction.replies.at(-1).embeds[0].data;
        expect(embed.title).toBe(`${LINE.emoji} ${LINE.name} Installed!`);
        expect(field(interaction, 'Balance')).toBe(`🪙${(10_000 - LINE_COST).toLocaleString()}`);
    });

    test('a rod gone since the prompt is not charged', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await install({ between: () => { fishing().rods = []; } });
        expect(repliedText(interaction)).toContain('That rod is no longer in your inventory.');
        expect(balance()).toBe(10_000);
    });

    test('a rod upgraded since the prompt is not charged', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await install({ between: () => { fishing().rods[0].upgrade = 'reinforced_grip'; } });
        expect(repliedText(interaction)).toContain(`**${BAMBOO.name}** already has an upgrade installed.`);
        expect(fishing().rods[0].upgrade).toBe('reinforced_grip');
        expect(balance()).toBe(10_000);
    });

    test('a wallet emptied since the prompt is not charged', async () => {
        seedPlayer({ fishing: equipped() });
        const interaction = await install({ between: () => { mockUsers.get(USER).balance = 10; } });
        expect(repliedText(interaction)).toContain('Insufficient funds.');
        expect(fishing().rods[0].upgrade).toBeNull();
    });

    test('a save that never landed is refunded', async () => {
        seedPlayer({ fishing: equipped() });
        mockFail.userSave = true;
        const interaction = await install();
        expect(repliedText(interaction)).toContain('your coins were refunded');
        expect(balance()).toBe(10_000);
        expect(fishing().rods[0].upgrade).toBeNull();
    });

    test('a save that landed but lost its response keeps the upgrade', async () => {
        seedPlayer({ fishing: equipped() });
        mockFail.grindSave = 'after';
        const interaction = await install();
        expect(repliedText(interaction)).toContain(`${LINE.name} Installed!`);
        expect(fishing().rods[0].upgrade).toBe('enhanced_line');
        expect(balance()).toBe(10_000 - LINE_COST);
    });

    test('a save whose outcome cannot be read back is left for an admin', async () => {
        seedPlayer({ fishing: equipped() });
        mockFail.userSave = true;
        mockFail.grindRead = true;
        const interaction = await install();
        expect(repliedText(interaction)).toContain(`without the ${LINE.name} installing, contact a server admin`);
        expect(balance()).toBe(10_000 - LINE_COST);
    });

    test('a refund that will not land is recorded as owed', async () => {
        seedPlayer({ fishing: equipped() });
        mockFail.userSave = true;
        mockFail.credit = true;
        const interaction = await install();
        expect(repliedText(interaction)).toContain('recorded as owed');
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'upgradeRefund' }));
    });

    test('a refund that can be neither paid nor recorded points at an admin', async () => {
        seedPlayer({ fishing: equipped() });
        mockFail.userSave = true;
        mockFail.credit = true;
        recordOwedPayout.mockResolvedValue(false);
        const interaction = await install();
        expect(repliedText(interaction)).toContain('could not be returned or recorded');
    });
});

describe('shop repair — kits', () => {
    const kit = (kitId, over) => run('repair', { options: { method: 'kit', kit: kitId, ...over } });

    test('with no rod equipped', async () => {
        seedPlayer();
        expect(repliedText(await kit('repair_kit_small'))).toContain("You don't have a rod equipped");
    });

    test('without naming a kit', async () => {
        seedPlayer({ fishing: equipped(rod('bamboo_rod', { currentDurability: 30, status: 'degraded' })) });
        expect(repliedText(await kit(null))).toBe('Please specify a kit size using the `kit` option.');
    });

    test('with none of that kit in the bag', async () => {
        seedPlayer({ fishing: equipped(rod('bamboo_rod', { currentDurability: 30, status: 'degraded' })) });
        expect(repliedText(await kit('repair_kit_large'))).toContain("You don't have any **Large Repair Kit**");
        expect(repliedText(await kit('repair_kit_small'))).toContain("You don't have any **Small Repair Kit**");
    });

    test('on a condemned rod', async () => {
        seedPlayer({ fishing: {
            ...equipped(rod('bamboo_rod', { currentDurability: 10, status: 'condemned' })),
            consumables: { repair_kit_small: 1 },
        } });
        expect(repliedText(await kit('repair_kit_small'))).toBe('This rod is condemned and cannot be repaired.');
        expect(fishing().consumables.repair_kit_small).toBe(1);
    });

    test('on a rod already at full durability', async () => {
        seedPlayer({ fishing: { ...equipped(), consumables: { repair_kit_small: 1 } } });
        expect(repliedText(await kit('repair_kit_small'))).toBe('Your rod is already at full durability.');
        expect(fishing().consumables.repair_kit_small).toBe(1);
    });

    test('a small kit restores 20 without touching max durability', async () => {
        seedPlayer({ fishing: {
            ...equipped(rod('bamboo_rod', { currentDurability: 30, status: 'degraded' })),
            consumables: { repair_kit_small: 2 },
        } });
        const interaction = await kit('repair_kit_small');

        expect(fishing().rods[0]).toMatchObject({ currentDurability: 50, maxDurability: 80, status: 'good', repairCount: 0 });
        expect(fishing().consumables.repair_kit_small).toBe(1);
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toBe('🔧 Small Repair Kit Used');
        expect(field(interaction, 'Restored')).toBe('+20 durability');
        expect(field(interaction, 'Remaining')).toBe('1 kit(s) left');
        expect(balance()).toBe(10_000);
    });

    test('a large kit restores only what is missing', async () => {
        seedPlayer({ fishing: {
            ...equipped(rod('bamboo_rod', { currentDurability: 60 })),
            consumables: { repair_kit_large: 1 },
        } });
        const interaction = await kit('repair_kit_large');
        expect(fishing().rods[0].currentDurability).toBe(80);
        expect(fishing().consumables.repair_kit_large).toBe(0);
        expect(interaction.replies[0].embeds[0].data.title).toBe('🔨 Large Repair Kit Used');
        expect(field(interaction, 'Restored')).toBe('+20 durability');
    });

    test('a save that fails says so and keeps the kit', async () => {
        seedPlayer({ fishing: {
            ...equipped(rod('bamboo_rod', { currentDurability: 30, status: 'degraded' })),
            consumables: { repair_kit_small: 1 },
        } });
        mockFail.userSave = true;
        expect(repliedText(await kit('repair_kit_small'))).toBe('Something went wrong. Please try again.');
        expect(fishing().consumables.repair_kit_small).toBe(1);
        expect(fishing().rods[0].currentDurability).toBe(30);
    });
});

describe('shop repair — at the shop', () => {
    const repair = amount => run('repair', { options: { method: 'shop', amount } });
    const worn = over => equipped(rod('bamboo_rod', { currentDurability: 30, status: 'degraded', ...over }));

    test('a condemned rod is refused by the quote', async () => {
        seedPlayer({ fishing: worn({ currentDurability: 10, status: 'condemned' }) });
        expect(repliedText(await repair())).toBe('This rod is condemned and cannot be repaired. Replace it.');
    });

    test('a rod already at full durability', async () => {
        seedPlayer({ fishing: equipped() });
        expect(repliedText(await repair())).toBe('Rod is already at full durability.');
        expect(fishing().rods[0].maxDurability).toBe(80);
    });

    test('without the coins, and the rod is left exactly as it was', async () => {
        seedPlayer({ balance: 100, fishing: worn() });
        const interaction = await repair();
        // 42 to restore → three units of 20 at 70 each.
        expect(repliedText(interaction)).toBe('Repairing **42** durability costs **🪙210**. You only have **🪙100**.');
        expect(fishing().rods[0]).toMatchObject({ currentDurability: 30, maxDurability: 80, repairCount: 0 });
    });

    test('a full repair charges, restores to the reduced max and counts the repair', async () => {
        seedPlayer({ fishing: worn() });
        const interaction = await repair();

        expect(balance()).toBe(10_000 - 210);
        expect(fishing().rods[0]).toMatchObject({ currentDurability: 72, maxDurability: 72, repairCount: 1, status: 'good' });
        expect(interaction.replies[0].embeds[0].data.title).toBe('🔧 Rod Repaired');
        expect(field(interaction, 'Cost')).toBe('🪙210');
        expect(field(interaction, 'Balance')).toBe('🪙9,790');
        expect(field(interaction, 'ℹ️ Note')).toBe('Max durability slightly reduced to 72 after this repair.');
    });

    test('a partial repair charges only for what was asked', async () => {
        seedPlayer({ fishing: worn() });
        const interaction = await repair(20);
        expect(balance()).toBe(10_000 - 70);
        expect(fishing().rods[0]).toMatchObject({ currentDurability: 50, maxDurability: 72, repairCount: 1 });
        expect(field(interaction, 'Restored')).toBe('+20 durability');
    });

    test('a broken rod can be brought back', async () => {
        seedPlayer({ fishing: worn({ currentDurability: 0, status: 'broken' }) });
        await repair();
        expect(balance()).toBe(10_000 - 280);
        expect(fishing().rods[0]).toMatchObject({ currentDurability: 72, status: 'good' });
    });

    test('a charge that fails leaves the stored rod alone', async () => {
        seedPlayer({ fishing: worn() });
        mockFail.debitNull = true;
        const interaction = await repair();
        expect(repliedText(interaction)).toContain('you no longer have enough');
        expect(balance()).toBe(10_000);
        expect(fishing().rods[0]).toMatchObject({ currentDurability: 30, maxDurability: 80, repairCount: 0 });
    });

    test('a save that fails refunds the charge', async () => {
        seedPlayer({ fishing: worn() });
        mockFail.userSave = true;
        const interaction = await repair();
        expect(repliedText(interaction)).toBe('The repair failed — your coins were refunded. Please try again.');
        expect(balance()).toBe(10_000);
        expect(fishing().rods[0]).toMatchObject({ currentDurability: 30, maxDurability: 80, repairCount: 0 });
    });

    test('a refund that will not land is recorded as owed', async () => {
        seedPlayer({ fishing: worn() });
        mockFail.userSave = true;
        mockFail.credit = true;
        const interaction = await repair();
        expect(repliedText(interaction)).toContain('The repair failed, and the 🪙210 charged could not be returned automatically');
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({ service: 'fish', jobName: 'shopRefund' }));
        expect(balance()).toBe(10_000 - 210);
    });
});
