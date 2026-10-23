'use strict';

// /mine dig end to end (mine/dig.js), over a fake interaction: the rock survey
// prompt, the intensity choice, the three-way cave-in, and the result with its
// "Dig again" button. The database, the lock and every side channel are
// stubbed; the mine's own rules (mineService, mineData, embeds) run for real,
// with the RNG pinned.

const { EventEmitter } = require('events');

jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({ economy: {} })) }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn(async () => {}),
    onMine: jest.fn(async () => ({ completed: [], nearComplete: [] })),
    onEconomyEarn: jest.fn(async () => ({ completed: [], nearComplete: [] })),
    notifyQuestComplete: jest.fn(async () => {}),
    notifyQuestNearComplete: jest.fn(async () => {}),
}));
jest.mock('../src/services/seasonMissionService', () => ({ recordMissionProgress: jest.fn() }));
jest.mock('../src/services/achievementService', () => ({
    checkAndAward: jest.fn(async () => []), announceAchievements: jest.fn(async () => {}),
}));
jest.mock('../src/utils/bigWinLogger', () => ({ logBigWin: jest.fn() }));
jest.mock('../src/utils/weeklyChampion', () => ({
    addWeeklyChampionProgress: jest.fn(async () => {}), getWeeklyChampionLeader: jest.fn(async () => null),
}));
jest.mock('../src/utils/itemImageHelper', () => ({ attachResultThumbnail: jest.fn(async () => []) }));
jest.mock('../src/utils/grindRecord', () => ({
    ...jest.requireActual('../src/utils/grindRecord'), serverBest: jest.fn(async () => 0),
}));
jest.mock('../src/utils/stagedLootReveal', () => ({
    stagedLootReveal: jest.fn(async (interaction, _tier, embed, _a, files, { components } = {}) => {
        await interaction.editReply({ embeds: [embed].flat(), files, components });
    }),
}));
jest.mock('../src/services/petService', () => ({
    getTotalBonus: () => 0, petCompanionLine: () => null, tryGrantRarePet: () => null,
}));
jest.mock('../src/services/districtService', () => ({ isDistrictActive: () => false }));
jest.mock('../src/services/effectsService', () => ({
    ...jest.requireActual('../src/services/effectsService'), refundEffectCharge: jest.fn(),
}));
jest.mock('../src/commands/economy/mine/actions', () => {
    const actual = jest.requireActual('../src/commands/economy/mine/actions');
    return { ...actual, attachResultActions: jest.fn(async () => null) };
});
jest.mock('../src/services/mineService', () => {
    const actual = jest.requireActual('../src/services/mineService');
    return {
        ...actual,
        prepareDigUser: jest.fn(async user => { actual.ensureMineData(user); }),
        claimDigCooldown: jest.fn(async user => {
            user.mining.lastMine = new Date();
            return { claimed: true, release: jest.fn(async () => {}) };
        }),
        commitDig: jest.fn(async () => ({ payoutOwed: 0 })),
    };
});

const User = require('../src/models/User');
const { attachResultActions, IDS } = require('../src/commands/economy/mine/actions');
const { handleDig } = require('../src/commands/economy/mine/dig');
const { serverBest } = require('../src/utils/grindRecord');
const { attachResultThumbnail } = require('../src/utils/itemImageHelper');
const { mockRandom, restoreRandom } = require('./helpers/secureRandom');

function miner({ tier = 1, stamina = 6, charges = {} } = {}) {
    return {
        userId: 'u1', guildId: 'g1', balance: 1000, quests: [], pets: [], streak: { current: 0 },
        mining: {
            level: 10, stamina, charges,
            pickaxes: [{
                name: 'Wooden Pickaxe', tier, slug: 'wooden_pickaxe', status: 'good', upgrade: null,
                currentDurability: 60, maxDurability: 80, baseDurability: 80, repairCount: 0,
            }],
            equippedPickaxeIndex: 0,
        },
        markModified() {},
    };
}

/**
 * A slash interaction whose component collectors answer from `clicks`, in
 * order. A null click lets the collector time out.
 */
function interactionWith({ intensity = null, clicks = [] } = {}) {
    const queue = [...clicks];
    const calls = [];
    const message = {
        createMessageComponentCollector: () => {
            const col = new EventEmitter();
            setImmediate(() => {
                const customId = queue.shift();
                if (customId) {
                    col.emit('collect', { customId, deferUpdate: async () => {} });
                    col.emit('end', null, 'limit');
                } else {
                    col.emit('end', null, 'time');
                }
            });
            return col;
        },
    };
    const interaction = {
        id: 'int1',
        replied: false,
        deferred: false,
        user: { id: 'u1', username: 'miner' },
        member: {},
        client: {},
        channel: { send: jest.fn(async () => {}) },
        guild: { id: 'g1', channels: { cache: new Map() } },
        options: {
            getString: () => null,
            getInteger: name => (name === 'intensity' ? intensity : null),
        },
        reply: jest.fn(async p => { interaction.replied = true; calls.push(['reply', p]); }),
        editReply: jest.fn(async p => { calls.push(['edit', p]); }),
        fetchReply: jest.fn(async () => message),
    };
    return { interaction, calls };
}

const lastEdit = calls => calls.filter(([k]) => k === 'edit').at(-1)[1];
const componentIds = payload => (payload.components ?? []).flatMap(r => (r.toJSON ? r.toJSON() : r).components.map(c => c.custom_id));

