'use strict';

/**
 * #873, pass 19 — season XP, tier claims and daily missions no longer ride
 * `save()`.
 *
 * Pass 18 left this as its bound. The flows that grant season XP, advance a
 * mission or claim a tier did it on the loaded document and let `save()` write
 * it — and `save()` writes `season` and `seasonMissions` back as they were read.
 * Anything that landed in between through an atomic update was erased: a
 * mission another command advanced, a Tier Skip Token's XP, and a /season
 * unlock, which sets `season.premium` in the same write that takes the coins.
 *
 * The pass-15 shape, on two more fields: the User model's pre-save hook keeps
 * them out of every save of an existing document, the flow's operations are
 * recorded, and the post-save hook commits them as guarded writes
 * (models/seasonWrites.js).
 *
 * It also found that `advanceMissions` — the atomic path — had never worked:
 * its pipeline update lacked Mongoose 9's `updatePipeline` opt-in, threw before
 * reaching the server, and the callers' `.catch` swallowed it.
 */

const mongoose = require('mongoose');
const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', { balance: 0, inventory: [] });
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

const RealUser = jest.requireActual('../src/models/User');
const {
    applySeasonWrites, claimMissionSlot, freshSeason, missionAdvancePipeline,
} = require('../src/models/seasonWrites');
const { awardSeasonXp } = require('../src/services/questService');
const { recordMissionProgress, advanceMissions, missionDayStart } = require('../src/services/seasonMissionService');

const GUILD = 'guild-1';
const WHO = { userId: 'user-1', guildId: GUILD };
const SEASON = { enabled: true, seasonId: 'pass-9', weeklyXpCap: 500, xpPerTier: 100, maxTiers: 50 };
const DAY = 86_400_000;

/** A User document as a query returns it: existing, nothing modified. */
function loaded(fields) {
    const doc = new RealUser();
    doc.init({ _id: new mongoose.Types.ObjectId(), __v: 1, ...WHO, ...fields });
    return doc;
}

/** Run the schema's pre-save hooks and return the update a save() would send. */
async function pendingSave(doc) {
    await RealUser.schema.s.hooks.execPre('save', doc, []);
    const [, delta] = doc.$__delta() ?? [null, {}];
    return delta ?? {};
}

const seasonPaths = delta => Object.keys({ ...(delta.$set ?? {}), ...(delta.$unset ?? {}) })
    .filter(p => /^(season|seasonMissions|seasonMissionsDate)(\.|$)/.test(p));

const mission = (id, event, progress = 0, target = 3) =>
    ({ id, event, description: id, target, progress, completed: progress >= target, claimed: false, seasonXp: 10, coinReward: 50 });

const stored = () => mockUsers.get('user-1');

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    mockGuilds.reset();
});

afterEach(() => jest.restoreAllMocks());

// ── The model keeps season progress out of save() ────────────────────────────

describe('save() leaves season progress alone', () => {
    test('a season XP grant is recorded, not written by the save', async () => {
        const doc = loaded({ xp: 1, season: { seasonId: 'pass-9', xp: 150, weekXp: 0, premium: false } });
        await awardSeasonXp(doc, 40, { season: SEASON });
        doc.xp = 2;

        const delta = await pendingSave(doc);

        expect(seasonPaths(delta)).toEqual([]);
        expect(delta.$set.xp).toBe(2);
        expect(doc.$locals.pendingSeasonWrites.xp).toEqual([expect.objectContaining({ amount: 40, seasonId: 'pass-9', weeklyCap: 500 })]);
    });

    test('mission progress is recorded as an advance, not a snapshot of the array', async () => {
        const doc = loaded({ seasonMissions: [mission('m1', 'hunt', 1)], seasonMissionsDate: missionDayStart() });
        recordMissionProgress(doc, 'hunt', 1);

        const delta = await pendingSave(doc);

        expect(seasonPaths(delta)).toEqual([]);
        expect(doc.$locals.pendingSeasonWrites.advances).toEqual({ hunt: 1 });
    });

    test('a whole-season markModified — what the claim paths did — no longer rides the save', async () => {
        const doc = loaded({ season: { seasonId: 'pass-9', xp: 300, premium: false, claimedTiers: [] } });
        doc.season.claimedTiers.push(1);
        doc.markModified('season');

        expect(seasonPaths(await pendingSave(doc))).toEqual([]);
    });

    test('a document stored without the fields does not save their defaults over a concurrent write', async () => {
        // Every user an upsert created has no `seasonMissions` (or `season`, or
        // `activeEffects`) until something writes one. Mongoose fills the schema
        // default on load and saves it — `seasonMissions: []` over the hand
        // /crime just dealt. Default-state paths are detached as well.
        const doc = loaded({ xp: 1 });
        doc.xp = 2;

        const delta = await pendingSave(doc);

        expect(seasonPaths(delta)).toEqual([]);
        expect(Object.keys(delta.$set ?? {}).filter(p => p.startsWith('activeEffects'))).toEqual([]);
        expect(delta.$set.xp).toBe(2);
    });

    test("a new document's insert is left whole", async () => {
        const doc = new RealUser({ ...WHO, season: freshSeason('pass-9') });
        await RealUser.schema.s.hooks.execPre('save', doc, []);
        expect(doc.isModified('season')).toBe(true);
        expect(doc.$locals.pendingSeasonWrites).toBeNull();
    });
});

