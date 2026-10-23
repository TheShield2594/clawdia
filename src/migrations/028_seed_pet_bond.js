const mongoose = require('mongoose');

/**
 * Seeds the stored `bond` every pet now carries (#1186).
 *
 * Bond used to be computed as days since `adoptedAt`. It is now a 0–100 value
 * that care raises and neglect lowers, and a pet with no stored value would
 * read as 0 — resetting every long-time owner to a stranger overnight. So each
 * existing pet starts from its age instead: one point per two days kept,
 * capped at 50. The cap sits below the two top tiers (Devoted at 60, Soulbound
 * at 90), which stay something to earn by caring rather than by waiting.
 *
 * Pets in the memorial (`deceasedPets`) are seeded from the age they reached
 * before running away, less the 25 points running away now costs, so a Revive
 * Scroll brings one back where the live rules would have left it.
 *
 * The rule is written out here rather than imported from petService, so a
 * later retune of bond there cannot change what this migration did.
 *
 * The raw driver, as in migrations 011, 022 and 026: a Mongoose `save()` would
 * revalidate every unrelated field on the document, and array positions are
 * stable because migrations run at boot, before the bot logs in and before the
 * dashboard opens its port. Only pets with no `bond` at all are written, so a
 * rerun after a partial pass fills in the rest and touches nothing it did.
 */

const MS_PER_DAY      = 86_400_000;
const DAYS_PER_POINT  = 2;
const SEED_CAP        = 50;
const RUNAWAY_PENALTY = 25;

function seedFromAge(adoptedAt, until) {
    const from = adoptedAt ? new Date(adoptedAt).getTime() : NaN;
    const to   = until ? new Date(until).getTime() : NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
    const days = Math.max(0, (to - from) / MS_PER_DAY);
    return Math.min(SEED_CAP, Math.floor(days / DAYS_PER_POINT));
}

const missingBond = { $elemMatch: { bond: { $exists: false } } };

module.exports = {
    name: '028_seed_pet_bond',

    async up({ timeoutMs } = {}) {
        const users = mongoose.connection.db.collection('users');
        const now   = new Date();

        const cursor = users.find(
            { $or: [{ pets: missingBond }, { deceasedPets: missingBond }] },
            {
                projection: { _id: 1, 'pets.adoptedAt': 1, 'pets.bond': 1, 'deceasedPets.adoptedAt': 1, 'deceasedPets.bond': 1, 'deceasedPets.diedAt': 1 },
                ...(timeoutMs ? { maxTimeMS: timeoutMs } : {}),
            },
        );

        let petsSeeded = 0;
        for await (const user of cursor) {
            const set = {};
            (user.pets ?? []).forEach((pet, i) => {
                if (pet?.bond !== undefined) return;
                set[`pets.${i}.bond`] = seedFromAge(pet?.adoptedAt, now);
            });
            (user.deceasedPets ?? []).forEach((pet, i) => {
                if (pet?.bond !== undefined) return;
                const seeded = seedFromAge(pet?.adoptedAt, pet?.diedAt ?? now);
                set[`deceasedPets.${i}.bond`] = Math.max(0, seeded - RUNAWAY_PENALTY);
            });
            if (!Object.keys(set).length) continue;
            const result = await users.updateOne({ _id: user._id }, { $set: set });
            if (result.modifiedCount) petsSeeded += Object.keys(set).length;
        }

        if (petsSeeded > 0) console.log(`[MIGRATIONS] 028: seeded bond for ${petsSeeded} pet(s).`);
    },

    // Drops the stored bond and its daily-cap fields. The code before this
    // migration never read them, so this returns it to age-based bond; any
    // bond earned since is lost with them.
    async down({ timeoutMs } = {}) {
        const users = mongoose.connection.db.collection('users');
        const opts  = timeoutMs ? { maxTimeMS: timeoutMs } : {};
        for (const path of ['pets', 'deceasedPets']) {
            const unset = {};
            for (const field of ['bond', 'bondDay', 'bondToday']) unset[`${path}.$[].${field}`] = '';
            await users.updateMany({ [`${path}.0`]: { $exists: true } }, { $unset: unset }, opts);
        }
    },

    __test__: { seedFromAge },
};
