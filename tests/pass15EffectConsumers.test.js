'use strict';

/**
 * #873, pass 15 — the effect consumers.
 *
 * Pass 14 made activating an effect one guarded write, and recorded the other
 * half as its bound: everything that *spends* an effect did it on a loaded
 * document and persisted it through `save()`, which writes `activeEffects` back
 * as the array the flow read. With `optimisticConcurrency` on, that looks
 * protected and is not — atomic updates do not bump `__v`, so a snapshot save
 * silently erased an activation, a spend or a `/war` booster that landed in
 * between. And it was wider than the consumers: `pruneEffects` reassigns the
 * array whenever an entry has expired, so any flow that merely *checked* an
 * effect and then saved did the same.
 *
 * The fix has two halves, and this suite holds both:
 *
 *   - the User model never writes `activeEffects` through `save()`. Its
 *     pre-save hook strips the paths; the charges a flow spent in memory are
 *     committed by the post-save hook as guarded `$inc`s (models/effectSpends);
 *   - the flows that decide under a compare-and-set — `/rob`, `/crime` — claim
 *     the charge in that same write (`spendEffectCharge`).
 */

const mongoose = require('mongoose');
const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction } = require('./helpers/fakeInteraction');

const mockUsers = fakeCollection('User', {
    balance: 0, bank: 0, inventory: [], activeEffects: [], pets: [], successfulRobs: 0, failedRobs: 0,
});
const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });

jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));
jest.mock('../src/services/achievementService', () => ({
    checkAndAward: jest.fn(async () => []),
    announceAchievements: jest.fn(),
}));

// The real User model is needed for the hook tests; the command tests swap
// `/rob`'s view of it for the fake store below.
const RealUser = jest.requireActual('../src/models/User');
const { detachEffectWrites, applyEffectSpends } = require('../src/models/effectSpends');
const { hasEffect, consumeEffect, refundEffectCharge, spendEffectCharge } = require('../src/services/effectsService');
const { delay } = require('../src/utils/delay');

const GUILD = 'guild-1';
const WHO = { userId: 'user-1', guildId: GUILD };
const HOUR = 3_600_000;

/** A User document as a query returns it: existing, with `__v`, nothing modified. */
function loaded(fields) {
    const doc = new RealUser();
    doc.init({ _id: new mongoose.Types.ObjectId(), __v: 2, ...WHO, ...fields });
    return doc;
}

/** The update a `save()` of `doc` would send, after the schema's pre-save hooks. */
async function pendingSave(doc) {
    await RealUser.schema.s.hooks.execPre('save', doc, []);
    const [, delta] = doc.$__delta() ?? [null, {}];
    return delta;
}

const effectPaths = delta => Object.keys({ ...(delta.$set ?? {}), ...(delta.$unset ?? {}) })
    .filter(p => p === 'activeEffects' || p.startsWith('activeEffects.'));

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockUsers.reset();
    mockGuilds.reset();
});

afterEach(() => jest.restoreAllMocks());

// ── The model never writes activeEffects through save() ──────────────────────