// ── applySeasonWrites ────────────────────────────────────────────────────────

const xpOp = (amount, over = {}) => ({ amount, seasonId: 'pass-9', weeklyCap: 500, xpPerTier: 100, maxTiers: 50, ...over });
const ops = (over = {}) => ({ reset: null, xp: [], claims: [], deal: null, advances: {}, ...over });

describe('applySeasonWrites', () => {
    test('grants XP server-side and keeps a premium unlock that landed in between', async () => {
        // The flow read premium:false; /season unlock set it true since.
        mockUsers.seed({ ...WHO, season: { seasonId: 'pass-9', xp: 150, tier: 1, premium: true, weekXp: 100, weekStart: new Date(), claimedTiers: [1] } });

        await applySeasonWrites(mockUsers.model, WHO, ops({ xp: [xpOp(40)] }));

        expect(stored().season).toMatchObject({ xp: 190, weekXp: 140, tier: 1, premium: true, claimedTiers: [1] });
    });

    test('applies the weekly cap against the stored week, not the flow\'s copy', async () => {
        mockUsers.seed({ ...WHO, season: { seasonId: 'pass-9', xp: 480, weekXp: 480, weekStart: new Date() } });

        await applySeasonWrites(mockUsers.model, WHO, ops({ xp: [xpOp(40)] }));

        expect(stored().season).toMatchObject({ xp: 500, weekXp: 500, tier: 5 });
    });

    test('rolls an expired week over before granting', async () => {
        mockUsers.seed({ ...WHO, season: { seasonId: 'pass-9', xp: 900, weekXp: 500, weekStart: new Date(Date.now() - 8 * DAY) } });

        await applySeasonWrites(mockUsers.model, WHO, ops({ xp: [xpOp(40)] }));

        expect(stored().season).toMatchObject({ xp: 940, weekXp: 40, tier: 9 });
    });

    test('a grant to a stale season resets it first', async () => {
        mockUsers.seed({ ...WHO, season: { seasonId: 'pass-8', xp: 4000, premium: true, claimedTiers: [1, 2] } });

        await applySeasonWrites(mockUsers.model, WHO, ops({ xp: [xpOp(40)] }));

        expect(stored().season).toMatchObject({ seasonId: 'pass-9', xp: 40, premium: false, claimedTiers: [] });
    });

    test('adds a mission advance to progress another command made, rather than overwriting it', async () => {
        // /crime advanced m1 to 2 while a flow that advanced it by 1 was running.
        mockUsers.seed({ ...WHO, seasonMissions: [mission('m1', 'crime', 2), mission('m2', 'hunt', 0)], seasonMissionsDate: missionDayStart() });

        await applySeasonWrites(mockUsers.model, WHO, ops({ advances: { crime: 1 } }));

        expect(stored().seasonMissions[0]).toMatchObject({ progress: 3, completed: true });
        expect(stored().seasonMissions[1]).toMatchObject({ progress: 0 });
    });

    test("keeps a hand another command dealt today, and advances that one", async () => {
        const today = missionDayStart();
        mockUsers.seed({ ...WHO, seasonMissions: [mission('theirs', 'hunt', 1)], seasonMissionsDate: today });

        await applySeasonWrites(mockUsers.model, WHO, ops({
            deal: { missions: [mission('mine', 'hunt', 0)], date: today },
            advances: { hunt: 1 },
        }));

        expect(stored().seasonMissions).toEqual([expect.objectContaining({ id: 'theirs', progress: 2 })]);
    });

    test('deals the recorded hand when the stored one is stale', async () => {
        mockUsers.seed({ ...WHO, seasonMissions: [mission('old', 'hunt', 3)], seasonMissionsDate: new Date(missionDayStart().getTime() - DAY) });

        await applySeasonWrites(mockUsers.model, WHO, ops({
            deal: { missions: [mission('mine', 'hunt', 0)], date: missionDayStart() },
            advances: { hunt: 1 },
        }));

        expect(stored().seasonMissions).toEqual([expect.objectContaining({ id: 'mine', progress: 1 })]);
    });

    test('records tier claims with $addToSet on the current season', async () => {
        mockUsers.seed({ ...WHO, season: { seasonId: 'pass-9', xp: 300, premium: true, claimedTiers: [1], claimedPremiumTiers: [] } });

        await applySeasonWrites(mockUsers.model, WHO, ops({ claims: [
            { seasonId: 'pass-9', track: 'free', tier: 1 },
            { seasonId: 'pass-9', track: 'free', tier: 2 },
            { seasonId: 'pass-9', track: 'premium', tier: 2 },
        ] }));

        expect(stored().season).toMatchObject({ claimedTiers: [1, 2], claimedPremiumTiers: [2], premium: true });
    });

    test('never throws', async () => {
        const Model = { updateOne: jest.fn().mockRejectedValue(new Error('down')) };
        await expect(applySeasonWrites(Model, WHO, ops({ xp: [xpOp(10)], advances: { hunt: 1 } }))).resolves.toBeUndefined();
    });
});

