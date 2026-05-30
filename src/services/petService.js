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

        const isResting = pet.restUntil && new Date(pet.restUntil).getTime() > now;
        const decayRate = isResting ? HUNGER_DECAY_RESTING : HUNGER_DECAY_PER_DAY;
        const decay = daysPassed * decayRate;
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
 */
function getTotalBonus(pets, bonusType) {
    let total = 0;
    for (const pet of pets) {
        const bonus = getPetBonus(pet);
        if (bonus && bonus.bonusType === bonusType) {
            total += bonus.bonusPct;
        }
    }
    return total;
}

module.exports = {
    PET_DEFINITIONS,
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
};
