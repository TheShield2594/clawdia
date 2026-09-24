'use strict';

// /fish cast end to end, over a fake interaction: the bite, the fight, the
// reveal, the result card and a boss fight, with the database and the other
// services stubbed. The pieces each have their own tests; this is what checks
// they are wired together — that the bite never names the fish, that a misread
// fight escapes or downgrades, and that a boss fight opens on the revealed catch.

const { EventEmitter } = require('events');

jest.mock('../src/utils/delay', () => ({ delay: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn(async () => ({ economy: { currency: '🪙' }, quests: { enabled: false } })) }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/models/Guild', () => ({
    findOneAndUpdate: jest.fn(() => ({ lean: async () => null })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
    findOne: jest.fn(() => ({ lean: () => ({ catch: async () => null }) })),
}));
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async () => {}) }));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn(async () => {}),
    onFish: jest.fn(async () => ({ completed: [], nearComplete: [] })),
    onEconomyEarn: jest.fn(async () => ({ completed: [], nearComplete: [] })),
    notifyQuestComplete: jest.fn(async () => {}),
    notifyQuestNearComplete: jest.fn(async () => {}),
}));
jest.mock('../src/services/seasonMissionService', () => ({ recordMissionProgress: jest.fn() }));
jest.mock('../src/services/achievementService', () => ({ checkAndAward: jest.fn(async () => []), announceAchievements: jest.fn(async () => {}) }));
jest.mock('../src/services/tournamentService', () => ({ submitCatch: jest.fn(async () => {}) }));
jest.mock('../src/utils/weeklyChampion', () => ({ addWeeklyChampionProgress: jest.fn(async () => {}), getWeeklyChampionLeader: jest.fn(async () => null) }));
jest.mock('../src/utils/bigWinLogger', () => ({ logBigWin: jest.fn() }));
jest.mock('../src/utils/balanceDelta', () => ({ saveWithBalanceDelta: jest.fn(async () => ({ credited: true })) }));
jest.mock('../src/services/seasonalEventService', () => ({ getEventCrossSystemType: () => null }));
jest.mock('../src/services/petService', () => ({
    getTotalBonus: () => 0, petCompanionLine: () => null, tryGrantRarePet: () => null,
}));
jest.mock('../src/services/fishService', () => {
    const actual = jest.requireActual('../src/services/fishService');
    return {
        ...actual,
        prepareCastUser: jest.fn(async user => { actual.ensureFishingData(user); }),
        claimCastCooldown: jest.fn(async () => ({ claimed: true, release: jest.fn(async () => {}) })),
        commitCast: jest.fn(async () => ({ payoutOwed: 0 })),
        executeCast: jest.fn(),
        rollBossFight: jest.fn(actual.rollBossFight),
    };
});

const User = require('../src/models/User');
const fishService = require('../src/services/fishService');
const { handleCast } = require('../src/commands/economy/fish/cast');
const { FISH, FIGHT_CUES, ROD_TIERS, BOSS_TYPES } = require('../src/data/fishData');

const realSetTimeout = global.setTimeout;
beforeAll(() => { global.setTimeout = fn => { fn(); return 0; }; });
afterAll(() => { global.setTimeout = realSetTimeout; });

function makeUser() {
    const rod = ROD_TIERS[0];
    return {
        userId: 'u1', guildId: 'g1', balance: 1000, pets: [], quests: [],
        fishing: {
            level: 5, xp: 0, prestige: 0, stamina: 10, dailyCoins: 0, dailyCasts: 0,
            rods: [{ name: rod.name, tier: rod.tier, slug: rod.slug, currentDurability: rod.baseDurability, maxDurability: rod.baseDurability, baseDurability: rod.baseDurability, status: 'good' }],
            equippedRodIndex: 0, unlockedLocations: ['pond'], activeLocation: 'pond', bait: {}, materials: {}, catalog: {},
        },
        hunt: { materials: {} },
        markModified() {}, isModified: () => false, save: async () => {},
    };
}

function castResult(user, fish, tier, extra = {}) {
    user.balance += 1000;
    user.fishing.dailyCoins += 1000;
    return {
        success: true, catchType: 'fish', fish, tier, finalPayout: 1000, rawPayout: 1000, xpEarned: 50,
        isCrit: false, critMultiplier: 1, sizeLabel: 'Large', sizeTierId: 'large', weightLbs: 20,
        streakMult: 1, traitEffects: [], durabilityLost: 1, ...extra,
    };
}

// A fake interaction whose buttons are pressed by `strategy` whenever a fight
// prompt goes up: 'right' reads the cue and answers it, 'wrong' answers
// something else, 'timeout' lets the window close.
function harness(strategy) {
    const edits = [];
    const sent = [];
    let pending = null;
    const message = {
        createMessageComponentCollector() {
            const collector = new EventEmitter();
            collector.resetTimer = () => { pending = collector; Promise.resolve().then(press); };
            return collector;
        },
    };
    function press() {
        const collector = pending;
        pending = null;
        const last = edits[edits.length - 1];
        const desc = last.embeds[last.embeds.length - 1].data.description;
        const text = /> \*\*(.+?)\*\*/.exec(desc)[1];
        const correct = Object.keys(FIGHT_CUES).find(m => FIGHT_CUES[m].includes(text));
        const ids = last.components[0].toJSON().components.map(c => c.custom_id);
        if (strategy === 'timeout') { collector.emit('end', null, 'time'); return; }
        const id = ids.find(i => strategy === 'right' ? i.endsWith(`_${correct}`) : !i.endsWith(`_${correct}`));
        collector.emit('collect', { customId: id, deferUpdate: async () => {} });
        collector.emit('end', null, 'limit');
    }
    const interaction = {
        id: 'i1',
        guild: { id: 'g1', channels: { cache: new Map() } },
        user: { id: 'u1', username: 'bob', displayAvatarURL: () => null },
        member: { displayName: 'Bob' },
        options: { getString: () => null },
        client: {},
        channel: { send: async payload => { sent.push(payload); } },
        deferReply: async () => {},
        reply: async () => {},
        editReply: async payload => { edits.push(payload); },
        fetchReply: async () => message,
    };
    return { interaction, edits, sent };
}

