'use strict';

jest.mock('../src/models/GrindProfile', () => {
    function MockGrindProfile(fields) {
        Object.assign(this, fields);
        this.isNew = true;
        this.saved = 0;
        this.modifiedPaths = [];
    }
    MockGrindProfile.prototype.markModified = function (p) { this.modifiedPaths.push(p); };
    MockGrindProfile.prototype.save = async function () { this.saved += 1; this.isNew = false; return this; };
    MockGrindProfile.find = jest.fn().mockResolvedValue([]);
    return MockGrindProfile;
});

const GrindProfile = require('../src/models/GrindProfile');
const { attachGrind, saveGrind, persistGrindIfNew, GRIND_SYSTEMS } = require('../src/utils/grindProfile');

function makeUser() {
    return {
        userId: 'u1',
        guildId: 'g1',
        balance: 100,
        save: jest.fn().mockResolvedValue('user-saved'),
        markModified: jest.fn(),
    };
}

beforeEach(() => {
    GrindProfile.find.mockReset().mockResolvedValue([]);
});

describe('attachGrind', () => {
    test('returns null user untouched', async () => {
        expect(await attachGrind(null)).toBeNull();
    });

    test('attaches existing profile data under legacy property names', async () => {
        const prof = new GrindProfile({ guildId: 'g1', userId: 'u1', system: 'fishing', data: { xp: 42 } });
        prof.isNew = false;
        GrindProfile.find.mockResolvedValue([prof]);

        const user = makeUser();
        await attachGrind(user);

        expect(user.fishing).toEqual({ xp: 42 });
        expect(user.hunt).toBeUndefined();      // no profile yet — ensure*Data will backfill
        expect(user._grindProfiles.fishing).toBe(prof);
    });

    test('is idempotent — second call does not re-query attached systems', async () => {
        const user = makeUser();
        await attachGrind(user);
        expect(GrindProfile.find).toHaveBeenCalledTimes(1);
        await attachGrind(user);
        expect(GrindProfile.find).toHaveBeenCalledTimes(1);
    });
});

describe('wrapped save', () => {
    test('user.save() co-saves profiles mutated through the legacy property', async () => {
        const user = makeUser();
        await attachGrind(user);

        // Simulate ensureFishingData + a cast: replace and mutate the property
        user.fishing = { xp: 10, stamina: 9 };
        await user.save();

        const prof = user._grindProfiles.fishing;
        expect(prof.saved).toBe(1);
        expect(prof.data).toEqual({ xp: 10, stamina: 9 });
        expect(prof.modifiedPaths).toContain('data');
    });

    test('untouched empty profiles are not persisted', async () => {
        const user = makeUser();
        await attachGrind(user);
        await user.save();
        for (const system of GRIND_SYSTEMS) {
            expect(user._grindProfiles[system].saved).toBe(0);
        }
    });

    test('save wrap is applied once even with repeated attach', async () => {
        const user = makeUser();
        await attachGrind(user);
        await attachGrind(user);
        user.fishing = { xp: 1 };
        await user.save();
        expect(user._grindProfiles.fishing.saved).toBe(1);
    });
});

describe('persistGrindIfNew', () => {
    test('persists a new profile that has data', async () => {
        const user = makeUser();
        await attachGrind(user);
        user.mining = { level: 3 };
        await persistGrindIfNew(user, 'mining');
        expect(user._grindProfiles.mining.saved).toBe(1);
    });

    test('skips already-persisted profiles', async () => {
        const prof = new GrindProfile({ guildId: 'g1', userId: 'u1', system: 'mining', data: { level: 3 } });
        prof.isNew = false;
        GrindProfile.find.mockResolvedValue([prof]);

        const user = makeUser();
        await attachGrind(user);
        await persistGrindIfNew(user, 'mining');
        expect(prof.saved).toBe(0);
    });
});

describe('saveGrind', () => {
    test('syncs prof.data from the user property before saving', async () => {
        const prof = new GrindProfile({ guildId: 'g1', userId: 'u1', system: 'hunt', data: { xp: 1 } });
        prof.isNew = false;
        GrindProfile.find.mockResolvedValue([prof]);

        const user = makeUser();
        await attachGrind(user);
        user.hunt.xp = 99;
        await saveGrind(user, ['hunt']);
        expect(prof.data.xp).toBe(99);
        expect(prof.saved).toBe(1);
    });
});

describe('a save only writes what the flow changed', () => {
    // Profiles are persisted by replacing the whole `data` document. Writing back a
    // system the flow merely attached for a cross-system read would push a load-time
    // snapshot over anything that changed in between — which is how an unrelated
    // /fish cast could undo a /mine raid's material transfer.
    function existing(system, data) {
        const prof = new GrindProfile({ userId: 'u1', guildId: 'g1', system });
        prof.data = data;
        prof.isNew = false;
        return prof;
    }

    test('an attached but untouched system is left alone', async () => {
        GrindProfile.find.mockResolvedValue([
            existing('fishing', { xp: 1 }),
            existing('mining', { materials: { gold_nugget: 10 } }),
        ]);
        const user = makeUser();
        await attachGrind(user);

        user.fishing.xp = 2;
        await user.save();

        expect(user._grindProfiles.fishing.saved).toBe(1);
        expect(user._grindProfiles.mining.saved).toBe(0);
        expect(user._grindProfiles.mining.data.materials.gold_nugget).toBe(10);
    });

    test('a system the flow did change is written', async () => {
        GrindProfile.find.mockResolvedValue([existing('mining', { materials: { gold_nugget: 10 } })]);
        const user = makeUser();
        await attachGrind(user);

        user.mining.materials.gold_nugget = 7;
        await user.save();

        expect(user._grindProfiles.mining.saved).toBe(1);
        expect(user._grindProfiles.mining.data.materials.gold_nugget).toBe(7);
    });

    test('replacing the property wholesale still counts as a change', async () => {
        GrindProfile.find.mockResolvedValue([existing('mining', { xp: 1 })]);
        const user = makeUser();
        await attachGrind(user);

        user.mining = { xp: 1, level: 2 };   // what an ensure*Data rebuild looks like
        await user.save();

        expect(user._grindProfiles.mining.saved).toBe(1);
    });

    test('an explicit system list still forces the write', async () => {
        GrindProfile.find.mockResolvedValue([existing('mining', { xp: 1 })]);
        const user = makeUser();
        await attachGrind(user);

        await saveGrind(user, ['mining']);
        expect(user._grindProfiles.mining.saved).toBe(1);
    });

    test('a repeat save does not rewrite a profile that has not moved since', async () => {
        GrindProfile.find.mockResolvedValue([existing('mining', { xp: 1 })]);
        const user = makeUser();
        await attachGrind(user);

        user.mining.xp = 2;
        await user.save();
        expect(user._grindProfiles.mining.saved).toBe(1);

        await user.save();
        expect(user._grindProfiles.mining.saved).toBe(1);
    });
});