// ── claimMissionSlot ─────────────────────────────────────────────────────────

describe('claimMissionSlot', () => {
    test('claims a slot once, and not on a hand re-dealt since', async () => {
        const today = missionDayStart();
        const m = mission('m1', 'hunt', 3);
        mockUsers.seed({ ...WHO, seasonMissions: [m], seasonMissionsDate: today });

        expect(await claimMissionSlot(mockUsers.model, WHO, 0, m, today)).toBe(true);
        expect(await claimMissionSlot(mockUsers.model, WHO, 0, m, today)).toBe(false);
        expect(stored().seasonMissions[0].claimed).toBe(true);

        const yesterday = new Date(today.getTime() - DAY);
        expect(await claimMissionSlot(mockUsers.model, WHO, 0, { id: 'm1' }, yesterday)).toBe(false);
    });
});

// ── advanceMissions ──────────────────────────────────────────────────────────

describe('advanceMissions', () => {
    test('opts in to the pipeline update Mongoose 9 otherwise refuses', async () => {
        mockUsers.seed({ ...WHO, seasonMissions: [mission('m1', 'crime', 0)], seasonMissionsDate: missionDayStart() });

        await advanceMissions(mockUsers.model, WHO, 'crime', 1);

        const [, update, options] = mockUsers.model.findOneAndUpdate.mock.calls.at(-1);
        expect(update).toEqual(missionAdvancePipeline('crime', 1));
        expect(options).toMatchObject({ updatePipeline: true });
        expect(stored().seasonMissions[0].progress).toBe(1);
    });

    test('the real model accepts it — the call that used to throw before reaching the server', () => {
        expect(() => RealUser.updateOne(WHO, missionAdvancePipeline('crime', 1), { updatePipeline: true })).not.toThrow();
        expect(() => RealUser.updateOne(WHO, missionAdvancePipeline('crime', 1), {})).toThrow(/updatePipeline/);
    });
});

// ── /season tier-skip ────────────────────────────────────────────────────────

describe('/season tier-skip', () => {
    let season;
    beforeAll(() => {
        jest.doMock('../src/models/User', () => mockUsers.model);
        jest.isolateModules(() => { season = require('../src/commands/economy/season'); });
    });

    test("lands the token's XP on the current season, not a stale one", async () => {
        mockGuilds.seed({ guildId: GUILD, season: { enabled: true, seasonId: 'pass-9' } });
        mockUsers.seed({
            ...WHO,
            season: { seasonId: 'pass-8', xp: 4000, claimedTiers: [1, 2, 3] },
            inventory: [{ itemId: 'tier_skip_token', quantity: 1 }],
        });

        const interaction = makeInteraction({ subcommand: 'tier-skip' });
        await season.execute(interaction);

        expect(stored().season).toMatchObject({ seasonId: 'pass-9', xp: 100, claimedTiers: [] });
        expect(JSON.stringify(interaction.replies)).toContain('Tier Skipped');
    });
});
