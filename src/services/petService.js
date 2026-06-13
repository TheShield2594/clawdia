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
    },
    energetic: {
        hunt: (name, emoji) => `${emoji} **${name}** races ahead, picking up a trail before you even start!`,
        fish: (name, emoji) => `${emoji} **${name}** splashes excitedly, nudging fish toward your hook!`,
        mine: (name, emoji) => `${emoji} **${name}** digs alongside you with boundless enthusiasm!`,
    },
    mischievous: {
        hunt: (name, emoji) => `${emoji} **${name}** keeps watch while you case the area... suspiciously well.`,
        fish: (name, emoji) => `${emoji} **${name}** nudges your rod just enough to keep things interesting.`,
        mine: (name, emoji) => `${emoji} **${name}** "accidentally" dislodges a promising-looking boulder.`,
    },
    loyal: {
        hunt: (name, emoji) => `${emoji} **${name}** stays close, alert for any sign of danger.`,
        fish: (name, emoji) => `${emoji} **${name}** watches the line intently, refusing to look away.`,
        mine: (name, emoji) => `${emoji} **${name}** stands guard at the tunnel entrance, unwavering.`,
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
    crystal_fox:  { petId: 'crystal_fox', emoji: '💎', name: 'Crystal Fox', cost: null,  purchasable: false, bonusType: 'mine_yield',        bonusPct: 15, favoriteMaterial: 'crystal_sliver', materialSource: 'mine' }
};

const HUNGER_DECAY_PER_DAY = 10;
const HUNGER_DECAY_RESTING  = 5;   // half-speed decay while resting
const HUNGER_RESTORE_FAVORITE = 25;
const HUNGER_RESTORE_OTHER = 10;
const STARVING_THRESHOLD = 30;
const RUNAWAY_DAYS = 3;
const MS_PER_DAY = 86400000;

// ── Mood system ───────────────────────────────────────────────────────────────