describe('save() leaves activeEffects alone', () => {
    test('checking an effect while another has expired no longer rewrites the array', async () => {
        const doc = loaded({ xp: 1, activeEffects: [
            { type: 'shield', expiresAt: new Date(Date.now() - 1000), charges: -1 },
            { type: 'knife', expiresAt: new Date(Date.now() + HOUR), charges: -1 },
        ] });
        hasEffect(doc, 'knife');                // prunes the expired shield in memory
        doc.xp = 5;

        const delta = await pendingSave(doc);

        expect(effectPaths(delta)).toEqual([]);
        expect(delta.$set.xp).toBe(5);
    });

    test('spending a last charge no longer writes the array, and is held for after the save', async () => {
        const doc = loaded({ activeEffects: [{ type: 'lifesaver', expiresAt: null, charges: 1 }] });
        consumeEffect(doc, 'lifesaver');
        doc.xp = 3;

        const delta = await pendingSave(doc);

        expect(effectPaths(delta)).toEqual([]);
        expect(doc.$locals.pendingEffectSpends).toEqual({ lifesaver: 1 });
    });

    test('a spend the flow refunds nets to nothing to commit', async () => {
        const doc = loaded({ activeEffects: [{ type: 'voidsteel_cache', expiresAt: null, charges: 5 }] });
        consumeEffect(doc, 'voidsteel_cache');
        refundEffectCharge(doc, 'voidsteel_cache');

        await pendingSave(doc);

        expect(doc.$locals.pendingEffectSpends).toBeNull();
    });

    test("a new document's insert is left whole", () => {
        const doc = new RealUser({ ...WHO, activeEffects: [{ type: 'shield', expiresAt: null, charges: -1 }] });
        expect(detachEffectWrites(doc)).toBeNull();
        expect(doc.isModified('activeEffects')).toBe(true);
    });

    test('the post-save hook commits the held spends as guarded writes', async () => {
        const doc = loaded({ activeEffects: [{ type: 'lifesaver', expiresAt: null, charges: 1 }] });
        consumeEffect(doc, 'lifesaver');
        await pendingSave(doc);
        const updateOne = jest.spyOn(RealUser, 'updateOne').mockResolvedValue({ matchedCount: 1 });

        await RealUser.schema.s.hooks.execPost('save', doc, [doc]);

        expect(updateOne).toHaveBeenCalledWith(
            { ...WHO, activeEffects: { $elemMatch: { type: 'lifesaver', charges: { $gte: 1 } } } },
            { $inc: { 'activeEffects.$.charges': -1 } },
        );
        expect(doc.$locals.pendingEffectSpends).toBeNull();
    });
});

// ── applyEffectSpends ────────────────────────────────────────────────────────

describe('applyEffectSpends', () => {
    test('decrements the stored charge, and removes the entry once it is empty', async () => {
        mockUsers.seed({ ...WHO, activeEffects: [
            { type: 'ghost_ledger', expiresAt: null, charges: 3 },
            { type: 'lifesaver', expiresAt: null, charges: 1 },
        ] });

        const results = await applyEffectSpends(mockUsers.model, WHO, { ghost_ledger: 1, lifesaver: 1 });

        expect(results).toEqual({ ghost_ledger: 'spent', lifesaver: 'spent' });
        expect(mockUsers.get('user-1').activeEffects).toEqual([
            expect.objectContaining({ type: 'ghost_ledger', charges: 2 }),
        ]);
    });

    test('keeps an effect activated since the read, which a snapshot save erased', async () => {
        // The flow read [lifesaver] and spent it; a /use landed a shield in between.
        mockUsers.seed({ ...WHO, activeEffects: [
            { type: 'lifesaver', expiresAt: null, charges: 1 },
            { type: 'shield', expiresAt: new Date(Date.now() + HOUR), charges: -1 },
        ] });

        await applyEffectSpends(mockUsers.model, WHO, { lifesaver: 1 });

        expect(mockUsers.get('user-1').activeEffects.map(e => e.type)).toEqual(['shield']);
    });

    test('a charge already gone is not driven below zero', async () => {
        mockUsers.seed({ ...WHO, activeEffects: [] });

        const results = await applyEffectSpends(mockUsers.model, WHO, { padlock: 1 });

        expect(results).toEqual({ padlock: 'gone' });
        expect(mockUsers.get('user-1').activeEffects).toEqual([]);
    });

    test('a net refund puts back an effect whose last charge was spent elsewhere', async () => {
        mockUsers.seed({ ...WHO, activeEffects: [] });

        const results = await applyEffectSpends(mockUsers.model, WHO, { silvered_talisman: -1 });

        expect(results).toEqual({ silvered_talisman: 'refunded' });
        expect(mockUsers.get('user-1').activeEffects).toEqual([
            expect.objectContaining({ type: 'silvered_talisman', charges: 1 }),
        ]);
    });

    test('a refund never pushes a charge count past the full one', async () => {
        mockUsers.seed({ ...WHO, activeEffects: [{ type: 'silvered_talisman', expiresAt: null, charges: 5 }] });

        const results = await applyEffectSpends(mockUsers.model, WHO, { silvered_talisman: -1 });

        expect(results).toEqual({ silvered_talisman: 'full' });
        expect(mockUsers.get('user-1').activeEffects).toEqual([
            expect.objectContaining({ type: 'silvered_talisman', charges: 5 }),
        ]);
    });

    test('never throws', async () => {
        const Model = { updateOne: jest.fn().mockRejectedValue(new Error('down')) };
        await expect(applyEffectSpends(Model, WHO, { padlock: 1 })).resolves.toEqual({ padlock: 'failed' });
    });
});