afterEach(() => { restoreRandom(); jest.clearAllMocks(); });

test('the prompt shows the survey and a button per rung, and the result offers Dig again', async () => {
    const user = miner();
    User.findOneAndUpdate.mockResolvedValue(user);
    mockRandom(0.5);   // a middling roll everywhere: a clean Steady dig, no cave-in
    const { interaction, calls } = interactionWith({ clicks: ['digint_2'] });

    const out = await handleDig(interaction);

    const [kind, prompt] = calls[0];
    expect(kind).toBe('reply');
    expect(prompt.embeds[0].data.title).toContain('read the rock');
    expect(prompt.embeds[0].data.description).toMatch(/seam/);
    expect(prompt.embeds[0].data.description).toMatch(/reads rock right 60%/);
    expect(componentIds(prompt)).toEqual(['digint_1', 'digint_2', 'digint_3', 'digint_4']);

    const final = lastEdit(calls);
    expect(componentIds(final)).toEqual([IDS.again]);
    expect(final.embeds.at(-1).data.description).toMatch(/Dug \*\*Steady\*\*/);
    expect(final.embeds.at(-1).data.description).toMatch(/Next dig <t:\d+:R>/);
    // A failed swing is a miss: text only, no card and no ore art.
    expect(final.embeds).toHaveLength(1);
    expect(final.files).toEqual([]);
    expect(attachResultActions).toHaveBeenCalledWith(interaction, { depthId: 'surface_quarry' });
    expect(out).toEqual({ started: true });
    expect(user.mining.preferredIntensity).toBe(2);
});

test('passing intensity skips the prompt, and a Careful dig costs no wear', async () => {
    const user = miner();
    User.findOneAndUpdate.mockResolvedValue(user);
    mockRandom(0);     // every roll succeeds
    const { interaction, calls } = interactionWith({ intensity: 1 });

    await handleDig(interaction);

    expect(calls.filter(([k]) => k === 'reply')).toHaveLength(1);
    expect(calls[0][1].embeds[0].data.title).toContain('Digging Careful');
    expect(user.mining.pickaxes[0].currentDurability).toBe(60);
    const final = lastEdit(calls);
    expect(final.embeds.at(-1).data.title).not.toContain('Fled');
    // The picture card leads the kept dig, and stands in for the thumbnail.
    expect(final.embeds).toHaveLength(2);
    expect(final.embeds[0].data.image.url).toBe('attachment://mine-result.png');
    expect(final.files.map(f => f.name)).toEqual(['mine-result.png']);
    expect(final.files[0].description).toMatch(/^miner struck an? \w+ /);
    expect(serverBest).toHaveBeenCalledWith('g1', 'mining', 'bestPayout', 'u1');
    expect(attachResultThumbnail).not.toHaveBeenCalled();
});

test('a Wooden Pickaxe can dig out of a cave-in: stamina for the ore', async () => {
    const user = miner({ stamina: 6 });
    User.findOneAndUpdate.mockResolvedValue(user);
    mockRandom(0);     // success, and the cave-in roll lands
    const { interaction, calls } = interactionWith({ clicks: ['digint_4', 'cavein_int1_digout'] });

    await handleDig(interaction);

    const caveIn = calls.find(([, p]) => p.embeds?.[0]?.data.title === '🌑 CAVE-IN!')[1];
    const buttons = caveIn.components[0].toJSON().components;
    expect(buttons.map(b => [b.custom_id, !!b.disabled])).toEqual([
        ['cavein_int1_blast', true],     // a Wooden Pickaxe takes no charges
        ['cavein_int1_digout', false],
        ['cavein_int1_abandon', false],
    ]);

    // 6 − 1 for the dig − 2 to dig out.
    expect(user.mining.stamina).toBe(3);
    const final = lastEdit(calls).embeds.at(-1).data;
    expect(final.title).not.toContain('Fled');
    expect(final.description).toContain('You dug out by hand (2 stamina)');
    expect(lastEdit(calls).files[0].description).toContain('Cave-in: Dug out by hand for 2 stamina');
});

test('a cave-in left to time out with no charges flees, and the card says so', async () => {
    const user = miner();
    User.findOneAndUpdate.mockResolvedValue(user);
    mockRandom(0);
    const { interaction, calls } = interactionWith({ clicks: ['digint_4', null] });

    await handleDig(interaction);

    const final = lastEdit(calls).embeds.at(-1).data;
    expect(final.title).toContain('Fled the Cave-in');
    expect(user.balance).toBe(1000);
    // Ore left in the collapse gets no picture and no ore art.
    expect(lastEdit(calls).embeds).toHaveLength(1);
    expect(lastEdit(calls).files).toEqual([]);
});

test('blasting a Reckless cave-in spends three charges', async () => {
    const user = miner({ tier: 2, charges: { iron_blast: 10 } });
    user.mining.pickaxes[0].name = 'Iron Pickaxe';
    User.findOneAndUpdate.mockResolvedValue(user);
    mockRandom(0);
    const { interaction, calls } = interactionWith({ clicks: ['digint_4', 'cavein_int1_blast'] });

    await handleDig(interaction);

    // 10 − 1 to dig with an Iron Pickaxe − 3 to blast clear at Reckless.
    expect(user.mining.charges.iron_blast).toBe(6);
    expect(lastEdit(calls).embeds.at(-1).data.description).toContain('You blasted clear (3 charges)');
});