const MOOD_LINES = {
    blissful: [
        '"I could nap here forever... this is the life."',
        '"You fed me so well — I might just purr until tomorrow."',
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

function getMoodBand(hunger) {
    if (hunger >= 90) return 'blissful';
    if (hunger >= 50) return 'content';
    if (hunger >= 20) return 'pleading';
    return 'concerning';
}

function getMoodLine(pet) {
    const band = getMoodBand(pet.hunger);
    const lines = MOOD_LINES[band];
    const dayIndex = Math.floor(Date.now() / 86400000);
    const petHash  = (pet.petId  || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const nameHash = (pet.name   || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return lines[(petHash + nameHash + dayIndex) % lines.length];
}

function getMoodColor(hunger) {
    if (hunger >= 90) return '#4caf50'; // blissful — green
    if (hunger >= 50) return '#ff9800'; // content  — orange
    if (hunger >= 20) return '#f44336'; // pleading — red
    return '#9c27b0';                   // concerning — purple
}

const HEART_BAR_LENGTH = 8;
function heartBar(bondDays) {
    const filled = Math.min(Math.floor(bondDays / 10), HEART_BAR_LENGTH);
    return '❤️'.repeat(filled) + '🖤'.repeat(HEART_BAR_LENGTH - filled);
}

/**
 * Apply daily hunger decay to all pets. Call from a scheduled job or lazily on pet commands.
 * Returns the updated pet array.
 *
 * Idempotent: advances lastFed by the processed days so repeated calls
 * don't re-apply the same decay. starvingStartAt is only set when hunger
 * reaches 0 (not merely below the STARVING_THRESHOLD) so checkRunaway
 * counts time at zero hunger only.
 */
function applyHungerDecay(pets) {
    const now = Date.now();
    return pets.map(pet => {
        const lastFed = pet.lastFed ? new Date(pet.lastFed).getTime() : now;
        const daysPassed = Math.floor((now - lastFed) / MS_PER_DAY);
        if (daysPassed <= 0) return pet;

        // Prorate decay: compute overlap of the decay window with the rest window
        const REST_WINDOW_MS  = 2 * 60 * 60 * 1000; // rest lasts 2 hours
        const restUntilMs     = pet.restUntil ? new Date(pet.restUntil).getTime() : 0;
        const restStartMs     = restUntilMs - REST_WINDOW_MS;
        const restedMs        = restUntilMs > 0
            ? Math.max(0, Math.min(restUntilMs, now) - Math.max(restStartMs, lastFed))
            : 0;
        const restedDays      = restedMs / MS_PER_DAY;
        const normalDays      = Math.max(0, daysPassed - restedDays);
        const decay           = restedDays * HUNGER_DECAY_RESTING + normalDays * HUNGER_DECAY_PER_DAY;
        const newHunger = Math.max(0, pet.hunger - decay);
        // Advance the decay cursor by the days processed so re-calls are no-ops
        const newLastFed = new Date(lastFed + daysPassed * MS_PER_DAY);

        // Only start the runaway clock when hunger hits 0
        const wasAtZero = pet.hunger === 0;
        const nowAtZero = newHunger === 0;
        const newStarvingStartAt = (nowAtZero && !wasAtZero) ? new Date() : pet.starvingStartAt;

        return {
            ...pet.toObject ? pet.toObject() : pet,
            hunger: newHunger,
            lastFed: newLastFed,
            starving: newHunger < STARVING_THRESHOLD,
            starvingStartAt: newStarvingStartAt
        };
    });
}

/**
 * Check which pets have been at zero hunger for 3+ days (runaway).
 * Returns { keepPets, ranAwayPets }.
 */
function checkRunaway(pets) {
    const now = Date.now();
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
function feedPet(pet, materialId) {
    const def = PET_DEFINITIONS[pet.petId];
    if (!def) return null;

    const isFavorite = def.favoriteMaterial === materialId;
    const restored = isFavorite ? HUNGER_RESTORE_FAVORITE : HUNGER_RESTORE_OTHER;
    const newHunger = Math.min(100, pet.hunger + restored);

    return { hunger: newHunger, restored, isFavorite };
}

/**
 * Returns the active passive bonus for a pet (only if hunger >= STARVING_THRESHOLD).
 */
function getPetBonus(pet) {
    if (!pet || pet.hunger < STARVING_THRESHOLD) return null;
    return PET_DEFINITIONS[pet.petId] ?? null;
}

/**
 * Get total bonus of a given type from all active pets.
 * Uses each pet's *effective* bonus (scaled by evolution + level), so investing
 * in a pet meaningfully improves its passive.
 */
function getTotalBonus(pets, bonusType) {
    let total = 0;
    for (const pet of pets) {
        const bonus = getPetBonus(pet);
        if (bonus && bonus.bonusType === bonusType) {
            total += getEffectiveBonusPct(pet);
        }
    }
    return total;
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
const EVOLVED_EMOJI = {
    dog:         { 2: '🐕',  3: '🐺' },
    cat:         { 2: '🐈',  3: '🐅' },
    bird:        { 2: '🦜',  3: '🦅' },
    fish:        { 2: '🐟',  3: '🦈' },
    fox:         { 2: '🦊',  3: '🌟' },
    wolf:        { 2: '🐺',  3: '🌑' },
    eagle:       { 2: '🦅',  3: '⚡' },
    shark:       { 2: '🦈',  3: '🌊' },
    crystal_fox: { 2: '💎',  3: '🔮' },
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
    const def   = PET_DEFINITIONS[pet.petId] ?? { emoji: '🐾', name: pet.petId };
    const stage = pet.evolutionStage ?? 1;
    const emoji = EVOLVED_EMOJI[pet.petId]?.[stage] ?? def.emoji;
    const title = EVOLUTION_TITLES[stage] ?? '';
    const baseName = pet.name || def.name;
    return { emoji, name: baseName, titledName: `${title}${baseName}`.trim() };
}

/**
 * Effective passive bonus % for a pet (base × stage × per-level growth), capped.
 */
function getEffectiveBonusPct(pet) {
    const def = PET_DEFINITIONS[pet.petId];
    if (!def) return 0;
    const stage = pet.evolutionStage ?? 1;
    const level = pet.level ?? 1;
    const mult  = Math.min(
        MAX_EFFECTIVE_BONUS_MULT,
        (STAGE_BONUS_MULT[stage] ?? 1.0) + (level - 1) * PER_LEVEL_BONUS_GROWTH
    );
    return Math.round(def.bonusPct * mult * 10) / 10;
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

// ── Battle engine ───────────────────────────────────────────────────────────

// Personalities tilt combat stats: each leans into attack/defense/speed.
const PERSONALITY_COMBAT = {
    energetic:   { atk: 2, def: 0, spd: 2 },
    mischievous: { atk: 2, def: 1, spd: 1 },
    loyal:       { atk: 1, def: 3, spd: 0 },
    lazy:        { atk: 0, def: 2, spd: 1 },
};

/**
 * Derive battle stats from a pet's level, evolution, and personality.
 */
function getPetStats(pet) {
    const level = pet.level ?? 1;
    const stage = pet.evolutionStage ?? 1;
    const p     = PERSONALITY_COMBAT[pet.personality] ?? { atk: 1, def: 1, spd: 1 };
    return {
        hp:  40 + level * 6 + stage * 10,
        atk: 8  + level * 2 + stage * 3 + p.atk,
        def: 4  + level * 1 + stage * 2 + p.def,
        spd: 5  + level + p.spd,
    };
}

/**
 * Simulate a battle between two pets. `rng` is injectable for testing.
 * Returns { winner: 'a'|'b', rounds, finalHpA, finalHpB }.
 */
function simulateBattle(petA, petB, rng = Math.random) {
    const a = getPetStats(petA);
    const b = getPetStats(petB);
    let hpA = a.hp, hpB = b.hp;
    const rounds = [];

    // Faster pet strikes first each round.
    let turnA = a.spd >= b.spd;
    const MAX_ROUNDS = 30;

    for (let r = 0; r < MAX_ROUNDS && hpA > 0 && hpB > 0; r++) {
        const atk = turnA ? a : b;
        const def = turnA ? b : a;
        // Damage = atk - def/2, ±25% variance, min 1; ~10% crit for 1.5x.
        const base     = Math.max(1, atk.atk - def.def / 2);
        const variance = 0.75 + rng() * 0.5;
        const crit     = rng() < 0.10 ? 1.5 : 1.0;
        const damage   = Math.max(1, Math.round(base * variance * crit));

        if (turnA) hpB = Math.max(0, hpB - damage);
        else       hpA = Math.max(0, hpA - damage);

        rounds.push({ attacker: turnA ? 'a' : 'b', damage, crit: crit > 1, hpA, hpB });
        turnA = !turnA;
    }

    // On HP tie / round cap, higher remaining HP fraction wins; final tiebreak: A.
    let winner;
    if (hpA <= 0 && hpB <= 0) winner = hpA >= hpB ? 'a' : 'b';
    else if (hpB <= 0) winner = 'a';
    else if (hpA <= 0) winner = 'b';
    else winner = (hpA / a.hp) >= (hpB / b.hp) ? 'a' : 'b';

    return { winner, rounds, finalHpA: hpA, finalHpB: hpB };
}

/**
 * Build a scaled "wild" opponent pet near the given level for PvE battles.
 */
function makeWildPet(level, rng = Math.random) {
    const WILD = [
        { petId: 'wild_boar',   name: 'Wild Boar',   personality: 'energetic' },
        { petId: 'feral_cat',   name: 'Feral Cat',   personality: 'mischievous' },
        { petId: 'stray_hound', name: 'Stray Hound', personality: 'loyal' },
        { petId: 'cave_bat',    name: 'Cave Bat',    personality: 'energetic' },
    ];
    const pick = WILD[Math.floor(rng() * WILD.length)];
    const lvl  = Math.max(1, level + Math.floor(rng() * 3) - 1); // ±1 around the player
    return {
        petId: pick.petId, name: pick.name, personality: pick.personality,
        level: lvl, evolutionStage: stageForLevel(lvl), hunger: 100, wild: true,
    };
}

module.exports = {
    PET_DEFINITIONS,
    PERSONALITY_TRAITS,
    PERSONALITY_KEYS,
    TRAIT_FLAVOR,
    HUNGER_DECAY_PER_DAY,
    MS_PER_DAY,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    MOOD_LINES,
    applyHungerDecay,
    checkRunaway,
    feedPet,
    getPetBonus,
    getTotalBonus,
    getMoodLine,
    getMoodColor,
    heartBar,
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
    getPetStats,
    simulateBattle,
    makeWildPet,
};