// ── spendEffectCharge ────────────────────────────────────────────────────────

describe('spendEffectCharge', () => {
    test('spends one charge and prunes the empty entry', async () => {
        mockUsers.seed({ ...WHO, activeEffects: [{ type: 'phantom_token', expiresAt: null, charges: 1 }] });

        expect(await spendEffectCharge(mockUsers.model, WHO, 'phantom_token')).not.toBeNull();
        expect(mockUsers.get('user-1').activeEffects).toEqual([]);
    });

    test('two racing spends of one charge: exactly one lands', async () => {
        mockUsers.seed({ ...WHO, activeEffects: [{ type: 'lifesaver', expiresAt: null, charges: 1 }] });

        const results = await Promise.all([
            spendEffectCharge(mockUsers.model, WHO, 'lifesaver'),
            spendEffectCharge(mockUsers.model, WHO, 'lifesaver'),
        ]);

        expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('an unlimited effect is only checked for being live', async () => {
        mockUsers.seed({ ...WHO, activeEffects: [
            { type: 'knife', expiresAt: new Date(Date.now() + HOUR), charges: -1 },
            { type: 'shield', expiresAt: new Date(Date.now() - 1000), charges: -1 },
        ] });

        expect(await spendEffectCharge(mockUsers.model, WHO, 'knife')).not.toBeNull();
        expect(await spendEffectCharge(mockUsers.model, WHO, 'shield')).toBeNull();
        expect(mockUsers.get('user-1').activeEffects.find(e => e.type === 'knife').charges).toBe(-1);
    });

    test('rides a caller condition and update in the same write', async () => {
        mockUsers.seed({ ...WHO, lastRob: null, activeEffects: [{ type: 'lifesaver', expiresAt: null, charges: 1 }] });
        const at = new Date();

        const lost = await spendEffectCharge(mockUsers.model, WHO, 'lifesaver', {
            cond: { lastRob: new Date(0) }, update: { $set: { lastRob: at } },
        });
        expect(lost).toBeNull();
        expect(mockUsers.get('user-1').activeEffects).toHaveLength(1);

        const won = await spendEffectCharge(mockUsers.model, WHO, 'lifesaver', {
            cond: { lastRob: null }, update: { $set: { lastRob: at } },
        });
        expect(won.lastRob).toEqual(at);
        expect(mockUsers.get('user-1').activeEffects).toEqual([]);
    });
});

// ── /rob ─────────────────────────────────────────────────────────────────────

describe('/rob', () => {
    let rob;
    beforeAll(() => {
        jest.doMock('../src/models/User', () => mockUsers.model);
        jest.isolateModules(() => { rob = require('../src/commands/economy/rob/attempt'); });
    });

    const OLD = Date.now() - 365 * 24 * HOUR;
    const seedRob = ({ robber = {}, victim = {} } = {}) => {
        mockGuilds.seed({ guildId: GUILD, economy: { currency: '💰', enabled: true, robEnabled: true, robMinWallet: 100, robFailFineRate: 0.2 } });
        mockUsers.seed({ userId: 'robber', guildId: GUILD, balance: 1000, lastRob: null, ...robber });
        mockUsers.seed({ userId: 'victim', guildId: GUILD, balance: 5000, bank: 5000, lastRobbedAt: null, ...victim });
    };
    const attempt = async () => {
        const interaction = makeInteraction({
            userId: 'robber',
            options: { target: { id: 'victim', username: 'victim', bot: false, createdTimestamp: OLD } },
        });
        interaction.user.createdTimestamp = OLD;
        await rob.execute(interaction);
        return interaction;
    };
    const shown = interaction => JSON.stringify(interaction.replies);

    test("a rob no longer writes the victim's effects back from its snapshot", async () => {
        seedRob();
        jest.spyOn(Math, 'random').mockReturnValue(0.01);   // success
        // The victim activates a shield while the robber is picking the lock.
        delay.mockImplementationOnce(async () => {
            mockUsers.get('victim').activeEffects.push({ type: 'shield', expiresAt: new Date(Date.now() + HOUR), charges: -1 });
        });

        const interaction = await attempt();

        expect(shown(interaction)).toContain('Successful Heist');
        expect(mockUsers.get('victim').activeEffects.map(e => e.type)).toEqual(['shield']);
        expect(mockUsers.writes.some(w => w.update?.$set?.activeEffects)).toBe(false);
    });

    test('a padlock is spent in the write that protects the bank', async () => {
        seedRob({ victim: { activeEffects: [{ type: 'padlock', expiresAt: null, charges: 1 }] } });
        jest.spyOn(Math, 'random').mockReturnValue(0.01);

        await attempt();

        const victim = mockUsers.get('victim');
        expect(victim.bank).toBe(5000);
        expect(victim.balance).toBeLessThan(5000);
        expect(victim.activeEffects).toEqual([]);
        const heist = mockUsers.writes.find(w => w.doc === 'victim' && w.update?.$inc?.['activeEffects.$.charges'] === -1);
        expect(heist.query.activeEffects).toEqual({ $elemMatch: { type: 'padlock', charges: { $gt: 0 } } });
        expect(heist.update.$inc.balance).toBeLessThan(0);
    });

    test('a padlock gone since the read calls the rob off rather than taking the bank', async () => {
        seedRob({ victim: { activeEffects: [{ type: 'padlock', expiresAt: null, charges: 1 }] } });
        jest.spyOn(Math, 'random').mockReturnValue(0.01);
        delay.mockImplementationOnce(async () => { mockUsers.get('victim').activeEffects = []; });

        const interaction = await attempt();

        expect(shown(interaction)).toContain("target's balance shifted");
        expect(mockUsers.get('victim')).toMatchObject({ balance: 5000, bank: 5000 });
        expect(mockUsers.get('robber').balance).toBe(1000);
    });

    test('a fine absorber is spent with the cooldown claim, not a save()', async () => {
        seedRob({ robber: { activeEffects: [{ type: 'ghost_ledger', expiresAt: null, charges: 3 }] } });
        jest.spyOn(Math, 'random').mockReturnValue(0.99);   // caught

        const interaction = await attempt();

        expect(shown(interaction)).toContain('Ghost Ledger');
        expect(shown(interaction)).toContain('2 uses left');
        const robber = mockUsers.get('robber');
        expect(robber.balance).toBe(1000);
        expect(robber.activeEffects).toEqual([expect.objectContaining({ type: 'ghost_ledger', charges: 2 })]);
        expect(robber.lastRob).toBeInstanceOf(Date);
        expect(mockUsers.writes.some(w => w.op === 'save')).toBe(false);
    });

    test('two parallel failed robs cannot both be absorbed by one charge', async () => {
        seedRob({ robber: { activeEffects: [{ type: 'phantom_token', expiresAt: null, charges: 1 }] } });
        jest.spyOn(Math, 'random').mockReturnValue(0.99);

        const [a, b] = await Promise.all([attempt(), attempt()]);

        const texts = [shown(a), shown(b)];
        expect(texts.filter(t => t.includes('Fine Erased'))).toHaveLength(1);
        expect(texts.filter(t => t.includes('Duplicate rob attempt'))).toHaveLength(1);
        expect(mockUsers.get('robber').activeEffects).toEqual([]);
    });

    test('an absorber gone since the read falls through to the ordinary fine', async () => {
        seedRob({ robber: { activeEffects: [{ type: 'lifesaver', expiresAt: null, charges: 1 }] } });
        jest.spyOn(Math, 'random').mockReturnValue(0.99);
        delay.mockImplementationOnce(async () => { mockUsers.get('robber').activeEffects = []; });

        const interaction = await attempt();

        expect(shown(interaction)).toContain('Caught Red-Handed');
        expect(mockUsers.get('robber').balance).toBe(800);
        expect(mockUsers.get('victim').balance).toBe(5200);
    });
});

// ── /crime ───────────────────────────────────────────────────────────────────

describe('/crime', () => {
    const src = require('fs').readFileSync(require.resolve('../src/commands/economy/crime'), 'utf8');

    test('claims the lifesaver in a guarded write at the decision', () => {
        expect(src).toMatch(/hasEffect\(user, 'lifesaver'\)\s*&& !!\(await spendEffectCharge\(User, userFilter, 'lifesaver'\)\)/);
        expect(src).not.toMatch(/consumeEffect/);
    });

    test('no longer writes the effects array it read', () => {
        expect(src).not.toMatch(/activeEffects:\s*user\.activeEffects/);
    });
});
