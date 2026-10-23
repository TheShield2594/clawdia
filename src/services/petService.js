const Guild = require('../models/Guild');
const User  = require('../models/User');
const { handlesGuild } = require('../utils/sharding');
const { postAnnouncement } = require('../utils/guildAnnounce');
const COLORS = require('../utils/embedColors');

// Personality traits assigned randomly on adoption
const PERSONALITY_TRAITS = {
    lazy:        { label: 'Lazy',        emoji: '😴', desc: 'Perfectly content doing absolutely nothing.' },
    energetic:   { label: 'Energetic',   emoji: '⚡', desc: 'Always ready for action, sometimes too ready.' },
    mischievous: { label: 'Mischievous', emoji: '😈', desc: 'Has a talent for finding trouble.' },
    loyal:       { label: 'Loyal',       emoji: '🛡️', desc: 'Would follow you to the ends of the earth.' },
};

const PERSONALITY_KEYS = Object.keys(PERSONALITY_TRAITS);

function assignPersonality() {
    return PERSONALITY_KEYS[Math.floor(Math.random() * PERSONALITY_KEYS.length)];
}

// Flavor lines used in hunt/fish/mine command descriptions
const TRAIT_FLAVOR = {
    lazy: {
        hunt: (name, emoji) => `${emoji} **${name}** yawns and stretches before reluctantly helping out.`,
        fish: (name, emoji) => `${emoji} **${name}** naps nearby while the line bobs lazily in the water.`,
        mine: (name, emoji) => `${emoji} **${name}** watches from a safe distance, conserving energy.`,
        explore: (name, emoji) => `${emoji} **${name}** rides along in your pack, peeking out now and then.`,
    },
    energetic: {
        hunt: (name, emoji) => `${emoji} **${name}** races ahead, picking up a trail before you even start!`,
        fish: (name, emoji) => `${emoji} **${name}** splashes excitedly, nudging fish toward your hook!`,
        mine: (name, emoji) => `${emoji} **${name}** digs alongside you with boundless enthusiasm!`,
        explore: (name, emoji) => `${emoji} **${name}** scouts ahead and doubles back to hurry you along!`,
    },
    mischievous: {
        hunt: (name, emoji) => `${emoji} **${name}** keeps watch while you case the area... suspiciously well.`,
        fish: (name, emoji) => `${emoji} **${name}** nudges your rod just enough to keep things interesting.`,
        mine: (name, emoji) => `${emoji} **${name}** "accidentally" dislodges a promising-looking boulder.`,
        explore: (name, emoji) => `${emoji} **${name}** wanders off and comes back with something it definitely shouldn't have.`,
    },
    loyal: {
        hunt: (name, emoji) => `${emoji} **${name}** stays close, alert for any sign of danger.`,
        fish: (name, emoji) => `${emoji} **${name}** watches the line intently, refusing to look away.`,
        mine: (name, emoji) => `${emoji} **${name}** stands guard at the tunnel entrance, unwavering.`,
        explore: (name, emoji) => `${emoji} **${name}** never lets you out of sight on the trail.`,
    },
};

// Pet definitions: passive bonuses and feeding materials
const PET_DEFINITIONS = {
    dog:          { petId: 'dog',         emoji: '🐶', name: 'Dog',         cost: 2000,  purchasable: true,  bonusType: 'work_earnings',    bonusPct: 5,  favoriteMaterial: 'rabbits_foot',  materialSource: 'hunt' },
    cat:          { petId: 'cat',         emoji: '🐱', name: 'Cat',         cost: 2000,  purchasable: true,  bonusType: 'crime_success',     bonusPct: 5,  favoriteMaterial: 'feather',        materialSource: 'hunt' },
    bird:         { petId: 'bird',        emoji: '🐦', name: 'Bird',        cost: 3000,  purchasable: true,  bonusType: 'xp_gain',           bonusPct: 10, favoriteMaterial: 'acorn_cache',    materialSource: 'hunt' },
    fish:         { petId: 'fish',        emoji: '🐠', name: 'Fish',        cost: 3000,  purchasable: true,  bonusType: 'fish_yield',        bonusPct: 5,  favoriteMaterial: 'fish_scale',     materialSource: 'fish' },
    fox:          { petId: 'fox',         emoji: '🦊', name: 'Fox',         cost: 5000,  purchasable: true,  bonusType: 'rob_success',       bonusPct: 8,  favoriteMaterial: 'coyote_fang',    materialSource: 'hunt' },
    wolf:         { petId: 'wolf',        emoji: '🐺', name: 'Wolf',        cost: 8000,  purchasable: true,  bonusType: 'hunt_yield',        bonusPct: 10, favoriteMaterial: 'wolf_pelt',      materialSource: 'hunt' },
    eagle:        { petId: 'eagle',       emoji: '🦅', name: 'Eagle',       cost: null,  purchasable: false, bonusType: 'hunt_xp',           bonusPct: 15, favoriteMaterial: 'eagle_talon',    materialSource: 'hunt' },
    shark:        { petId: 'shark',       emoji: '🦈', name: 'Shark',       cost: null,  purchasable: false, bonusType: 'fish_yield',        bonusPct: 15, favoriteMaterial: 'shark_tooth',    materialSource: 'fish' },
    crystal_fox:  { petId: 'crystal_fox', emoji: '💎', name: 'Crystal Fox', cost: null,  purchasable: false, bonusType: 'mine_yield',        bonusPct: 15, favoriteMaterial: 'crystal_sliver', materialSource: 'mine' },
    lantern_owl:  { petId: 'lantern_owl', emoji: '🦉', name: 'Lantern Owl', cost: null,  purchasable: false, bonusType: 'explore_xp',        bonusPct: 15, favoriteMaterial: 'lantern_glass',  materialSource: 'explore' }
};

// ── Acquisition ───────────────────────────────────────────────────────────────
//
// Purchasable pets come from /pet adopt. The four rare pets are not sold
// anywhere: each is tied to one grind system via its materialSource and only
// ever turns up alongside a legendary-tier result there.
//
// The Lantern Owl was the last one added (#753), and it could not be added
// earlier for a reason worth keeping written down: a rare companion needs a
// favourite food, `feedPet` matches that food by id against MATERIAL_RARITY,
// and exploration produced no materials at all — only coins, Explorer XP and
// relics. Relics were the wrong thing to point it at, since the relic case pays
// a standing bonus on *distinct* relics and eating a duplicate would delete
// part of it. Exploration got its own fieldcraft materials first; the owl
// follows from them.
//
// Its bonus is Explorer XP rather than another yield multiplier on purpose:
// exploration coin payouts already run through a rolling daily cap and two
// standing bonuses (the relic case and a surveyed-map bonus), so a coin
// multiplier there compounds into something the cap then eats anyway.

const RARE_PET_DROP_CHANCE = 0.04;

/** The unpurchasable companion tied to a grind system ('hunt'|'fish'|'mine'|'explore'). */
function rarePetForSource(source) {
    return Object.values(PET_DEFINITIONS)
        .find(d => !d.purchasable && d.materialSource === source) ?? null;
}

const PET_NAME_MAX = 32;

/**
 * A player-chosen pet name made safe to print anywhere a name goes: embeds,
 * public messages, autocomplete labels and the canvas card.
 *
 * Mentions are removed (a pet named `<@id>` pinged that member whenever its
 * name was posted), as are the characters Discord reads as formatting, which
 * let a name break out of the bold around it. Underscores become spaces so
 * `sir_fluff` still reads as a name. Returns '' when nothing usable is left.
 */
