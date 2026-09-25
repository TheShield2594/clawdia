'use strict';

// Hunger warning DMs (#1181).
//
// Hunger is only written back when a /pet command runs, so nothing used to
// look at a pet its owner had stopped visiting: the passive switched off around
// day 7, hunger ran out around day 10, and the first the player heard of any of
// it was a public "ran off" message around day 13. This job reads every pet's
// decay-aware hunger and sends its owner one DM per crossing:
//
//   low    below STARVING_THRESHOLD — the passive is off
//   empty  hunger at 0 — it runs away in about RUNAWAY_DAYS days
//
// Each crossing is recorded on the pet (`hungerWarnedLow`/`hungerWarnedEmpty`)
// and claimed with a conditional write before the DM goes out, so a pet left
// alone produces at most two DMs before it runs away. A flag clears once the
// pet is back above that line (feeding clears both at once), so the next
// crossing warns again. A pet found already empty gets the empty warning only,
// and both flags are set. Pets on vacation are skipped: their hunger is paused.
//
// Players opt out with `/notifications pets`, alongside the leaderboard DMs.
//
// Registered in services/scheduler/index.js beside selectPetOfTheWeek.

const User = require('../models/User');
const { handlesGuild } = require('../utils/sharding');
const {
    PET_DEFINITIONS,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    effectiveHunger,
    isOnVacation,
    getPetDisplay,
} = require('./petService');

/**
 * Which warning a pet is due, given its flags: 'empty', 'low' or null. Also
 * says which flags to clear because the pet is back above a line. Pure.
 */
function hungerWarningFor(pet, now = Date.now()) {
    if (!pet || !PET_DEFINITIONS[pet.petId] || isOnVacation(pet, now)) return { due: null, clear: [] };
    const hunger = effectiveHunger(pet, now);
    const clear  = [];
    if (hunger >= STARVING_THRESHOLD && pet.hungerWarnedLow) clear.push('hungerWarnedLow');
    if (hunger > 0 && pet.hungerWarnedEmpty) clear.push('hungerWarnedEmpty');

    let due = null;
    if (hunger <= 0 && !pet.hungerWarnedEmpty) due = 'empty';
    else if (hunger > 0 && hunger < STARVING_THRESHOLD && !pet.hungerWarnedLow) due = 'low';
    return { due, clear };
}

/** One DM line for a warned pet. */
function warningLine(pet, due) {
    const { emoji, name } = getPetDisplay(pet);
    return due === 'empty'
        ? `${emoji} **${name}** has run out of food and **will run away in about ${RUNAWAY_DAYS} days** unless you feed it.`
        : `${emoji} **${name}** is getting hungry — below ${STARVING_THRESHOLD}%, its passive bonus has switched off.`;
}

/** The whole DM for one player in one server. */
function warningMessage(guildName, lines) {
    return [
        `🍖 **Pet check-in from ${guildName ?? 'your server'}**`,
        ...lines,
        '',
        'Feed with `/pet feed`, or pause hunger for up to 14 days with `/pet vacation`. '
            + 'Turn these messages off with `/notifications pets`.',
    ].join('\n');
}

/**
 * Claim a warning on one pet: set its flag if it is not set yet. Resolves true
 * when this run set it — only then is the DM sent.
 */
async function claimWarning(guildId, userId, petId, flag) {
    const res = await User.updateOne(
        { guildId, userId, pets: { $elemMatch: { _id: petId, [flag]: { $ne: true } } } },
        { $set: { [`pets.$[p].${flag}`]: true } },
        { arrayFilters: [{ 'p._id': petId }] },
    );
    return (res?.modifiedCount ?? 0) > 0;
}

/**
 * Check every pet and DM owners whose pets crossed a warning line.
 *
 * @param {import('discord.js').Client} client
 * @param {number} [now]
 * @returns {Promise<{ warned: number, dms: number }>}
 */
async function sendPetHungerWarnings(client, now = Date.now()) {
    let warned = 0;
    let dms    = 0;
    const cursor = User.find(
        { 'pets.0': { $exists: true }, 'notifications.pets.hunger': { $ne: false } },
        { userId: 1, guildId: 1, pets: 1 },
    ).lean().cursor();

    for await (const doc of cursor) {
        if (!handlesGuild(doc.guildId, client)) continue;
        try {
            const lines = [];
            for (const pet of doc.pets ?? []) {
                const { due, clear } = hungerWarningFor(pet, now);
                if (clear.length) {
                    await User.updateOne(
                        { guildId: doc.guildId, userId: doc.userId },
                        { $set: Object.fromEntries(clear.map(f => [`pets.$[p].${f}`, false])) },
                        { arrayFilters: [{ 'p._id': pet._id }] },
                    );
                }
                if (!due) continue;
                // An empty pet was also below the threshold, so it takes both
                // flags — the low warning would only arrive after the worse news.
                const claimed = await claimWarning(doc.guildId, doc.userId, pet._id, due === 'empty' ? 'hungerWarnedEmpty' : 'hungerWarnedLow');
                if (!claimed) continue;
                if (due === 'empty') await claimWarning(doc.guildId, doc.userId, pet._id, 'hungerWarnedLow');
                lines.push(warningLine(pet, due));
                warned++;
            }
            if (!lines.length) continue;

            const target = await client.users.fetch(doc.userId).catch(() => null);
            if (!target) continue;
            const guildName = client.guilds?.cache?.get(doc.guildId)?.name;
            const sent = await target.send({ content: warningMessage(guildName, lines), allowedMentions: { parse: [] } })
                .then(() => true, () => false);
            if (sent) dms++;
        } catch (err) {
            console.error(`[pet] hunger warning failed for ${doc.userId} in ${doc.guildId}:`, err.message);
        }
    }
    return { warned, dms };
}

module.exports = { sendPetHungerWarnings, hungerWarningFor, warningLine, warningMessage };