const titles = edits => edits.map(e => e.embeds?.map(x => x.data.title).join(' | '));
const buttonIds = edit => (edit.components ?? []).flatMap(row => row.toJSON().components.map(c => c.custom_id));

beforeEach(() => jest.clearAllMocks());

test('a legendary fought and read right: no spoiler, reveal, card, then a boss fight on the catch', async () => {
    const user = makeUser();
    User.findOneAndUpdate.mockResolvedValue(user);
    User.findOne.mockResolvedValue(makeUser());
    fishService.executeCast.mockImplementation(u => castResult(u, FISH.great_white, 'legendary', { bossEncounter: { fish: FISH.great_white, tier: 'legendary' } }));
    fishService.rollBossFight.mockReturnValue({ boss: BOSS_TYPES.ghost_eel, rounds: fishService.rollFightCues(3) });

    const { interaction, edits, sent } = harness('right');
    const outcome = await handleCast(interaction);

    // Two fight beats for a legendary, and none of them names the fish or tier.
    const bites = edits.filter(e => e.embeds[0].data.title === '⚡ The reel SCREAMS!');
    expect(bites).toHaveLength(2);
    for (const b of bites) {
        const text = JSON.stringify(b.embeds[0].data);
        expect(text).not.toContain('Great White');
        expect(text).not.toMatch(/legendary/i);
    }

    // The catch is revealed before the boss: the fanfare comes before round 1.
    const t = titles(edits);
    const fanfare = t.findIndex(x => /𝗟 𝗘 𝗚 𝗘 𝗡 𝗗/.test(x));
    const round1 = t.findIndex(x => /Round 1\/3/.test(x ?? ''));
    expect(fanfare).toBeGreaterThan(-1);
    expect(round1).toBeGreaterThan(fanfare);

    // The final render: the picture card leading (redrawn with the fight's
    // banner), the catch's text, the boss result under it — and the buttons.
    const final = edits[edits.length - 1];
    expect(final.embeds).toHaveLength(3);
    expect(final.embeds[0].data.image.url).toBe('attachment://fish-result.png');
    expect(final.files.map(f => f.name)).toEqual(['fish-result.png']);
    expect(final.embeds[2].data.title).toMatch(/PERFECT/);
    expect(buttonIds(final)).toEqual(['fish_act_again', 'fish_act_keep', 'fish_act_release']);
    // No buttons while the fight or the reveal is still on screen.
    for (const e of edits.slice(0, -1)) {
        expect(buttonIds(e).filter(id => id.startsWith('fish_act_'))).toEqual([]);
    }
    expect(outcome).toEqual({ started: true });

    // The legendary is still announced, boss or not.
    expect(sent.some(p => p.embeds[0].data.title.includes('Legendary Catch'))).toBe(true);
    expect(fishService.commitCast).toHaveBeenCalledTimes(1);
});

test('an epic misread escapes, and the escape says what got away and what the read was', async () => {
    const user = makeUser();
    User.findOneAndUpdate.mockResolvedValue(user);
    fishService.executeCast.mockImplementation(u => castResult(u, FISH.hammerhead, 'epic'));

    const { interaction, edits } = harness('wrong');
    await handleCast(interaction);

    // The escape embed, then an edit that only adds the buttons under it.
    const last = [...edits].reverse().find(e => e.embeds);
    expect(last.embeds[0].data.title).toBe('💨 The One That Got Away');
    expect(last.embeds[0].data.description).toContain(FISH.hammerhead.name);
    expect(last.embeds[0].data.description).toMatch(/it needed \*\*/);
    expect(user.balance).toBe(1000);
    expect(fishService.commitCast).toHaveBeenCalledTimes(1);
    // Nothing landed, so there is nothing to keep or release — only another cast.
    expect(buttonIds(edits[edits.length - 1])).toEqual(['fish_act_again']);
    expect(user.fishing.pendingRelease).toBeNull();
});

test('a rare left to time out lands an actual Uncommon, and its boss roll is dropped', async () => {
    const user = makeUser();
    User.findOneAndUpdate.mockResolvedValue(user);
    fishService.executeCast.mockImplementation(u => castResult(u, FISH.salmon, 'rare', { bossEncounter: { fish: FISH.salmon, tier: 'rare' } }));

    const { interaction, edits } = harness('timeout');
    await handleCast(interaction);

    const final = edits[edits.length - 1];
    expect(final.embeds).toHaveLength(2);
    const text = final.embeds[1];
    expect(text.data.title).not.toContain('Salmon');
    const tier = text.data.fields.find(f => f.name === 'Tier').value;
    expect(tier).toBe('Uncommon');
    expect(fishService.rollBossFight).not.toHaveBeenCalled();
    expect(user.fishing.catalog.salmon).toBeUndefined();
    // The release on offer is for the fish that actually landed, at what it paid.
    expect(user.fishing.pendingRelease).toMatchObject({ castId: 'i1', fishId: user.fishing.pendingRelease.fishId, payout: 350 });
    expect(user.fishing.pendingRelease.fishName).not.toBe('Salmon');
});