function sanitizePetName(raw) {
    return String(raw ?? '')
        .replace(/<(?:@[!&]?|#|\/[^:>]*:)\d*>/g, '')   // user, role, channel and command mentions
        .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\u200D' ? ch : ' ')) // controls/newlines; keep emoji joiners
        .replace(/_/g, ' ')
        .replace(/[*~`|\\<>@#[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PET_NAME_MAX)
        .trim();
}

/** A fresh pet document. Shared by /pet adopt and rare drops so they can't drift. */
function createPet(petId, { name = null, now = new Date() } = {}) {
    return {
        petId,
        name,
        hunger: 100,
        lastFed: now,
        lastDecayAt: now,
        adoptedAt: now,
        starving: false,
        starvingStartAt: null,
        personality: assignPersonality(),
        level: 1,
        xp: 0,
        evolutionStage: 1,
        battleWins: 0,
        battleLosses: 0,
        bond: 0,
    };
}

/**
 * Roll for the rare companion tied to `source`. Returns its definition on a hit,
 * else null. Never offers a pet the player already owns. Pure — does not mutate.
 */
function rollRarePet(pets, source, tier, rng = Math.random) {
    if (tier !== 'legendary') return null;
    const def = rarePetForSource(source);
    if (!def) return null;
    if ((pets ?? []).some(p => p.petId === def.petId)) return null;
    return rng() < RARE_PET_DROP_CHANCE ? def : null;
}

/**
 * Roll for the rare companion tied to `source` and add it to `user` on a hit.
 * Returns the granted definition, or null. The caller is responsible for
 * markModified('pets') and saving.
 */
function tryGrantRarePet(user, source, tier, rng = Math.random) {
    if (!user) return null;
    const def = rollRarePet(user.pets ?? [], source, tier, rng);
    if (!def) return null;
    user.pets.push(joinVacation(user, createPet(def.petId)));
    noteCodex(user, def.petId);
    return def;
}

// ── Codex ─────────────────────────────────────────────────────────────────────
//
// /pet codex shows every species, in colour once the player has owned one
// (#1187). A pet that is released leaves the roster, so what a player has
// owned is kept in `petCodex`; the roster and the memorial count too, so a
// species owned before the field existed is not shown as never seen.

/** Record that `user` has owned `petId`. Mutates; the caller saves. */
function noteCodex(user, petId) {
    if (!user || !petId) return;
    if (!Array.isArray(user.petCodex)) user.petCodex = [];
    if (!user.petCodex.includes(petId)) {
        user.petCodex.push(petId);
        user.markModified?.('petCodex');
    }
}

/** Every species id this player has ever owned. */
function codexSpecies(user) {
    return new Set([
        ...(user?.petCodex ?? []),
        ...(user?.pets ?? []).map(p => p.petId),
        ...(user?.deceasedPets ?? []).map(p => p.petId),
    ].filter(id => PET_DEFINITIONS[id]));
}

/** Where a rare companion comes from, in words: "appears on a legendary hunt". */
function rarePetHint(def) {
    const where = { hunt: 'hunt', fish: 'catch', mine: 'dig', explore: 'expedition' }[def?.materialSource] ?? def?.materialSource;
    return `appears on a legendary ${where} (/${def?.materialSource})`;
}

// ── Pet slots ─────────────────────────────────────────────────────────────────
//
// The shop has always sold a Pet Slot Expansion, but nothing enforced a limit,
// so the item did nothing. Only *purchasable* pets consume a slot: the four
// rare companions can each drop at most once ever and are exempt, so they can
// never be locked out by a full roster.
//
// Existing rosters are grandfathered — being over capacity blocks further
// adoptions and never removes a pet.

const BASE_PET_SLOTS      = 3;
const MAX_SLOT_EXPANSIONS = 3;

/** How many purchasable pets this player may own. */
function petCapacity(user) {
    const bought = Math.min(Math.max(0, user?.petSlots ?? 0), MAX_SLOT_EXPANSIONS);
    return BASE_PET_SLOTS + bought;
}

/** Purchasable pets currently owned — the ones that occupy a slot. */
function countSlotPets(pets) {
    return (pets ?? []).filter(p => PET_DEFINITIONS[p.petId]?.purchasable).length;
}

/** Whether the player has room to adopt another pet from the shop. */
function hasFreePetSlot(user) {
    return countSlotPets(user?.pets) < petCapacity(user);
}

const HUNGER_DECAY_PER_DAY = 10;
const HUNGER_RESTORE_FAVORITE = 25;
const HUNGER_RESTORE_OTHER = 10;
const STARVING_THRESHOLD = 30;
const RUNAWAY_DAYS = 3;
const MS_PER_DAY = 86400000;

// ── Mood system ───────────────────────────────────────────────────────────────

const MOOD_LINES = {
    blissful: [
        '"I could nap here forever... this is the life."',
        '"You fed me so well — I might just hum happily until tomorrow."',
        '"Life is good. Very good. *Extremely* good."',
        '"I am completely and utterly content. Please don\'t move me."',
        '"If happiness had a shape, it would be whatever snack I just had."',
        '"This is peak existence and I refuse to acknowledge anything beyond this moment."',
    ],
    content: [
        '"Thanks for checking in. I\'m doing okay."',
        '"Life\'s pretty chill right now, honestly."',
        '"A little hungry, but nothing to panic over."',
        '"I\'m maintaining. Vibes are neutral-to-good."',
        '"Not complaining. But a snack wouldn\'t hurt."',
        '"I could do with a small treat if you\'re offering."',
    ],
    pleading: [
        '"Excuse me... I hate to bring this up... but food?"',
        '"I\'m not saying I\'m starving. I\'m saying my stomach is sad."',
        '"A single crumb. That\'s all I ask."',
        '"I keep looking at my bowl and it keeps being empty."',
        '"If this is a test of loyalty, I\'m passing it hungry."',
        '"Hello? Feed me? Pretty please? With a bow on top?"',
    ],
    concerning: [
        '"...I don\'t have the energy for a full complaint. Please hurry."',
        '"*stares at you with big, hollow eyes*"',
        '"I\'m holding it together. Barely."',
        '"Feed me before this becomes a dramatic backstory."',
        '"I have decided to be disappointed in you. With love."',
        '"This... is fine. Everything is fine. *It is not fine.*"',
    ],
};

// The bands line up with the passive bonus: everything from `pleading` up keeps
// the bonus, and `concerning` is exactly "below STARVING_THRESHOLD, bonus off".
// They used to break at 50 and 20, so a pet could plead while its bonus was
// already gone, and the colour, the hunger bar and the bonus each told a
// different story about the same number.
const MOOD_BANDS = [
    { band: 'blissful',   min: 90,                 color: '#4caf50' }, // green
    { band: 'content',    min: 60,                 color: '#cddc39' }, // lime
    { band: 'pleading',   min: STARVING_THRESHOLD, color: '#ff9800' }, // orange
    { band: 'concerning', min: -Infinity,          color: '#f44336' }, // red — bonus off
];

function moodBandFor(hunger) {
    return MOOD_BANDS.find(b => hunger >= b.min);
}

function getMoodBand(hunger) {
    return moodBandFor(hunger).band;
}

// What each species is doing while it says its line, so a Shark and a Cat no
// longer sound like the same animal. One gesture for a fed pet, one for a
// hungry one.
const SPECIES_ACTIONS = {
    dog:         { fed: 'tail thumping against the floor',  hungry: 'whining softly at the bowl' },
    cat:         { fed: 'slow, satisfied blink',            hungry: 'pointed stare at the empty bowl' },
    bird:        { fed: 'cheerful little trill',            hungry: 'ruffled feathers and a pointed chirp' },
    fish:        { fed: 'a happy stream of bubbles',        hungry: 'nudging the glass by the food flakes' },
    fox:         { fed: 'bushy tail curled in contentment', hungry: 'sniffing hopefully at your pockets' },
    wolf:        { fed: 'a low, contented rumble',          hungry: 'a long, hungry howl' },
    eagle:       { fed: 'preening proudly',                 hungry: 'a sharp, impatient cry' },
    shark:       { fed: 'lazy, lazy circles',               hungry: 'restless, tightening circles' },
    crystal_fox: { fed: 'a faint chime of crystal',         hungry: 'a dim, flickering glow' },
    lantern_owl: { fed: 'lantern glowing warm and steady',  hungry: 'lantern guttering low' },
};

/** The species gesture that goes with a pet's mood line, or null for an unknown species. */
function getMoodAction(pet, now = Date.now()) {
    const actions = SPECIES_ACTIONS[pet?.petId];
    if (!actions) return null;
    const band = getMoodBand(effectiveHunger(pet, now));
    return band === 'blissful' || band === 'content' ? actions.fed : actions.hungry;
}

function getMoodLine(pet, now = Date.now()) {
    const band = getMoodBand(effectiveHunger(pet, now));
    const lines = MOOD_LINES[band];
    const dayIndex = Math.floor(now / MS_PER_DAY);
    const petHash  = (pet.petId  || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const nameHash = (pet.name   || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return lines[(petHash + nameHash + dayIndex) % lines.length];
}

// Ramps monotonically from calm to alarming, on the same bands as the mood.
function getMoodColor(hunger) {
    return moodBandFor(hunger).color;
}

const HEART_BAR_LENGTH = 8;
/** Eight hearts for a bond of 0–BOND_MAX. */
function heartBar(bond) {
    const filled = Math.max(0, Math.min(Math.floor(Number(bond) / (BOND_MAX / HEART_BAR_LENGTH)) || 0, HEART_BAR_LENGTH));
    return '❤️'.repeat(filled) + '🖤'.repeat(HEART_BAR_LENGTH - filled);
}

/**
 * Resolve the `slot` option to a live pet.
 *
 * Autocomplete sends the pet's stable _id, so a release, a revive or a
 * starvation death between picking a pet and running the command can no longer
 * silently retarget a different animal — which positional indexes did, since
 * every later index shifts when the array changes. Bare numbers are still
 * accepted so anyone typing the old slot number by hand keeps working, and a
 * pet's name is taken as a last resort.
 *
 * Returns { index, pet } or null.
 */
function resolvePetRef(pets, ref) {
    pets = pets ?? [];
    if (pets.length === 0) return null;

    const raw = String(ref ?? '').trim();
    if (!raw) return { index: 0, pet: pets[0] };

    const byId = pets.findIndex(p => String(p._id) === raw);
    if (byId !== -1) return { index: byId, pet: pets[byId] };

    if (/^\d+$/.test(raw)) {
        const idx = Number(raw);
        return idx < pets.length ? { index: idx, pet: pets[idx] } : null;
    }

    const lower  = raw.toLowerCase();
    const byName = pets.findIndex(p => (p.name ?? '').toLowerCase() === lower);
    if (byName !== -1) return { index: byName, pet: pets[byName] };

    const byType = pets.findIndex(p => String(p.petId).toLowerCase() === lower);
    return byType !== -1 ? { index: byType, pet: pets[byType] } : null;
}

// ── Vacation ──────────────────────────────────────────────────────────────────
//
// `/pet vacation` pauses hunger decay for every pet a player owns, for up to
// VACATION_MAX_DAYS (#1181), so a holiday no longer ends in a pet that ran
// away. Each pet carries the window it is paused for (`vacationFrom` to
// `vacationUntil`) rather than the player, so every read of hunger — the
// passives in /hunt and /fish included — can account for it from the pet
// alone. Ending a vacation early moves `vacationUntil` back to that moment.
//
// A pet on vacation is not active: no passive, no battles, no training and no
// Pet of the Week credit, so a pause can never be used to farm. Only one window
// is kept per pet; it is safe to overwrite because the command brings decay up
// to date first, and a window before the decay cursor no longer matters.

const VACATION_MAX_DAYS = 14;

function vacationWindow(pet) {
    const from  = pet?.vacationFrom  ? new Date(pet.vacationFrom).getTime()  : NaN;
    const until = pet?.vacationUntil ? new Date(pet.vacationUntil).getTime() : NaN;
    return Number.isFinite(from) && Number.isFinite(until) && until > from ? { from, until } : null;
}

/** Whether a pet's hunger is paused right now. */
function isOnVacation(pet, now = Date.now()) {
    const w = vacationWindow(pet);
    return !!w && now >= w.from && now < w.until;
}

/** Milliseconds of [startMs, endMs] that fall inside the pet's vacation. */
function pausedMsBetween(pet, startMs, endMs) {
    const w = vacationWindow(pet);
    if (!w || endMs <= startMs) return 0;
    return Math.max(0, Math.min(endMs, w.until) - Math.max(startMs, w.from));
}

/**
 * The wall-clock time `activeMs` of unpaused time after `startMs` — the
 * moment decay that began at `startMs` has run for that long, skipping the
 * pause.
 */
function wallClockAfter(pet, startMs, activeMs) {
    const w = vacationWindow(pet);
    const t = startMs + activeMs;
    if (!w) return t;
    const pauseStart = Math.max(w.from, startMs);
    const pauseLen   = Math.max(0, w.until - pauseStart);
    return t <= pauseStart ? t : t + pauseLen;
}

/** The vacation window a player's pets are on, as `{ from, until }` Dates, or null. */
function activeVacation(user, now = Date.now()) {
    const pet = (user?.pets ?? []).find(p => isOnVacation(p, now));
    if (!pet) return null;
    const w = vacationWindow(pet);
    return { from: new Date(w.from), until: new Date(w.until) };
}

/** Put a newly added pet on its owner's current vacation, if they are on one. Returns the pet. */
function joinVacation(user, pet, now = Date.now()) {
    const v = activeVacation(user, now);
    if (v && pet) {
        pet.vacationFrom  = new Date(now);
        pet.vacationUntil = v.until;
    }
    return pet;
}

/**
 * Start a vacation for every pet `user` owns. Bring decay up to date first.
 * Mutates; the caller saves. Returns the end Date.
 */
function startVacation(user, days = VACATION_MAX_DAYS, now = Date.now()) {
    const span  = Math.min(VACATION_MAX_DAYS, Math.max(1, Math.floor(Number(days) || VACATION_MAX_DAYS)));
    const until = new Date(now + span * MS_PER_DAY);
    for (const pet of user?.pets ?? []) {
        pet.vacationFrom  = new Date(now);
        pet.vacationUntil = until;
    }
    user?.markModified?.('pets');
    return until;
}

/**
 * End a vacation now. Bring decay up to date first. Mutates; the caller saves.
 * Returns how many pets were on vacation.
 */
function endVacation(user, now = Date.now()) {
    let ended = 0;
    for (const pet of user?.pets ?? []) {
        if (!isOnVacation(pet, now)) continue;
        pet.vacationUntil = new Date(now);
        ended++;
    }
    if (ended) user?.markModified?.('pets');
    return ended;
}

// ── Hunger decay ──────────────────────────────────────────────────────────────
//
// Hunger decays *continuously* from `lastDecayAt`, a cursor that tracks how far
// hunger has been brought up to date. It is deliberately separate from
// `lastFed` (which only records when the pet was last fed, for display): when
// the two were the same field, feeding reset the decay clock, so feeding on any
// sub-24h cadence meant hunger never decayed at all.
//
// Decay is never written to the database outside of applyHungerDecay, so every
// *read* of a pet's hunger must go through effectiveHunger()/isPetActive() —
// otherwise a player who never runs a /pet command keeps a stale hunger value
// and collects their passive bonus forever.

function clampHunger(value) {
    const n = Number(value ?? 100);
    if (!Number.isFinite(n)) return 100;
    return Math.min(100, Math.max(0, n));
}

/** The decay cursor for a pet, in ms. Falls back for pets predating the field. */
function decayCursor(pet, now = Date.now()) {
    const raw = pet.lastDecayAt ?? pet.lastFed ?? pet.adoptedAt;
    const ms  = raw ? new Date(raw).getTime() : now;
    return Number.isFinite(ms) ? ms : now;
}

/**
 * Decay accrued since the pet's cursor, without persisting anything.
 * Returns { hunger, decay, windowMs, activeMs }, where `activeMs` is the part
 * of the window that was not paused by a vacation.
 *
 * Resting used to halve this for two hours (#1182). It saved about 0.4 hunger
 * a press and was only ever pressed for care credit, so Train replaced it and
 * decay runs at one speed — or not at all, on vacation (#1181).
 */
function decaySince(pet, now = Date.now()) {
    const from     = decayCursor(pet, now);
    const windowMs = Math.max(0, now - from);
    const hunger   = clampHunger(pet.hunger);
    if (windowMs === 0) return { hunger, decay: 0, windowMs: 0, activeMs: 0 };

    const activeMs = Math.max(0, windowMs - pausedMsBetween(pet, from, now));
    const decay    = (activeMs * HUNGER_DECAY_PER_DAY) / MS_PER_DAY;
    return { hunger: Math.max(0, hunger - decay), decay, windowMs, activeMs };
}

/** A pet's current hunger, including decay not yet written to the database. */
function effectiveHunger(pet, now = Date.now()) {
    if (!pet) return 0;
    return decaySince(pet, now).hunger;
}

/**
 * Whether a pet's passive applies and it can battle or train: fed enough
 * (decay-aware) and not on vacation.
 */
function isPetActive(pet, now = Date.now()) {
    return !!pet && !isOnVacation(pet, now) && effectiveHunger(pet, now) >= STARVING_THRESHOLD;
}

/**
 * Pick which of a defender's pets answers a challenge.
 *
 * Previously this was `pets.find(isPetActive)` — whichever battle-ready pet
 * happened to sit first in the array, which is arbitrary and could throw a
 * level 1 pet at a level 30 challenger. Prefer the closest level match, then
 * the stronger pet.
 */
function pickDefenderPet(pets, challengerLevel = 1, now = Date.now()) {
    const ready = (pets ?? []).filter(p => isPetActive(p, now));
    if (ready.length === 0) return null;
    return ready.reduce((best, pet) => {
        const gap     = Math.abs((pet.level ?? 1) - challengerLevel);
        const bestGap = Math.abs((best.level ?? 1) - challengerLevel);
        if (gap !== bestGap) return gap < bestGap ? pet : best;
        return (pet.level ?? 1) > (best.level ?? 1) ? pet : best;
    });
}

/**
 * Apply accrued hunger decay to all pets. Call lazily on pet commands.
 * Returns a new array; entries with no elapsed time are returned untouched.
 *
 * Idempotent: advances lastDecayAt to `now`, so repeated calls are no-ops.
 * starvingStartAt is only set when hunger reaches 0 (not merely below the
 * STARVING_THRESHOLD) so checkRunaway counts time at zero hunger only.
 */
function applyHungerDecay(pets, now = Date.now()) {
    return pets.map(pet => {
        const from = decayCursor(pet, now);
        const { hunger: newHunger, decay, activeMs, windowMs } = decaySince(pet, now);
        if (windowMs <= 0) return pet;

        const prevHunger = clampHunger(pet.hunger);
        const wasAtZero  = prevHunger === 0;
        const nowAtZero  = newHunger === 0;

        let starvingStartAt = pet.starvingStartAt ?? null;
        if (!nowAtZero) {
            starvingStartAt = null;
        } else if (!starvingStartAt) {
            // Start the runaway clock for any pet sitting at zero without one. That
            // covers both the fresh transition and a pet that entered the window
            // already empty — migration 008 clears the clock for every existing pet,
            // so without this branch a pet stored at zero hunger would keep a null
            // clock forever and checkRunaway could never remove it.
            //
            // On a fresh transition, back-date to when hunger actually ran out using
            // the window's average decay rate, so a pet left alone for a month is not
            // handed a fresh grace period from the moment it happens to be noticed.
            const ratePerMs = activeMs > 0 ? decay / activeMs : 0;
            const crossedAt = (!wasAtZero && ratePerMs > 0)
                ? wallClockAfter(pet, from, Math.min(activeMs, prevHunger / ratePerMs))
                : from;
            starvingStartAt = new Date(Math.round(Math.min(now, crossedAt)));
        }
        // The runaway clock stands still on vacation too: push it forward by
        // whatever part of this window after it started was paused.
        if (starvingStartAt) {
            const start  = new Date(starvingStartAt).getTime();
            const paused = pausedMsBetween(pet, Math.max(start, from), now);
            if (paused > 0) starvingStartAt = new Date(start + paused);
        }

        return {
            ...(pet.toObject ? pet.toObject() : pet),
            hunger: newHunger,
            // Drained over the same window, so it has to be settled before the
            // cursor below moves past it.
            bond: effectiveBond(pet, now),
            lastDecayAt: new Date(now),
            starving: newHunger < STARVING_THRESHOLD,
            starvingStartAt,
        };
    });
}

/**
 * Check which pets have been at zero hunger for 3+ days (runaway).
 * Returns { keepPets, ranAwayPets }.
 */
function checkRunaway(pets, now = Date.now()) {
    const keepPets = [];
    const ranAwayPets = [];

    for (const pet of pets) {
        if (pet.hunger === 0 && pet.starvingStartAt) {
            const daysSinceStarving = (now - new Date(pet.starvingStartAt).getTime()) / 86400000;
            if (daysSinceStarving >= RUNAWAY_DAYS) {
                ranAwayPets.push(pet);
                continue;
            }
        }
        keepPets.push(pet);
    }

    return { keepPets, ranAwayPets };
}

/**
 * Feed a pet with a given material. Returns { hunger, restored }.
 */
function feedPet(pet, materialId, now = Date.now()) {
    const def = PET_DEFINITIONS[pet.petId];
    if (!def) return null;

    const isFavorite = def.favoriteMaterial === materialId;
    const restored = isFavorite ? HUNGER_RESTORE_FAVORITE : HUNGER_RESTORE_OTHER;
    // Feed from decay-aware hunger so restoring never resurrects a stale value.
    const before    = effectiveHunger(pet, now);
    const newHunger = Math.min(100, before + restored);

    // `restored` is the food's nominal value; `gained` is what actually landed
    // once the 100 cap is applied, which is what the player should be told.
    return { hunger: newHunger, restored, gained: Math.round(newHunger - before), isFavorite };
}

/**
 * Whether a pet is full enough that feeding would be wasted. Uses the same
 * rounding the hunger bar shows, so a pet displayed at 100% is refused rather
 * than eating a material for a fraction of a point.
 */
function isPetFull(pet, now = Date.now()) {
    return Math.round(effectiveHunger(pet, now)) >= 100;
}

// ── Bond ──────────────────────────────────────────────────────────────────────
//
// Bond used to be days since `adoptedAt` and nothing else (#1186): the "Most
// Loyal" leaderboard ranked pets by age, bond did nothing in the game, and a
// pet revived with a Revive Scroll kept counting the days it spent gone. It is
// now a stored 0–BOND_MAX value that care raises and neglect lowers:
//
//  - Feeding, playing, training and battling each add a little, and a
//    pet takes at most BOND_DAILY_CAP a UTC day however much is clicked, the
//    same shape as the daily cap on Pet of the Week credit.
//  - It drains slowly while the pet sits below STARVING_THRESHOLD hunger, and
//    running away costs BOND_RUNAWAY_PENALTY on top — the scroll brings the pet
//    back, not the trust.
//  - Tiers unlock small rewards: a few percent on the passive, a frame on the
//    companion card, and a title shown with the pet.
//
// Migration 028 seeds existing pets from their age, capped below the top two
// tiers, so long-time owners are not reset to zero but still have those to
// earn. The seeding rule lives in the migration alone, so a later retune here
// cannot change what it did.

const BOND_MAX             = 100;
const BOND_DAILY_CAP       = 4;
const BOND_CARE = Object.freeze({ feed: 2, play: 2, train: 1, battle: 1 });
const BOND_HUNGRY_DECAY_PER_DAY = 2;
const BOND_RUNAWAY_PENALTY = 25;

// `boost` multiplies the pet's passive; `frame` colours the companion card's
// border (null keeps the species colour).
const BOND_TIERS = Object.freeze([
    { tier: 0, min: 0,  title: 'Wary',      boost: 0,    frame: null      },
    { tier: 1, min: 15, title: 'Friendly',  boost: 0.01, frame: null      },
    { tier: 2, min: 35, title: 'Trusted',   boost: 0.02, frame: '#cd7f32' },
    { tier: 3, min: 60, title: 'Devoted',   boost: 0.04, frame: '#c9d6e3' },
    { tier: 4, min: 90, title: 'Soulbound', boost: 0.06, frame: '#ff6b8b' },
]);

function clampBond(value) {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return 0;
    return Math.min(BOND_MAX, Math.max(0, n));
}

/**
 * Milliseconds of the window since the decay cursor that the pet spent below
 * STARVING_THRESHOLD. Uses the window's average decay rate, as the runaway
 * clock does.
 */
function hungryMsSince(pet, now = Date.now()) {
    // Active time only: bond does not drain while the pet is on vacation.
    const { hunger: end, decay, activeMs } = decaySince(pet, now);
    if (activeMs <= 0) return 0;
    const start = clampHunger(pet.hunger);
    if (start < STARVING_THRESHOLD) return activeMs;
    if (end >= STARVING_THRESHOLD || decay <= 0) return 0;
    const crossedAfter = (start - STARVING_THRESHOLD) / (decay / activeMs);
    return Math.max(0, activeMs - crossedAfter);
}

/** A pet's bond now, including hungry-time drain not yet written back. */
function effectiveBond(pet, now = Date.now()) {
    if (!pet) return 0;
    const drain = (hungryMsSince(pet, now) / MS_PER_DAY) * BOND_HUNGRY_DECAY_PER_DAY;
    return clampBond(clampBond(pet.bond) - drain);
}

/** The tier a bond value falls in. */
function bondTierFor(bond) {
    const b = clampBond(bond);
    return [...BOND_TIERS].reverse().find(t => b >= t.min) ?? BOND_TIERS[0];
}

/** A pet's current bond tier (decay-aware). */
function getBondTier(pet, now = Date.now()) {
    return bondTierFor(effectiveBond(pet, now));
}

/**
 * Raise a pet's bond for one act of care ('feed'|'play'|'train'|'battle'), subject to
 * the daily cap. Mutates `pet`. Returns the points actually added.
 *
 * Call after the pet's decay has been brought up to date, so the drain owed so
 * far is not charged against the new bond.
 */
function recordBondCare(pet, kind, now = Date.now()) {
    const points = BOND_CARE[kind] ?? 0;
    if (!pet || points <= 0) return 0;
    const day = Math.floor(now / MS_PER_DAY);
    if (pet.bondDay !== day) {
        pet.bondDay   = day;
        pet.bondToday = 0;
    }
    const room   = Math.max(0, BOND_DAILY_CAP - (pet.bondToday ?? 0));
    const before = clampBond(pet.bond);
    const gained = Math.min(points, room, BOND_MAX - before);
    if (gained <= 0) return 0;
    pet.bond      = before + gained;
    pet.bondToday = (pet.bondToday ?? 0) + gained;
    return gained;
}

/** The bond a pet keeps after running away. Pure. */
function bondAfterRunaway(pet) {
    return clampBond(clampBond(pet?.bond) - BOND_RUNAWAY_PENALTY);
}

// ── Training ──────────────────────────────────────────────────────────────────
//
// Train replaced Rest (#1182). Rest halved hunger decay for two hours, which
// saved about 0.4 hunger a press, so it was only pressed for quest and Pet of
// the Week credit. A training session instead picks a focus and buys a small,
// permanent, capped edge on one battle stat, paid for in hunger and gated by a
// per-pet cooldown. Each press is then a choice of which stat to train, and
// whether it's worth the hunger right now: a pet near the passive threshold
// can train itself below it.
//
// The bonus is a percentage of the level-derived stat, like the personality
// tilt it stacks on, so it weighs the same at level 1 as at level 30.
// tests/petBattle.test.js holds fully trained personality pairings to the same
// 42–58% as untrained ones, and keeps a fully trained pet's edge over an
// untrained twin (about 75%) near what a single level is worth.

// `perSession` is each focus's step, in fractions of the stat. They differ
// because the stats are not worth the same: attack goes straight into damage,
// defence only half, and speed only decides who opens — so Agility also
// sharpens the pet's crit chance (`critPerSession`, in points). The steps were
// tuned by simulation so that ten sessions of any one focus are worth about
// the same.
const TRAIN_FOCUSES = Object.freeze({
    power:   Object.freeze({ focus: 'power',   stat: 'atk', label: 'Power',   emoji: '💪', perSession: 0.004 }),
    guard:   Object.freeze({ focus: 'guard',   stat: 'def', label: 'Guard',   emoji: '🛡️', perSession: 0.01  }),
    agility: Object.freeze({ focus: 'agility', stat: 'spd', label: 'Agility', emoji: '💨', perSession: 0.03, critPerSession: 0.005 }),
});
const TRAIN_FOCUS_KEYS    = Object.keys(TRAIN_FOCUSES);
const TRAIN_MAX_SESSIONS  = 10;
const TRAIN_HUNGER_COST   = 8;
const TRAIN_COOLDOWN_MS   = 8 * 60 * 60 * 1000;

/** Sessions a pet has put into one focus, 0–TRAIN_MAX_SESSIONS. */
function trainingSessions(pet, focus) {
    const n = Math.floor(Number(pet?.training?.[focus] ?? 0));
    return Number.isFinite(n) ? Math.min(TRAIN_MAX_SESSIONS, Math.max(0, n)) : 0;
}

/**
 * The trained bonus: `{ atk, def, spd }` as fractions of each stat, and
 * `crit` in points of crit chance.
 */
function trainingBonus(pet) {
    const out = { atk: 0, def: 0, spd: 0, crit: 0 };
    for (const f of Object.values(TRAIN_FOCUSES)) {
        const n = trainingSessions(pet, f.focus);
        out[f.stat] = n * f.perSession;
        out.crit   += n * (f.critPerSession ?? 0);
    }
    return out;
}

/** A focus's total bonus after `sessions`, in percent of its stat (one decimal). */
function trainingPct(sessions, focus) {
    return Math.round(sessions * (TRAIN_FOCUSES[focus]?.perSession ?? 0) * 1000) / 10;
}

/** Minutes left on a pet's training cooldown, or 0 when it can train. */
function trainCooldownMinutes(pet, now = Date.now()) {
    const last = pet?.lastTrain ? new Date(pet.lastTrain).getTime() : 0;
    const left = Number.isFinite(last) && last > 0 ? TRAIN_COOLDOWN_MS - (now - last) : 0;
    return left > 0 ? Math.ceil(left / 60000) : 0;
}

/**
 * Whether a pet can train `focus` now. Returns `{ ok: true }` or
 * `{ ok: false, reason: 'focus'|'maxed'|'cooldown'|'vacation'|'hungry', minutes? }`.
 * Decay-aware, like every other read of hunger.
 */
function canTrain(pet, focus, now = Date.now()) {
    if (!TRAIN_FOCUSES[focus]) return { ok: false, reason: 'focus' };
    if (trainingSessions(pet, focus) >= TRAIN_MAX_SESSIONS) return { ok: false, reason: 'maxed' };
    const minutes = trainCooldownMinutes(pet, now);
    if (minutes > 0) return { ok: false, reason: 'cooldown', minutes };
    if (isOnVacation(pet, now)) return { ok: false, reason: 'vacation' };
    if (!isPetActive(pet, now)) return { ok: false, reason: 'hungry' };
    return { ok: true };
}

/**
 * Run one training session. Mutates `pet`; call canTrain first, and bring the
 * pet's decay up to date before this so the hunger it spends is current.
 * Returns `{ focus, sessions, pct, hunger, passiveOff }`, where `pct` is the
 * focus's total bonus in whole percent and `passiveOff` says this session
 * took the pet below the passive threshold.
 */
function trainPet(pet, focus, now = Date.now()) {
    const def    = TRAIN_FOCUSES[focus];
    const before = clampHunger(pet.hunger);
    const hunger = Math.max(0, before - TRAIN_HUNGER_COST);
    const sessions = Math.min(TRAIN_MAX_SESSIONS, trainingSessions(pet, focus) + 1);
    pet.training  = { ...(pet.training?.toObject ? pet.training.toObject() : pet.training ?? {}), [focus]: sessions };
    pet.lastTrain = new Date(now);
    pet.hunger    = hunger;
    pet.starving  = hunger < STARVING_THRESHOLD;
    return {
        focus:      def.focus,
        sessions,
        pct:        trainingPct(sessions, focus),
        hunger,
        passiveOff: before >= STARVING_THRESHOLD && hunger < STARVING_THRESHOLD,
    };
}

// ── Pet of the Week credit ────────────────────────────────────────────────────
//
// Pet of the Week pays coins to the pet with the most weekly interactions, so
// the counter cannot be something a player can mash: Showcase had no cooldown
// and feeding a full pet still counted, so the week went to whoever clicked the
// most. Each pet now earns at most POTW_DAILY_INTERACTION_CAP credits per UTC
// day, which makes the ribbon reward caring on many days rather than clicking
// on one.

const POTW_DAILY_INTERACTION_CAP = 3;

/**
 * Count one care interaction toward Pet of the Week, subject to the daily cap.
 * Mutates `pet`. Returns true when the interaction counted.
 */
function recordPetInteraction(pet, now = Date.now()) {
    if (isOnVacation(pet, now)) return false;
    const day = Math.floor(now / MS_PER_DAY);
    if (pet.interactionDay !== day) {
        pet.interactionDay    = day;
        pet.interactionsToday = 0;
    }
    if ((pet.interactionsToday ?? 0) >= POTW_DAILY_INTERACTION_CAP) return false;
    pet.interactionsToday  = (pet.interactionsToday ?? 0) + 1;
    pet.weeklyInteractions = (pet.weeklyInteractions ?? 0) + 1;
    return true;
}

/**
 * Returns the active passive bonus for a pet, or null if it is too hungry.
 * Uses decay-aware hunger, so the bonus lapses on schedule even for a player
 * who never runs a /pet command.
 */
function getPetBonus(pet, now = Date.now()) {
    if (!isPetActive(pet, now)) return null;
    return PET_DEFINITIONS[pet.petId] ?? null;
}

// Ceiling on the combined passive of one bonus type across every pet a player
// owns. Two pets can share a bonus type (Fish + Shark both give fish_yield),
// and fully invested that stacked to 50%. The cap sits above the best single
// pet can reach on its own (a rare pet at level 30 is 37.5%) so maxing one pet
// is never wasted — it only takes the edge off stacking duplicates.
const MAX_STACKED_BONUS_PCT = 40;

/**
 * Get total bonus of a given type from all active pets, capped.
 * Uses each pet's *effective* bonus (scaled by evolution + level), so investing
 * in a pet meaningfully improves its passive.
 */
function getTotalBonus(pets, bonusType, now = Date.now()) {
    let total = 0;
    for (const pet of pets) {
        const bonus = getPetBonus(pet, now);
        if (bonus && bonus.bonusType === bonusType) {
            total += getEffectiveBonusPct(pet, now);
        }
    }
    return Math.min(total, MAX_STACKED_BONUS_PCT);
}

// ── Passive units ──────────────────────────────────────────────────────────────
//
// Passives come in two units, and they used to be labelled alike (#1190). Rob
// and crime add *percentage points* to a success chance — a maxed Fox's +20
// takes a 40% rob to 60% — while every other passive *multiplies* a payout, so
// a Wolf's +25% hunt yield is ×1.25. Printing both as "+20%" made the Fox look
// four times weaker than it is. The balance stays; the label now says which it
// is, and petChanceBonus() is the one place the additive rule lives.

const CHANCE_BONUS_TYPES = new Set(['rob_success', 'crime_success']);

/** Unit and wording for a bonus type: `{ unit: '%'|' pts', label }`. */
function petBonusParts(bonusType) {
    const words = String(bonusType ?? '').replace(/_/g, ' ');
    return CHANCE_BONUS_TYPES.has(bonusType)
        ? { unit: ' pts', label: `${words} chance` }
        : { unit: '%',    label: words };
}

/** A passive as players read it: "+25% hunt yield", "+20 pts rob success chance". */
function formatPetBonus(bonusType, pct) {
    const { unit, label } = petBonusParts(bonusType);
    return `+${pct}${unit} ${label}`;
}

/**
 * Percentage points a player's fed pets add to a success chance, as a fraction
 * to *add* (0.2 for +20 pts). Only for the chance passives; the payout ones go
 * through getTotalBonus as a multiplier.
 */
function petChanceBonus(pets, bonusType, now = Date.now()) {
    if (!CHANCE_BONUS_TYPES.has(bonusType)) return 0;
    return getTotalBonus(pets ?? [], bonusType, now) / 100;
}

// ── Companion lines on grind results ──────────────────────────────────────────
//
// The one line of pet flavour a hunt, cast, dig or expedition result carries.
// It used to be whichever fed pet sat first in the roster, so a Fish would
// "race ahead, picking up a trail" on a hunt while the Wolf that was actually
// boosting it said nothing, and the Lantern Owl never spoke at all because
// exploration had no line.

// Which passives each activity uses, so the pet helping is the one that talks.
const ACTIVITY_BONUS_TYPES = {
    hunt:    ['hunt_yield', 'hunt_xp'],
    fish:    ['fish_yield'],
    mine:    ['mine_yield'],
    explore: ['explore_xp'],
};
// Pets that only make sense on the water.
const AQUATIC_PETS = new Set(['fish', 'shark']);

/**
 * The companion line for an activity ('hunt'|'fish'|'mine'|'explore'), as a
 * block-quote, or null when no fed pet fits. Prefers a pet whose passive the
 * activity uses (highest level first), then any other fed pet that belongs
 * there — never a fish on dry land.
 */
function petCompanionLine(pets, activity, now = Date.now()) {
    const active = (pets ?? []).filter(p => isPetActive(p, now) && PET_DEFINITIONS[p.petId]);
    const helps  = ACTIVITY_BONUS_TYPES[activity] ?? [];
    const byLevel = (a, b) => (b.level ?? 1) - (a.level ?? 1);
    const pet = active.filter(p => helps.includes(PET_DEFINITIONS[p.petId].bonusType)).sort(byLevel)[0]
        ?? active.filter(p => activity === 'fish' || !AQUATIC_PETS.has(p.petId)).sort(byLevel)[0];
    if (!pet) return null;
    const flavor = TRAIT_FLAVOR[pet.personality]?.[activity];
    if (!flavor) return null;
    const { emoji, name } = getPetDisplay(pet);
    return `> ${flavor(name, emoji)}`;
}

// ── Progression: leveling & evolution ───────────────────────────────────────

const PET_MAX_LEVEL = 30;
// Evolution stage boundaries by level. Stage 1: 1–9, Stage 2: 10–19, Stage 3: 20+.
const EVOLUTION_LEVELS = [10, 20];
// Effective passive bonus multiplier per evolution stage.
const STAGE_BONUS_MULT = { 1: 1.0, 2: 1.5, 3: 2.0 };
// Per-level passive growth on top of the stage multiplier (caps the total at a
// sane ceiling so the 10x combined-multiplier economy isn't blown open).
const PER_LEVEL_BONUS_GROWTH = 0.03;
const MAX_EFFECTIVE_BONUS_MULT = 2.5;

// XP sources
const XP_FEED_FAVORITE = 8;
const XP_FEED_OTHER    = 4;
const XP_BATTLE_WIN    = 30;
const XP_BATTLE_LOSS   = 10;
const XP_WILD_WIN      = 22;
const XP_WILD_LOSS     = 8;

// Evolution display: stage title prefixes + an optional evolved emoji per pet.
const EVOLUTION_TITLES = { 1: '', 2: 'Seasoned ', 3: 'Apex ' };
// Every stage looks different from the one before it, and no evolved form
// borrows another species' icon (a Dog used to become the Wolf's 🐺, a Bird the
// Eagle's 🦅, a Fish the Shark's 🦈) or the 🌟 that marks Pet of the Week.
// Mirrored in utils/cardGenerator.js; tests/petBattle.test.js keeps them equal.
const EVOLVED_EMOJI = {
    dog:         { 2: '🐕',  3: '🐕‍🦺' },
    cat:         { 2: '🐈',  3: '🐅' },
    bird:        { 2: '🦜',  3: '🦚' },
    fish:        { 2: '🐟',  3: '🐡' },
    fox:         { 2: '🍂',  3: '🔥' },
    wolf:        { 2: '🌕',  3: '🌑' },
    eagle:       { 2: '🪶',  3: '⚡' },
    shark:       { 2: '🌊',  3: '🔱' },
    crystal_fox: { 2: '💠',  3: '🔮' },
    lantern_owl: { 2: '🕯️',  3: '🏮' },
};

// Total XP required to *reach* a given level (cumulative). Gentle quadratic curve.
function xpForLevel(level) {
    if (level <= 1) return 0;
    let total = 0;
    for (let l = 2; l <= level; l++) total += 40 + (l - 1) * 20;
    return total;
}

function stageForLevel(level) {
    let stage = 1;
    for (const boundary of EVOLUTION_LEVELS) if (level >= boundary) stage += 1;
    return stage;
}

/**
 * Display emoji + name for a pet, accounting for its evolution stage.
 */
function getPetDisplay(pet) {
    // Wild opponents are not in PET_DEFINITIONS but carry their own emoji, so
    // a battle against one no longer renders as a bare paw print.
    const def   = PET_DEFINITIONS[pet.petId]
        ?? WILD_OPPONENTS.find(w => w.petId === pet.petId)
        ?? { emoji: '🐾', name: pet.petId };
    const stage = pet.evolutionStage ?? 1;
    const emoji = EVOLVED_EMOJI[pet.petId]?.[stage] ?? def.emoji;
    const title = EVOLUTION_TITLES[stage] ?? '';
    const baseName = pet.name || def.name;
    return { emoji, name: baseName, titledName: `${title}${baseName}`.trim() };
}

/**
 * Effective passive bonus % for a pet (base × stage × per-level growth, capped,
 * × the bond tier's boost).
 */
function getEffectiveBonusPct(pet, now = Date.now()) {
    const def = PET_DEFINITIONS[pet.petId];
    if (!def) return 0;
    const stage = pet.evolutionStage ?? 1;
    const level = pet.level ?? 1;
    const mult  = Math.min(
        MAX_EFFECTIVE_BONUS_MULT,
        (STAGE_BONUS_MULT[stage] ?? 1.0) + (level - 1) * PER_LEVEL_BONUS_GROWTH
    );
    // The bond tier's reward sits on top of the level cap: a few percent of the
    // passive, so a well-kept pet is a little better than a neglected one at
    // the same level without outgrowing MAX_STACKED_BONUS_PCT on its own.
    const bondBoost = 1 + getBondTier(pet, now).boost;
    return Math.round(def.bonusPct * mult * bondBoost * 10) / 10;
}

/**
 * Award XP to a pet, applying level-ups and evolution.
 * Mutates `pet` in place. Returns { gained, leveledUp, fromLevel, toLevel, evolved, fromStage, toStage }.
 */
function applyPetXp(pet, amount) {
    const fromLevel = pet.level ?? 1;
    const fromStage = pet.evolutionStage ?? 1;
    pet.level = fromLevel;
    pet.xp = (pet.xp ?? 0) + Math.max(0, amount);

    while (pet.level < PET_MAX_LEVEL && pet.xp >= xpForLevel(pet.level + 1)) {
        pet.level += 1;
    }
    pet.evolutionStage = stageForLevel(pet.level);

    return {
        gained:    Math.max(0, amount),
        leveledUp: pet.level > fromLevel,
        fromLevel, toLevel: pet.level,
        evolved:   pet.evolutionStage > fromStage,
        fromStage, toStage: pet.evolutionStage,
    };
}

/**
 * What an evolution changed, for the reveal (#1187): the titled name and
 * passive before and after. `res` is applyPetXp's result for `pet`, which it
 * has already mutated. Returns null when `res` is not an evolution.
 */
function evolutionSummary(pet, res, now = Date.now()) {
    if (!pet || !res?.evolved) return null;
    const plain  = pet.toObject ? pet.toObject() : { ...pet };
    const before = { ...plain, level: res.fromLevel, evolutionStage: res.fromStage };
    const def    = PET_DEFINITIONS[pet.petId];
    const was    = getPetDisplay(before);
    const is     = getPetDisplay(pet);
    return {
        fromStage:  res.fromStage,
        toStage:    res.toStage,
        fromEmoji:  was.emoji,
        toEmoji:    is.emoji,
        fromTitle:  was.titledName,
        toTitle:    is.titledName,
        bonusType:  def?.bonusType ?? null,
        fromPct:    def ? getEffectiveBonusPct(before, now) : 0,
        toPct:      def ? getEffectiveBonusPct(pet, now) : 0,
    };
}

// ── Battle engine ───────────────────────────────────────────────────────────

// Personalities tilt combat stats, each a different way to win: Energetic
// strikes first more often, Mischievous crits more, Loyal outlasts, Lazy
// shrugs hits off. They are percentages of the level-derived stats, so a
// personality weighs the same at level 1 as at level 30.
//
// These used to be flat points, and personality is rolled at adoption and
// never changes, so it was a hidden permanent power rank: Energetic beat Lazy
// 85% of the time at equal level and Loyal lost to everything. The values below
// were tuned by simulation to keep every pairing within about 45–55% at every
// level (tests/petBattle.test.js holds them to that).
const PERSONALITY_COMBAT = {
    energetic:   { spd: 0.30, atk: 0.08 },
    mischievous: { atk: 0.06, crit: 0.10 },
    loyal:       { hp: 0.10,  def: 0.05 },
    lazy:        { def: 0.15, hp: 0.06 },
};

const BASE_CRIT_CHANCE = 0.10;

// Rare companions (the four that only drop) fight a little better than a pet
// from the shop (#1183): a few percent on HP, attack and defence, enough that
// finding one is felt and not enough to decide a fight. tests/petBattle.test.js
// states the edge as a win rate and holds it there.
const RARE_COMBAT_EDGE = 0.01;

// ── Signature moves ──────────────────────────────────────────────────────────
//
// Species used to do nothing in a fight (#1183): getPetStats read level, stage
// and personality, so a 2,000-coin Dog and a 4% legendary Crystal Fox fought
// identically. Each species now has one move, fired by a chance or a
// condition and named in the battle log. Wild opponents have them too, so a
// wild fight is no longer a plain trade of numbers.
//
// `kind` is what the engine does; the numbers beside it are its tuning. They
// were tuned by simulation to keep every species pairing at equal level within
// 42–58% (tests/petBattle.test.js), the rare edge aside.
const SPECIES_MOVES = Object.freeze({
    dog:         { name: 'Stand Firm',      kind: 'brace',   chance: 0.16, mult: 0.75, desc: 'Sometimes braces and shrugs off a quarter of a hit.' },
    cat:         { name: 'Nine Lives',      kind: 'survive', chance: 0.25,             desc: 'Can survive a lethal hit at 1 HP, once a fight.' },
    bird:        { name: 'Flurry',          kind: 'double',  chance: 0.10, mult: 0.4,  desc: 'Sometimes pecks again at 40% strength.' },
    fish:        { name: 'Slippery Scales', kind: 'dodge',   chance: 0.04,             desc: 'Sometimes slips a hit entirely.' },
    fox:         { name: 'Feint',           kind: 'pierce',  chance: 0.10,             desc: 'Sometimes strikes past the guard, ignoring defence.' },
    wolf:        { name: 'Pack Howl',       kind: 'empower', chance: 0.25, mult: 1.2,  desc: 'Sometimes howls, and its next hit lands 20% harder.' },
    eagle:       { name: 'Talon Dive',      kind: 'opener',  mult: 1.2,                desc: 'Opens with a dive: its first strike lands 20% harder.' },
    shark:       { name: 'Frenzy',          kind: 'frenzy',  mult: 1.08,               desc: 'Hits 8% harder while the opponent is under half HP.' },
    crystal_fox: { name: 'Crystal Ward',    kind: 'ward',    pct: 0.04,                desc: 'Starts behind a ward that soaks up its first few points of damage.' },
    lantern_owl: { name: 'Lantern Flare',   kind: 'blind',   chance: 0.04,             desc: 'Sometimes dazzles the opponent, and their next attack misses.' },
    wild_boar:   { name: 'Gore Charge',     kind: 'opener',  mult: 1.2,                desc: 'Opens with a charge: its first strike lands 20% harder.' },
    feral_cat:   { name: 'Hiss',            kind: 'weaken',  chance: 0.08, mult: 0.5,  desc: "Sometimes hisses, and the opponent's next hit lands at half strength." },
    stray_hound: { name: 'Scavenge',        kind: 'mend',    chance: 0.25, pct: 0.04,  desc: 'Sometimes recovers a little HP after a hit.' },
    cave_bat:    { name: 'Echolocation',    kind: 'dodge',   chance: 0.04,             desc: 'Sometimes slips a hit entirely.' },
});

/** A species' signature move `{ name, kind, desc, … }`, or null. */
function getSpeciesMove(petId) {
    return SPECIES_MOVES[petId] ?? null;
}

/**
 * Derive battle stats from a pet's level, evolution, personality, training
 * and rarity.
 */
function getPetStats(pet) {
    const level = pet.level ?? 1;
    const stage = pet.evolutionStage ?? 1;
    const p     = PERSONALITY_COMBAT[pet.personality] ?? {};
    const t     = trainingBonus(pet);
    const rare  = PET_DEFINITIONS[pet.petId]?.purchasable === false ? RARE_COMBAT_EDGE : 0;
    // Only HP is rounded (it is shown on the HP bar). Rounding attack at low
    // level turned a 6% edge into a whole point, which is 8% of a level-1 hit.
    // The percentages add: personality, training and the rare edge each tilt
    // the same level-derived base.
    const scale = (base, pct) => base * (1 + pct);
    return {
        hp:   Math.round(scale(40 + level * 6 + stage * 10, (p.hp  ?? 0) + rare)),
        atk:  scale(8  + level * 2 + stage * 3,  (p.atk ?? 0) + t.atk + rare),
        def:  scale(4  + level * 1 + stage * 2,  (p.def ?? 0) + t.def + rare),
        spd:  scale(5  + level,                  (p.spd ?? 0) + t.spd),
        crit: BASE_CRIT_CHANCE + (p.crit ?? 0) + t.crit,
    };
}

// Smoothing on the first-strike odds, so a small speed edge is a small edge.
const FIRST_STRIKE_SMOOTHING = 5;

/** The chance that A strikes first: weighted by speed, never a certainty. */
function firstStrikeChance(a, b) {
    return (a.spd + FIRST_STRIKE_SMOOTHING) / (a.spd + b.spd + 2 * FIRST_STRIKE_SMOOTHING);
}

/** One side of a fight: its stats, its move and the state the move keeps. */
function fighter(pet, side) {
    const stats = getPetStats(pet);
    const move  = getSpeciesMove(pet.petId);
    return {
        side, stats, move, hp: stats.hp,
        ward:      move?.kind === 'ward' ? Math.round(stats.hp * move.pct) : 0,
        opened:    false, // has struck once (opener)
        empowered: false, // next hit powered up (empower)
        dazzled:   false, // next attack misses (the opponent's blind)
        weakened:  false, // next hit halved (the opponent's weaken)
        survived:  false, // has used its one survival (survive)
    };
}

/** Damage through the defender's ward and last stand. Mutates `def`; returns what landed. */
function landHit(def, damage, moves, rng) {
    if (def.ward > 0 && damage > 0) {
        const soaked = Math.min(def.ward, damage);
        def.ward -= soaked;
        damage   -= soaked;
        moves.push({ side: def.side, name: def.move.name });
    }
    def.hp = Math.max(0, def.hp - damage);
    if (def.hp === 0 && def.move?.kind === 'survive' && !def.survived && rng() < def.move.chance) {
        def.hp = 1;
        def.survived = true;
        moves.push({ side: def.side, name: def.move.name });
    }
    return damage;
}

/**
 * One attack, moves included. Mutates both fighters and returns the round's
 * `{ damage, crit, missed, moves }`, where `moves` names every signature move
 * that fired and whose it was.
 */
function attack(atk, def, rng) {
    const moves = [];
    const mine  = atk.move ?? {};
    const theirs = def.move ?? {};
    const opener = mine.kind === 'opener' && !atk.opened;
    atk.opened = true;

    // The opponent's Lantern Flare: this attack misses outright.
    if (atk.dazzled) {
        atk.dazzled = false;
        moves.push({ side: def.side, name: theirs.name });
        return { damage: 0, crit: false, missed: true, moves };
    }

    // Damage = atk - def/2, ±25% variance, min 1; crit (10%, more for
    // Mischievous) for 1.5x.
    const pierce   = mine.kind === 'pierce' && rng() < mine.chance;
    const base     = Math.max(1, atk.stats.atk - (pierce ? 0 : def.stats.def / 2));
    const variance = 0.75 + rng() * 0.5;
    const crit     = rng() < atk.stats.crit ? 1.5 : 1.0;
    let mult = 1;
    if (pierce) moves.push({ side: atk.side, name: mine.name });
    if (opener) { mult *= mine.mult; moves.push({ side: atk.side, name: mine.name }); }
    if (atk.empowered) { mult *= mine.mult; atk.empowered = false; moves.push({ side: atk.side, name: mine.name }); }
    if (mine.kind === 'frenzy' && def.hp < def.stats.hp / 2) { mult *= mine.mult; moves.push({ side: atk.side, name: mine.name }); }
    if (atk.weakened) { mult *= theirs.mult; atk.weakened = false; moves.push({ side: def.side, name: theirs.name }); }
    mult *= atk.stanceMult ?? 1;
    let damage = Math.max(1, Math.round(base * variance * crit * mult));

    // The defender's own answers to the hit.
    if (theirs.kind === 'dodge' && rng() < theirs.chance) {
        moves.push({ side: def.side, name: theirs.name });
        return { damage: 0, crit: false, missed: true, moves };
    }
    if (theirs.kind === 'brace' && rng() < theirs.chance) {
        damage = Math.max(1, Math.round(damage * theirs.mult));
        moves.push({ side: def.side, name: theirs.name });
    }

    let landed = landHit(def, damage, moves, rng);

    // Follow-ups, only while the defender is still standing.
    if (def.hp > 0 && mine.kind === 'double' && rng() < mine.chance) {
        moves.push({ side: atk.side, name: mine.name });
        landed += landHit(def, Math.max(1, Math.round(damage * mine.mult)), moves, rng);
    }
    if (def.hp > 0) {
        if (mine.kind === 'empower' && rng() < mine.chance) atk.empowered = true;
        if (mine.kind === 'blind'   && rng() < mine.chance) { def.dazzled  = true; moves.push({ side: atk.side, name: mine.name }); }
        if (mine.kind === 'weaken'  && rng() < mine.chance) { def.weakened = true; moves.push({ side: atk.side, name: mine.name }); }
        if (mine.kind === 'mend'    && rng() < mine.chance && atk.hp < atk.stats.hp) {
            atk.hp = Math.min(atk.stats.hp, atk.hp + Math.max(1, Math.round(atk.stats.hp * mine.pct)));
            moves.push({ side: atk.side, name: mine.name });
        }
    }

    return { damage: landed, crit: crit > 1, missed: false, moves };
}

/**
 * A fight in progress: both fighters and whose turn it is. simulateBattle
 * runs one to the end in a go; a member battle runs it a stance round at a
 * time (#1184) through runExchanges.
 *
 * Striking first is worth a lot in an even fight (~78% of mirror matches),
 * so it is a speed-weighted roll rather than a sure thing for the faster
 * pet — and never a default in the challenger's favour.
 */
function createBattle(petA, petB, rng = Math.random) {
    const a = fighter(petA, 'a');
    const b = fighter(petB, 'b');
    return { a, b, turnA: rng() < firstStrikeChance(a.stats, b.stats), rounds: [] };
}

/** Whether both fighters are still standing. */
function battleOngoing(state) {
    return state.a.hp > 0 && state.b.hp > 0;
}

/**
 * Up to `count` more attacks, alternating, stopping at a knockout. `mult`
 * scales each side's damage for these attacks only (a stance's edge). Returns
 * the rounds added, which are also appended to `state.rounds`.
 */
function runExchanges(state, count, rng = Math.random, mult = {}) {
    const { a, b } = state;
    a.stanceMult = mult.a ?? 1;
    b.stanceMult = mult.b ?? 1;
    const added = [];
    for (let r = 0; r < count && battleOngoing(state); r++) {
        const hit = state.turnA ? attack(a, b, rng) : attack(b, a, rng);
        added.push({
            attacker: state.turnA ? 'a' : 'b', damage: hit.damage, crit: hit.crit, missed: hit.missed,
            moves: hit.moves, hpA: a.hp, hpB: b.hp,
        });
        state.turnA = !state.turnA;
    }
    a.stanceMult = 1;
    b.stanceMult = 1;
    state.rounds.push(...added);
    return added;
}

/**
 * The winner of a fight that has stopped. Short of a knockout the higher
 * remaining HP fraction wins; an exact tie is a coin flip rather than a free
 * win for the challenger.
 */
function battleVerdict(state, rng = Math.random) {
    const { a, b } = state;
    let winner;
    if (b.hp <= 0) winner = 'a';
    else if (a.hp <= 0) winner = 'b';
    else {
        const fracA = a.hp / a.stats.hp, fracB = b.hp / b.stats.hp;
        winner = fracA === fracB ? (rng() < 0.5 ? 'a' : 'b') : fracA > fracB ? 'a' : 'b';
    }
    return { winner, rounds: state.rounds, finalHpA: a.hp, finalHpB: b.hp };
}

/**
 * Simulate a battle between two pets. `rng` is injectable for testing.
 * Returns { winner: 'a'|'b', rounds, finalHpA, finalHpB }. Each round is
 * `{ attacker, damage, crit, missed, moves, hpA, hpB }`; `moves` lists the
 * signature moves that fired that round as `{ side, name }`.
 */
function simulateBattle(petA, petB, rng = Math.random) {
    const state = createBattle(petA, petB, rng);
    runExchanges(state, 30, rng);
    return battleVerdict(state, rng);
}

// ── Stances (#1184) ──────────────────────────────────────────────────────────
//
// A member battle used to be decided by stats and dice alone. Each stance
// round, both players now pick a stance in secret: Strike beats Trick, Trick
// beats Guard, Guard beats Strike. The pet whose owner read the other hits
// harder for that round's exchanges and takes less; a tie changes nothing.
// The edge is large on purpose, so reading the opponent can beat a pet that is
// a little stronger on paper (tests/petStances.test.js holds it to that).
const STANCES = Object.freeze({
    strike: { key: 'strike', label: 'Strike', emoji: '🗡️', beats: 'trick',  verb: 'overpowers' },
    guard:  { key: 'guard',  label: 'Guard',  emoji: '🛡️', beats: 'strike', verb: 'turns aside' },
    trick:  { key: 'trick',  label: 'Trick',  emoji: '🎭', beats: 'guard',  verb: 'slips past' },
});
const STANCE_KEYS = Object.keys(STANCES);
const STANCE_WIN_MULT  = 1.25;
const STANCE_LOSE_MULT = 0.8;
const STANCE_ROUNDS    = 3;   // stance picks per battle, at most
const STANCE_EXCHANGES = 4;   // attacks per stance round (two each)

/** 'a' or 'b' for the side whose stance wins, or null for a tie. */
function stanceOutcome(stanceA, stanceB) {
    if (stanceA === stanceB) return null;
    return STANCES[stanceA]?.beats === stanceB ? 'a' : 'b';
}

function randomStance(rng = Math.random) {
    return STANCE_KEYS[Math.floor(rng() * STANCE_KEYS.length) % STANCE_KEYS.length];
}

/**
 * One stance round of a battle in progress: the stance matchup, then that
 * round's exchanges with the winner's edge applied. Returns
 * `{ edge: 'a'|'b'|null, rounds }`.
 */
function fightStanceRound(state, stanceA, stanceB, rng = Math.random) {
    const edge = stanceOutcome(stanceA, stanceB);
    const mult = edge === 'a' ? { a: STANCE_WIN_MULT, b: STANCE_LOSE_MULT }
        : edge === 'b' ? { a: STANCE_LOSE_MULT, b: STANCE_WIN_MULT }
        : {};
    return { edge, rounds: runExchanges(state, STANCE_EXCHANGES, rng, mult) };
}

/**
 * A whole stance battle with the picks already known, for tests and balance
 * checks: `pickA(roundIndex)` / `pickB(roundIndex)` return a stance key.
 */
function simulateStanceBattle(petA, petB, pickA, pickB, rng = Math.random) {
    const state = createBattle(petA, petB, rng);
    for (let r = 0; r < STANCE_ROUNDS && battleOngoing(state); r++) {
        fightStanceRound(state, pickA(r), pickB(r), rng);
    }
    return battleVerdict(state, rng);
}

// The wild opponents /pet battle fields when a player has no PvP target. They
// are never ownable and never enter PET_DEFINITIONS, but they are still pet
// species with their own portrait art (issue #1082), so their ids are part of
// the roster the icon set covers. Lifted to module scope (from inside
// makeWildPet) so that roster is discoverable — src/data/activityItems.js keys
// pet art off PET_DEFINITIONS plus these.
const WILD_OPPONENTS = [
    { petId: 'wild_boar',   name: 'Wild Boar',   emoji: '🐗', personality: 'energetic' },
    { petId: 'feral_cat',   name: 'Feral Cat',   emoji: '🐈‍⬛', personality: 'mischievous' },
    { petId: 'stray_hound', name: 'Stray Hound', emoji: '🐕', personality: 'loyal' },
    { petId: 'cave_bat',    name: 'Cave Bat',    emoji: '🦇', personality: 'energetic' },
];
const WILD_PET_IDS = WILD_OPPONENTS.map(w => w.petId);

/**
 * A copy of `pet` fighting at `level` — the stage follows the level, and
 * everything else (personality, species) is kept.
 *
 * Wagered battles fight both pets at the lower of the two levels. Stats scale
 * so steeply with level that a single level's lead wins ~97% of fights and
 * three win all of them, so without this a wager was a near-certain payout for
 * whoever had the higher-level pet, whatever the level-gap limit allowed.
 */
function atLevel(pet, level) {
    return { ...petSnapshotFields(pet), level, evolutionStage: stageForLevel(level) };
}

function petSnapshotFields(pet) {
    const fields = {
        petId: pet.petId, name: pet.name, personality: pet.personality,
        level: pet.level ?? 1, evolutionStage: pet.evolutionStage ?? 1,
    };
    // Training is a permanent stat edge and travels with the pet into a
    // level-matched fight, as its personality does.
    if (pet.training) fields.training = { ...(pet.training.toObject ? pet.training.toObject() : pet.training) };
    return fields;
}

/** Both fighters scaled to the lower of their two levels. */
function levelMatched(petA, petB) {
    const level = Math.min(petA.level ?? 1, petB.level ?? 1);
    return [atLevel(petA, level), atLevel(petB, level)];
}

/**
 * Build a scaled "wild" opponent pet near the given level for PvE battles.
 */
function makeWildPet(level, rng = Math.random) {
    const pick = WILD_OPPONENTS[Math.floor(rng() * WILD_OPPONENTS.length)];
    const lvl  = Math.max(1, level + Math.floor(rng() * 3) - 1); // ±1 around the player
    return {
        petId: pick.petId, name: pick.name, personality: pick.personality,
        level: lvl, evolutionStage: stageForLevel(lvl), hunger: 100, wild: true,
    };
}

// ── Pet of the Week ───────────────────────────────────────────────────────────
//
// The one part of this module that reaches the database and Discord: the weekly
// sweep that crowns each guild's most-loved pet. It moved here from
// schedulerService.js in #931 — the ribbon it sets, the counter it clears and
// the sprite it posts are all pet mechanics, and they belong beside them.
//
// It does not schedule itself. It is registered as a job in
// `services/scheduler/index.js`, which owns the cron expression and runs it
// through `runJob` — so a throw is recorded on the health payload and filed as
// a dead-letter entry, and a tick is dropped rather than overlapped while the
// previous run is still going (#611).

// Pet of the Week payout. Overridable per guild via economy.potwReward.
const POTW_COIN_REWARD = 5_000;

/**
 * The name a member goes by in `guildId`, for text drawn on a card, or null
 * when neither the member nor the user can be fetched.
 */
async function ownerDisplayName(client, guildId, userId) {
    const settle = p => Promise.resolve(p).catch(() => null);
    const guild  = await settle(client.guilds.fetch(guildId));
    const member = await settle(guild?.members?.fetch?.(userId));
    if (member?.displayName) return member.displayName;
    const user = await settle(client.users?.fetch?.(userId));
    return user?.globalName ?? user?.username ?? null;
}

/**
 * Pick each guild's Pet of the Week and pay its owner — 5,000 coins by default,
 * overridable per guild with `economy.potwReward`.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function selectPetOfTheWeek(client) {
    const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
    const { generatePetSprite } = require('../utils/cardGenerator');
    const { logTransaction } = require('../utils/logTransaction');
    // Required here, not at the top: petStatusView requires this module.
    const { renderPetCard } = require('./petStatusView');

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const guilds  = await Guild.find({}, 'guildId economy potwLastRunAt').lean();

    for (const guildDoc of guilds) {
        const guildId = guildDoc.guildId;
        // Per-guild job, checked before the claim: a shard that cannot reach
        // this guild would otherwise take the week's claim and then have
        // nowhere to announce.
        if (!handlesGuild(guildId, client)) continue;

        try {
            // Atomic claim: only proceed if this guild hasn't been processed this week
            const claimed = await Guild.findOneAndUpdate(
                { guildId, $or: [{ potwLastRunAt: null }, { potwLastRunAt: { $lte: weekAgo } }] },
                { $set: { potwLastRunAt: new Date() } },
                { new: false }
            );
            if (!claimed) continue; // another worker already ran POTW for this guild this week

            // Pick the winner in the database rather than loading every user with a
            // pet into memory and scanning in JS.
            const [top] = await User.aggregate([
                { $match: { guildId, 'pets.0': { $exists: true } } },
                { $unwind: '$pets' },
                { $match: { 'pets.weeklyInteractions': { $gt: 0 } } },
                // Capped daily credit makes ties at the top common, so break
                // them on progression rather than on whatever order the
                // documents happen to come back in.
                { $sort: { 'pets.weeklyInteractions': -1, 'pets.level': -1, 'pets.xp': -1, 'pets.adoptedAt': 1 } },
                { $limit: 1 },
                { $project: { _id: 0, userId: 1, pet: '$pets' } },
            ]);

            // Crown the winner BEFORE clearing counters. Doing it the other way
            // round meant a failure between the two left the week with no POTW and
            // the counts already wiped, with nothing to recompute from.
            if (top?.pet?._id) {
                await User.updateOne(
                    { guildId, userId: top.userId, 'pets._id': top.pet._id },
                    { $set: { 'pets.$.potw': true } }
                );
            }

            // Clear last week's ribbons and counters, leaving the new winner's flag.
            // Two writes rather than one: mixing $[] and $[old] over the same array
            // in a single $set is a path conflict MongoDB can reject.
            await User.updateMany(
                { guildId },
                { $set: { 'pets.$[old].potw': false } },
                { arrayFilters: [{ 'old._id': { $ne: top?.pet?._id ?? null } }] }
            );
            await User.updateMany({ guildId }, { $set: { 'pets.$[].weeklyInteractions': 0 } });

            if (!top?.pet) continue;
            const bestUser  = { userId: top.userId };
            const bestPet   = top.pet;
            const bestCount = bestPet.weeklyInteractions ?? 0;

            // Winning is worth something now — it used to be a flag and an embed.
            const potwCoins = guildDoc.economy?.potwReward ?? POTW_COIN_REWARD;
            if (potwCoins > 0) {
                const paid = await User.findOneAndUpdate(
                    { guildId, userId: bestUser.userId },
                    { $inc: { balance: potwCoins } },
                    { new: true }
                );
                // `null` means no document matched — the winner's record was
                // pruned between the aggregation above and this write — so
                // nothing was credited. The ledger entry is written only for a
                // credit that landed: one without a matching credit claims
                // coins nobody was paid.
                if (paid) {
                    logTransaction({
                        userId: bestUser.userId, guildId, type: 'potw_reward', amount: potwCoins,
                        balance: paid.balance, note: 'Pet of the Week reward',
                    });
                } else {
                    console.error(
                        `[scheduler] selectPetOfTheWeek could not pay ${potwCoins} coins to ` +
                        `${bestUser.userId} in ${guildId} — no user document matched`,
                    );
                }
            }

            // Determine announcement channel
            let channelId = guildDoc.economy?.announcementChannelId ?? null;
            if (!channelId) {
                const dg = await client.guilds.fetch(guildId).catch(() => null);
                if (dg) channelId = dg.systemChannelId ?? null;
            }
            if (!channelId) continue;

            const def      = PET_DEFINITIONS[bestPet.petId];
            const name     = bestPet.name || def?.name || bestPet.petId;
            const bond     = effectiveBond(bestPet);
            const times    = `${bestCount} care interaction${bestCount !== 1 ? 's' : ''} this week`;

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('🌟 Pet of the Week!')
                .setDescription(
                    `This week's most beloved pet is:\n\n` +
                    `${getPetDisplay(bestPet).emoji} **${name}** — owned by <@${bestUser.userId}>\n\n` +
                    `_${times}_`
                )
                .addFields({ name: '❤️ Bond', value: `${heartBar(bond)} ${bondTierFor(bond).title} (${Math.floor(bond)})`, inline: true })
                .setFooter({ text: 'Earn the ribbon by feeding, playing with, or training your pet!' })
                .setTimestamp();

            // Only advertise a prize when one is actually paid; potwReward can be 0.
            if (potwCoins > 0) {
                embed.addFields({ name: '🏆 Prize', value: `${potwCoins.toLocaleString()} coins`, inline: true });
            }

            // The winner's companion card, as /pet status and Showcase draw it
            // (#1189), with the ribbon on and the week's care count in the
            // footer. The emoji-on-a-circle sprite is only the fallback now, for
            // when the card cannot be drawn. The canvas cannot draw a mention,
            // so the kicker names the owner by display name.
            const ownerName = await ownerDisplayName(client, guildId, bestUser.userId);
            let files = [];
            const card = await renderPetCard({ ...bestPet, potw: true }, {
                kicker:      ownerName ? `Most beloved pet · owned by ${ownerName}` : "This week's most beloved pet",
                footerLeft:  times,
                footerRight: 'Pet of the Week',
            }, 'potw-card.png');
            if (card) {
                embed.setImage(`attachment://${card.name}`);
                files = [card];
            } else {
                try {
                    const spriteBuf = await generatePetSprite(bestPet.petId, 80, bestPet.evolutionStage ?? 1);
                    embed.setThumbnail('attachment://potw_sprite.png');
                    files = [new AttachmentBuilder(spriteBuf, {
                        name: 'potw_sprite.png',
                        description: `Pixel-art sprite of ${name}, the pet of the week.`,
                    })];
                } catch { /* non-critical */ }
            }

            await postAnnouncement(client, guildId, channelId, { embeds: [embed], files });
        } catch (err) {
            console.error(`[scheduler] selectPetOfTheWeek failed for guild ${guildId}:`, err.message);
        }
    }
}

module.exports = {
    PET_DEFINITIONS,
    WILD_OPPONENTS,
    WILD_PET_IDS,
    PERSONALITY_TRAITS,
    PERSONALITY_KEYS,
    TRAIT_FLAVOR,
    RARE_PET_DROP_CHANCE,
    rarePetForSource,
    createPet,
    sanitizePetName,
    PET_NAME_MAX,
    resolvePetRef,
    rollRarePet,
    BASE_PET_SLOTS,
    MAX_SLOT_EXPANSIONS,
    petCapacity,
    countSlotPets,
    hasFreePetSlot,
    tryGrantRarePet,
    noteCodex,
    codexSpecies,
    rarePetHint,
    VACATION_MAX_DAYS,
    isOnVacation,
    pausedMsBetween,
    activeVacation,
    joinVacation,
    startVacation,
    endVacation,
    HUNGER_DECAY_PER_DAY,
    MS_PER_DAY,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    MOOD_LINES,
    applyHungerDecay,
    decaySince,
    effectiveHunger,
    isPetActive,
    pickDefenderPet,
    MAX_STACKED_BONUS_PCT,
    checkRunaway,
    feedPet,
    isPetFull,
    POTW_DAILY_INTERACTION_CAP,
    recordPetInteraction,
    getPetBonus,
    getTotalBonus,
    CHANCE_BONUS_TYPES,
    petBonusParts,
    formatPetBonus,
    petChanceBonus,
    getMoodLine,
    getMoodBand,
    getMoodAction,
    getMoodColor,
    SPECIES_ACTIONS,
    petCompanionLine,
    heartBar,
    BOND_MAX,
    BOND_DAILY_CAP,
    BOND_CARE,
    BOND_HUNGRY_DECAY_PER_DAY,
    BOND_RUNAWAY_PENALTY,
    BOND_TIERS,
    effectiveBond,
    bondTierFor,
    getBondTier,
    recordBondCare,
    bondAfterRunaway,
    TRAIN_FOCUSES,
    TRAIN_FOCUS_KEYS,
    TRAIN_MAX_SESSIONS,
    TRAIN_HUNGER_COST,
    TRAIN_COOLDOWN_MS,
    trainingSessions,
    trainingBonus,
    trainingPct,
    trainCooldownMinutes,
    canTrain,
    trainPet,
    assignPersonality,
    // Progression & battles
    PET_MAX_LEVEL,
    XP_FEED_FAVORITE,
    XP_FEED_OTHER,
    XP_BATTLE_WIN,
    XP_BATTLE_LOSS,
    XP_WILD_WIN,
    XP_WILD_LOSS,
    xpForLevel,
    stageForLevel,
    getPetDisplay,
    getEffectiveBonusPct,
    applyPetXp,
    evolutionSummary,
    getPetStats,
    firstStrikeChance,
    PERSONALITY_COMBAT,
    RARE_COMBAT_EDGE,
    SPECIES_MOVES,
    getSpeciesMove,
    simulateBattle,
    createBattle,
    battleOngoing,
    runExchanges,
    battleVerdict,
    STANCES,
    STANCE_KEYS,
    STANCE_WIN_MULT,
    STANCE_LOSE_MULT,
    STANCE_ROUNDS,
    STANCE_EXCHANGES,
    stanceOutcome,
    randomStance,
    fightStanceRound,
    simulateStanceBattle,
    makeWildPet,
    levelMatched,
    // Scheduled work (see services/scheduler/index.js)
    selectPetOfTheWeek,
};
