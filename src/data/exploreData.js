'use strict';

// World Exploration data tables.
// Regions, weighted event tables, secrets, lore fragments, landmarks, relics,
// and explorer progression. All user-facing strings are written in Clawdia's
// voice: dry, ancient, a little amused, always watching.

// ─── LIMITS ──────────────────────────────────────────────────────────────────

const LIMITS = {
    EXPLORE_COOLDOWN_MS:  60_000,
    INJURY_PENALTY_MS:    10 * 60_000,
    STAMINA_REGEN_MS:     5 * 60_000,
    MAX_STAMINA:          10,
    DAILY_WINDOW_MS:      24 * 3_600_000,
    // The first DAILY_SOFT_CAP coins of a rolling 24h window pay in full. Past
    // it the wilds keep paying, just worse — SOFT_CAP_RATE of face value — until
    // DAILY_HARD_CAP, where they stop. Hunting, fishing and mining all ramp down
    // this way; exploration used to drop straight from full rate to nothing at
    // 100k, which walled a deep-region player about two hours into a session.
    // The soft cap sits exactly where the old hard cap did, so no expedition
    // pays less than it used to — the cliff just grew a slope on the far side.
    DAILY_SOFT_CAP:       100_000,
    DAILY_SOFT_CAP_RATE:  0.5,
    DAILY_HARD_CAP:       150_000,
    JOURNAL_CAP:          20,
    // Secret pity: each expedition without a secret adds bonus weight to the
    // secret slot, so long droughts self-correct. Only expeditions into a
    // region that still HAS an unfound secret count toward it.
    SECRET_PITY_PER_RUN:  0.15,
    SECRET_PITY_MAX:      6,
    // Charting a region to 100% pays a standing bonus on everything it drops,
    // so finishing a map is a reward rather than a retirement.
    SURVEY_BONUS:         0.15,
    // Each DISTINCT relic in your collection is worth a small standing payout
    // bonus, capped so a full set is a nice edge and not a second economy.
    RELIC_BONUS_PER:      0.01,
    RELIC_BONUS_MAX:      0.10,
};

// ─── EXPLORER PROGRESSION ────────────────────────────────────────────────────
// xpRequired is the cumulative explorer XP needed to REACH that level.

const EXPLORER_LEVELS = [
    { level: 1,  xpRequired: 0,      title: 'Doorstep Wanderer' },
    { level: 2,  xpRequired: 120,    title: 'Doorstep Wanderer' },
    { level: 3,  xpRequired: 280,    title: 'Doorstep Wanderer' },
    { level: 4,  xpRequired: 500,    title: 'Pathfinder' },
    { level: 5,  xpRequired: 800,    title: 'Pathfinder' },
    { level: 6,  xpRequired: 1_200,  title: 'Pathfinder' },
    { level: 7,  xpRequired: 1_700,  title: 'Wayfarer' },
    { level: 8,  xpRequired: 2_300,  title: 'Wayfarer' },
    { level: 9,  xpRequired: 3_000,  title: 'Wayfarer' },
    { level: 10, xpRequired: 3_900,  title: 'Trailblazer' },
    { level: 11, xpRequired: 5_000,  title: 'Trailblazer' },
    { level: 12, xpRequired: 6_300,  title: 'Trailblazer' },
    { level: 13, xpRequired: 7_800,  title: 'Cartographer' },
    { level: 14, xpRequired: 9_500,  title: 'Cartographer' },
    { level: 15, xpRequired: 11_500, title: 'Cartographer' },
    { level: 16, xpRequired: 13_800, title: 'Horizon Chaser' },
    { level: 17, xpRequired: 16_400, title: 'Horizon Chaser' },
    { level: 18, xpRequired: 19_300, title: 'Horizon Chaser' },
    { level: 19, xpRequired: 22_600, title: 'Edge of the Map' },
    { level: 20, xpRequired: 26_300, title: 'Edge of the Map' },
    { level: 21, xpRequired: 30_400, title: 'Edge of the Map' },
    { level: 22, xpRequired: 35_000, title: 'Mythwalker' },
    { level: 23, xpRequired: 40_100, title: 'Mythwalker' },
    { level: 24, xpRequired: 45_800, title: 'Mythwalker' },
    { level: 25, xpRequired: 52_100, title: 'The Map Remembers You' },
    { level: 26, xpRequired: 59_100, title: 'The Map Remembers You' },
    { level: 27, xpRequired: 66_800, title: 'The Map Remembers You' },
    { level: 28, xpRequired: 75_300, title: 'Legend of the Blank Spaces' },
    { level: 29, xpRequired: 84_700, title: 'Legend of the Blank Spaces' },
    { level: 30, xpRequired: 95_000, title: 'Legend of the Blank Spaces' },
];

// Explorer XP awarded per event type
const EVENT_XP = {
    discovery:        30,
    lore:             25,
    treasure:         20,
    encounter_win:    35,
    encounter_safe:   15,
    encounter_loss:   10,
    trap:             10,
    secret:           100,
    quiet:            8,
    // One-off, the first time a region has nothing left to hide from you
    survey:           250,
};

// Treasure rarity roll: weight + coin range (before region/guild multipliers)
const TREASURE_TIERS = [
    { tier: 'common',    weight: 46, min: 150,   max: 400,    relicChance: 0.00, stars: '⭐' },
    { tier: 'uncommon',  weight: 30, min: 400,   max: 900,    relicChance: 0.05, stars: '⭐⭐' },
    { tier: 'rare',      weight: 16, min: 1_200, max: 2_500,  relicChance: 0.35, stars: '⭐⭐⭐' },
    { tier: 'epic',      weight: 6,  min: 3_000, max: 6_000,  relicChance: 0.70, stars: '⭐⭐⭐⭐' },
    { tier: 'legendary', weight: 2,  min: 8_000, max: 15_000, relicChance: 1.00, stars: '⭐⭐⭐⭐⭐' },
];

const TIER_COLORS = {
    common:    '#9e9e9e',
    uncommon:  '#4caf50',
    rare:      '#2196f3',
    epic:      '#9c27b0',
    legendary: '#ff9800',
};

// ─── REGIONS ─────────────────────────────────────────────────────────────────
// Core regions are always available (level/coin gated). Seasonal regions only
// open while their seasonal event is running on the guild, and are free to
// enter — the calendar is the gate.

const REGIONS = {
    // ── Core: starter region ─────────────────────────────────────────────────
    whispering_forest: {
        id: 'whispering_forest',
        name: 'Whispering Forest',
        emoji: '🌲',
        color: '#2e7d32',
        defaultUnlocked: true,
        unlockLevel: 1,
        unlockCost: 0,
        payoutMultiplier: 1.0,
        tagline: 'The trees talk. Mostly about you.',
        description: 'Old pines, older shadows. The forest has opinions about visitors and shares them in a language of creaks and falling needles.',
        intros: [
            'You step under the canopy. The light goes green and the noise of the world politely excuses itself.',
            'The forest notices you immediately. It pretends it didn\'t. You pretend you didn\'t notice it noticing.',
            'Pine needles. Damp earth. Somewhere ahead, something that is not wind moves through the branches.',
            'The path in is easy to find. The paths out keep rearranging themselves. Typical.',
        ],
        eventWeights: { encounter: 22, discovery: 18, trap: 14, treasure: 22, lore: 14, secret: 3, quiet: 7 },
        landmarks: [
            { id: 'wf_hollow_oak',      name: 'The Hollow Oak',         line: 'An oak big enough to live in. Judging by the tea set inside, something already does.' },
            { id: 'wf_mossy_shrine',    name: 'Moss-Eaten Shrine',      line: 'A shrine to a forgotten god of small comforts. The offerings are acorns. All of them recent.' },
            { id: 'wf_silver_brook',    name: 'Silverthread Brook',     line: 'The water runs uphill on Tuesdays. Today is Tuesday. You decide not to think about it.' },
            { id: 'wf_hanging_garden',  name: 'The Hanging Garden',     line: 'Flowers growing upside-down from a stone arch. They turn to face you. Slowly.' },
            { id: 'wf_owl_court',       name: 'Court of Owls',          line: 'A clearing ringed with owl statues. You count nine. On the way out you count ten.' },
        ],
        lore: [
            { id: 'wf_lore_1', text: '“The forest was planted in a single night. Nobody remembers by whom. The trees remember. They\'re not telling.”' },
            { id: 'wf_lore_2', text: '“Travelers report whispers naming their childhood pets. The forest insists this is a coincidence.”' },
            { id: 'wf_lore_3', text: '“A woodcutter once took an axe to the Hollow Oak. The oak is fine. The axe is now part of the shrine. So is the woodcutter\'s hat.”' },
            { id: 'wf_lore_4', text: '“Silverthread Brook is said to carry wishes downstream. Upstream, it carries refunds.”' },
            { id: 'wf_lore_5', text: '“The tenth owl statue predates the other nine. The other nine are watching it.”' },
        ],
        encounters: [
            {
                id: 'wf_enc_stag',
                name: 'The Pale Stag',
                emoji: '🦌',
                intro: 'A stag the color of moonlight stands in the path. Its antlers hold seven lit candles. It is waiting for you to do something interesting.',
                winChance: 0.55,
                reward: { min: 900, max: 1_800 },
                winLine: 'You hold its gaze and bow, just slightly. The stag inclines its head — a candle drips wax that hardens into coins at your feet. Apparently you passed.',
                loseLine: 'You blink first. The stag huffs, the candles snuff out, and you spend twenty minutes finding the path again in the dark.',
                safeLine: 'You watch from the ferns and let it pass. It leaves hoofprints full of soft silver light. You scoop up a little. It spends fine.',
            },
            {
                id: 'wf_enc_mushroom',
                name: 'The Mushroom Circle Bargainer',
                emoji: '🍄',
                intro: 'A ring of mushrooms, and in the middle, a very small person in a very large hat offering you a deal in a voice like rustling leaves.',
                winChance: 0.50,
                reward: { min: 800, max: 1_600 },
                winLine: 'You haggle. It haggles back. You haggle harder. It tips the enormous hat, impressed, and pays you for the entertainment.',
                loseLine: 'You shake on the deal before reading the fine print written on a leaf. The leaf blows away. So does some of your dignity, and a few coins.',
                safeLine: 'You decline politely from OUTSIDE the circle. The bargainer nods — smart — and tosses you a tip for knowing the rules.',
            },
            {
                id: 'wf_enc_wolfshade',
                name: 'A Wolf Made of Dusk',
                emoji: '🐺',
                intro: 'Between two pines stands a wolf with no edges — just dusk in the shape of one. It does not growl. That is somehow worse.',
                winChance: 0.45,
                reward: { min: 1_100, max: 2_200 },
                winLine: 'You stand very still and let it sniff your shadow. It takes a small bite of it — you won\'t miss it — and leaves payment in old coins. Fair trade.',
                loseLine: 'You step back. Wrong move. The dusk-wolf swallows your lantern light and your sense of direction, and the forest charges a finder\'s fee.',
                safeLine: 'You give it the path and take the long way. From behind, you see it\'s carrying something shiny. It drops a piece. Deliberately, you think.',
            },
        ],
        traps: [
            { id: 'wf_trap_roots',  name: 'Grasping Roots',     line: 'The roots were lying flat until exactly the moment you stepped on them. You leave the forest minus some coins and most of one boot heel.', penalty: { min: 150, max: 500 }, injuryChance: 0.20 },
            { id: 'wf_trap_pollen', name: 'Dreaming Pollen',    line: 'A flower exhales gold dust in your face. You wake up two hours later with a flower crown you didn\'t make and lighter pockets you didn\'t empty.', penalty: { min: 200, max: 600 }, injuryChance: 0.30 },
            { id: 'wf_trap_path',   name: 'The Path That Lies', line: 'The trail loops you back to where you started, three times, smugly. The toll for the lesson is whatever fell out of your pockets while you ran.', penalty: { min: 100, max: 400 }, injuryChance: 0.10 },
        ],
        treasureLines: [
            'Half-buried under the moss: a strongbox the forest apparently forgot to digest.',
            'A hollow stump, and inside it, somebody\'s emergency stash. Their emergency is now your payday.',
            'You follow a magpie out of spite. The magpie, insulted, leads you straight to its hoard.',
        ],
        relics: [
            { itemId: 'Whisperwood Charm',  rarity: 'rare',      lore: 'A knot of pale wood that murmurs when storms are coming. Usually about the storms. Sometimes about you.' },
            { itemId: 'Candlewax Antler',   rarity: 'epic',      lore: 'A shed antler tip, still warm, still faintly lit. The Pale Stag does not do refunds.' },
            { itemId: 'The Tenth Owl',      rarity: 'legendary', lore: 'A small stone owl. It was a statue when you picked it up. It is lighter every morning.' },
        ],
        secrets: [
            { id: 'wf_secret_door',     name: 'The Door in the Oak',       reward: 4_000,  reveal: 'Behind the tea set in the Hollow Oak: a door six inches tall, and behind it, a stairway going down much further than the tree does. You mark it on your map. The map purrs.' },
            { id: 'wf_secret_song',     name: 'The Forest\'s True Name',   reward: 5_000,  reveal: 'At the exact center of the forest, the whispers overlap into a single word. You write it down without reading it aloud. Wise. The trees bow as you leave.' },
            { id: 'wf_secret_grove',    name: 'The Grove of Hung Lanterns', reward: 4_500, reveal: 'A hidden grove where hundreds of lanterns hang, one for every traveler the forest liked. A new one is already lit. It has your name on it.' },
            { id: 'wf_secret_warden',   name: 'The Sleeping Warden',       reward: 6_000,  reveal: 'Under the Court of Owls, something vast and feathered sleeps in a bed of acorns. You tiptoe out with a souvenir and the strong impression you were allowed to.' },
        ],
    },

    // ── Core: tier 2 ─────────────────────────────────────────────────────────
    crumbling_ruins: {
        id: 'crumbling_ruins',
        name: 'Crumbling Ruins',
        emoji: '🏛️',
        color: '#8d6e63',
        defaultUnlocked: false,
        unlockLevel: 5,
        unlockCost: 7_500,
        payoutMultiplier: 1.35,
        tagline: 'An empire fell here. It left the lights on.',
        description: 'Toppled columns, headless statues, and architecture that remembers being important. Everything is exactly one bad step from becoming more rubble.',
        intros: [
            'You climb over a fallen column carved with warnings. The warnings are in six languages. All of them say "really, don\'t."',
            'Dust, marble, silence. The kind of silence that used to be a city.',
            'A headless statue points dramatically at nothing. You follow the gesture anyway. It\'s only polite.',
            'Your footsteps echo twice. You only took one step. The ruins are padding their numbers.',
        ],
        eventWeights: { encounter: 20, discovery: 18, trap: 18, treasure: 22, lore: 14, secret: 3, quiet: 5 },
        landmarks: [
            { id: 'cr_amphitheater',  name: 'The Empty Amphitheater', line: 'Ten thousand stone seats facing a stage. When you step onto it, somewhere, faintly: applause.' },
            { id: 'cr_archive',       name: 'The Burned Archive',     line: 'Shelves of ash that still hold the shape of books. One shelf is untouched. Reserved, apparently.' },
            { id: 'cr_aqueduct',      name: 'The Dry Aqueduct',       line: 'A river of air where water ran for a thousand years. You can hear it remembering.' },
            { id: 'cr_throne',        name: 'The Backwards Throne',   line: 'A throne facing the wall. Whatever the last ruler didn\'t want to look at, it\'s still out there.' },
            { id: 'cr_sundial',       name: 'The Midnight Sundial',   line: 'A sundial that casts a shadow at night. It is currently pointing at you. It does this to everyone. Probably.' },
        ],
        lore: [
            { id: 'cr_lore_1', text: '“The empire did not fall to war or plague. The records say only: \'They finished.\' Finished what, the records decline to specify.”' },
            { id: 'cr_lore_2', text: '“Every statue in the ruins is missing its head. The heads were not removed. They left.”' },
            { id: 'cr_lore_3', text: '“The Burned Archive burned from the inside out. Librarians call this \'aggressive weeding.\'”' },
            { id: 'cr_lore_4', text: '“The last emperor\'s final decree is still posted in the forum. It reads, in full: \'Lock up when you leave.\'”' },
            { id: 'cr_lore_5', text: '“Coins minted here show a different face every time you look. Merchants accept them anyway. Faces aren\'t legal tender; the gold is.”' },
        ],
        encounters: [
            {
                id: 'cr_enc_curator',
                name: 'The Last Curator',
                emoji: '🗿',
                intro: 'A stone figure dusts a shelf of rubble with infinite patience. It turns. "The museum," it grinds, "is closed. Unless you\'re here to donate. Or withdraw."',
                winChance: 0.55,
                reward: { min: 1_300, max: 2_600 },
                winLine: 'You compliment the collection — specifically, sincerely. The Curator straightens with pride and processes your "early withdrawal" from the gift shop fund.',
                loseLine: 'You touch an exhibit. THE exhibit. The Curator escorts you out by the collar and bills you for the velvet rope you were definitely not behind.',
                safeLine: 'You take the guided tour from a respectful distance. At the end, the Curator tips YOU. The economy of ruins runs backwards.',
            },
            {
                id: 'cr_enc_echo',
                name: 'An Echo With Opinions',
                emoji: '🌀',
                intro: 'Your own voice comes back from the amphitheater — three seconds early. "Don\'t take the left stair," it says. You hadn\'t said anything yet.',
                winChance: 0.50,
                reward: { min: 1_200, max: 2_400 },
                winLine: 'You trust the echo. The left stair collapses behind you; the right one leads to somebody\'s abandoned strongroom. The echo says "you\'re welcome" before you can thank it.',
                loseLine: 'You take the left stair out of principle. The stair, also on principle, stops being a stair. The climb out costs you in coins and pride.',
                safeLine: 'You converse with the echo without moving an inch. It gets bored, sighs, and tells you where the small change is hidden just to end the conversation.',
            },
            {
                id: 'cr_enc_legion',
                name: 'The Off-Duty Legion',
                emoji: '⚔️',
                intro: 'A ghost legion drills in the forum, eternally. The phantom centurion squints at you. "Recruit?" he asks, hopefully. They\'ve been short-staffed for nine hundred years.',
                winChance: 0.45,
                reward: { min: 1_500, max: 3_000 },
                winLine: 'You drill with the dead for one hour and don\'t complain once. The centurion, moved nearly to tears, pays you a signing bonus from a pay chest that outlived the empire.',
                loseLine: 'You march left when the legion marches right. Nine hundred years of formation, ruined. The fine for breaking formation is older than your country.',
                safeLine: 'You salute crisply and keep walking. The legion returns it as one. A private jogs after you with "back pay" for a soldier you apparently resemble.',
            },
        ],
        traps: [
            { id: 'cr_trap_floor',   name: 'Optimistic Floor',     line: 'The mosaic floor was load-bearing in a strictly historical sense. You drop one story into the cellar and pay for your own rescue, which is also you.', penalty: { min: 250, max: 700 }, injuryChance: 0.30 },
            { id: 'cr_trap_curse',   name: 'Discount Curse',       line: 'You read the inscription aloud. Rookie move. It\'s a minor curse — everything you buy this week costs slightly more and the vendors can\'t explain why.', penalty: { min: 300, max: 800 }, injuryChance: 0.15 },
            { id: 'cr_trap_statue',  name: 'A Statue\'s Grudge',   line: 'You lean on a statue. The statue, headless and patient, has been waiting centuries for exactly this. Your coin pouch is lighter and the statue looks satisfied. Somehow. Without a head.', penalty: { min: 200, max: 600 }, injuryChance: 0.20 },
        ],
        treasureLines: [
            'Under the throne: the royal petty cash. The empire fell; its bookkeeping didn\'t.',
            'A locked strongbox in the archive, untouched by fire. The lock surrenders out of professional respect.',
            'You pry up the one mosaic tile that doesn\'t match. Beneath it, a tax collector\'s private retirement plan.',
        ],
        relics: [
            { itemId: 'Headless Coin',        rarity: 'rare',      lore: 'A coin from the ruins. The face changes when unobserved. The denomination, mercifully, does not.' },
            { itemId: 'Curator\'s Brass Key',  rarity: 'epic',      lore: 'Opens the museum gift shop, anywhere, even where there is no museum. Especially there.' },
            { itemId: 'The Final Decree',     rarity: 'legendary', lore: 'The last emperor\'s actual signet, pressed into wax that never fully cooled. It is still warm. It is still binding.' },
        ],
        secrets: [
            { id: 'cr_secret_vault',   name: 'The Treasury Below the Treasury', reward: 5_500, reveal: 'The imperial vault was a decoy. Beneath its floor: the real one, modest and full, with a note — "told you so." You map it. The map smells faintly of smoke.' },
            { id: 'cr_secret_heads',   name: 'Where the Heads Went',            reward: 6_500, reveal: 'A sealed garden where every statue\'s head rests on a plinth, facing the sky, smiling. They were not removed. They retired. One nods at you. You nod back and leave quickly.' },
            { id: 'cr_secret_clock',   name: 'The Hour That Never Struck',      reward: 5_000, reveal: 'Inside the sundial\'s base, a clockwork hour that was never released into the day. It ticks once when you find it. Somewhere, the empire gets one second longer.' },
            { id: 'cr_secret_door',    name: 'The Curator\'s Private Wing',     reward: 7_000, reveal: 'The Curator unlocks a wing that doesn\'t exist on any floor plan. "The good collection," it grinds. You may look. You may not touch. You are paid for looking. Museums have changed.' },
        ],
    },

    // ── Core: tier 3 ─────────────────────────────────────────────────────────
    crystal_caves: {
        id: 'crystal_caves',
        name: 'Crystal Caves',
        emoji: '💎',
        color: '#7e57c2',
        defaultUnlocked: false,
        unlockLevel: 12,
        unlockCost: 25_000,
        payoutMultiplier: 1.75,
        tagline: 'Everything down here reflects. Not everything reflects you.',
        description: 'Galleries of living crystal that hum in chords. Light goes in and comes out changed. So, occasionally, do explorers.',
        intros: [
            'The cave mouth exhales cold, mineral air. The crystals are already humming your arrival to each other.',
            'A thousand reflections of you walk in. You\'re fairly sure the same number walks each corridor. Fairly.',
            'The walls glow without a source. The dark down here had to be negotiated with, and the crystals won.',
            'You tap a crystal. It tings a perfect C. Three caverns away, something tings back, off-key, on purpose.',
        ],
        eventWeights: { encounter: 20, discovery: 16, trap: 18, treasure: 24, lore: 12, secret: 4, quiet: 6 },
        landmarks: [
            { id: 'cc_chandelier',   name: 'The Grand Chandelier',  line: 'A crystal formation the size of a cathedral, hanging point-down. It has never fallen. It is, the hum suggests, considering it.' },
            { id: 'cc_mirror_lake',  name: 'The Still Mirror Lake', line: 'Water so flat it shows the cavern ceiling perfectly — plus one extra stalactite that isn\'t there. You don\'t point. It might notice being noticed.' },
            { id: 'cc_singing_hall', name: 'The Singing Gallery',   line: 'Walk through and the crystals harmonize with your footsteps. Run, and it\'s opera. You walk. You\'re not ready for opera.' },
            { id: 'cc_geode_throne', name: 'The Geode Parlor',      line: 'A split geode big enough to sit in, furnished — by someone — with cushions. The cushions are warm.' },
            { id: 'cc_frozen_storm', name: 'The Frozen Lightning',  line: 'A bolt of lightning, caught mid-strike inside a crystal column a million years ago. It is still very angry about it.' },
        ],
        lore: [
            { id: 'cc_lore_1', text: '“The caves grow a new gallery every century. Surveyors gave up. The maps were always one room ahead of them.”' },
            { id: 'cc_lore_2', text: '“Crystals here record sound. Press your ear to the old ones and hear conversations a thousand years stale. Press your ear to the new ones and hear yourself, arriving.”' },
            { id: 'cc_lore_3', text: '“Miners never struck these veins. Every expedition reported the same thing: the tunnels they dug were already there by morning, tidier.”' },
            { id: 'cc_lore_4', text: '“The Mirror Lake has a depth of four inches and a reflection of four miles.”' },
            { id: 'cc_lore_5', text: '“Something keeps the Geode Parlor\'s cushions warm. The leading theory is hospitality.”' },
        ],
        encounters: [
            {
                id: 'cc_enc_reflection',
                name: 'Your Better Reflection',
                emoji: '🪞',
                intro: 'In a wall of polished amethyst, your reflection straightens its collar a half-second before you do. It smiles first, too. It seems to want to talk.',
                winChance: 0.50,
                reward: { min: 1_800, max: 3_600 },
                winLine: 'You play mirror with it and deliberately fumble. It corrects you — smug — and in doing so steps out of sync. The forfeit, by ancient cave rules, is paid in gems.',
                loseLine: 'You try to out-smug your own reflection. Bold. It mimics your coin pouch perfectly, and now yours is the copy. Lighter. Reflections round down.',
                safeLine: 'You wave, it waves, everyone behaves. As you leave it taps the glass and points down: a seam of gem dust at your feet. A tip, from you, to you.',
            },
            {
                id: 'cc_enc_chordwyrm',
                name: 'The Chord-Wyrm',
                emoji: '🐉',
                intro: 'A serpent of living crystal uncoils from the ceiling, scales ringing like a glass harp. It is not hungry. It is bored, which for dragons is more expensive.',
                winChance: 0.45,
                reward: { min: 2_200, max: 4_200 },
                winLine: 'You hum the third note of its chord — the one it can\'t reach. It rears, delighted, and sheds a handful of singing scales as applause. They\'re worth a fortune. They know it.',
                loseLine: 'You hum flat. The wyrm winces down to its tail, and the entire cavern winces with it. The acoustic fine is deducted in gemstones from your pack.',
                safeLine: 'You sit and just listen. An hour of glass-harp dragon music, free. On the way out you find it left you a scale anyway. Patronage, it turns out, pays.',
            },
            {
                id: 'cc_enc_lantern',
                name: 'The Lantern That Went Ahead',
                emoji: '🏮',
                intro: 'A miner\'s lantern floats down the gallery, lit, carried by absolutely no one. It pauses. It bobs, invitingly, toward a side passage that is not on your map.',
                winChance: 0.55,
                reward: { min: 1_600, max: 3_200 },
                winLine: 'You follow. The lantern leads you to a forgotten dig where the last crew left their wages and a note: "for whoever the light likes next." It likes you.',
                loseLine: 'You follow — then second-guess at a fork. The lantern, offended, blows itself out. The dark charges by the minute and accepts only coins.',
                safeLine: 'You decline with a small bow. The lantern dips, understanding, and drifts off — leaving a pinch of glowing oil on a rock for your trouble. It sells well.',
            },
        ],
        traps: [
            { id: 'cc_trap_resonance', name: 'Resonance Cascade',  line: 'You sneeze. The Singing Gallery answers — fortissimo. The avalanche of sound shakes loose your gear and your composure; you buy both back from the cave floor in scattered coins.', penalty: { min: 400, max: 1_000 }, injuryChance: 0.25 },
            { id: 'cc_trap_mirror',    name: 'The Wrong Turn Twin', line: 'You follow your reflection around a corner. Your reflection does not follow the same map. By the time you find the real corridor, something has audited your pockets.', penalty: { min: 350, max: 900 },  injuryChance: 0.15 },
            { id: 'cc_trap_shard',     name: 'Glass Garden',        line: 'A floor of crystal shards disguised as a floor of crystal floor. You make it across, mostly. Your boots and budget absorb the difference.', penalty: { min: 300, max: 800 },  injuryChance: 0.35 },
        ],
        treasureLines: [
            'A vein of gemstones grows around an old strongbox like the cave was gift-wrapping it for you.',
            'In the Geode Parlor, under the third cushion: somebody\'s rainy-day gems. It never rains down here. Their loss.',
            'The Mirror Lake\'s reflection shows a chest on the ceiling. The real one, naturally, is under the water. Four inches down. Heavy.',
        ],
        relics: [
            { itemId: 'Singing Scale',        rarity: 'rare',      lore: 'A scale from the Chord-Wyrm. Hums a perfect fifth when its former owner is in a good mood. It is usually humming.' },
            { itemId: 'Bottled Resonance',    rarity: 'epic',      lore: 'A sealed vial of the Singing Gallery\'s echo. Do not open indoors. Do not open outdoors. Lovely on a shelf.' },
            { itemId: 'Shard of the Frozen Storm', rarity: 'legendary', lore: 'A splinter of million-year-old lightning. Still bright. Still furious. Keep it away from the weather; it holds grudges.' },
        ],
        secrets: [
            { id: 'cc_secret_heart',   name: 'The Heart Facet',          reward: 8_000, reveal: 'At the caves\' center, one crystal beats — slow, patient, geological. Every other crystal is an echo of it. You sketch it quickly. Your pencil hums for a week.' },
            { id: 'cc_secret_choir',   name: 'The Recorded Choir',       reward: 7_000, reveal: 'A gallery of ancient crystals that replay, on touch, the voices of every explorer who ever made it this far. The newest crystal is blank. It records you saying "oh."' },
            { id: 'cc_secret_stair',   name: 'The Stair Below the Lake', reward: 7_500, reveal: 'The Mirror Lake\'s impossible reflection was a map. Under four inches of water: a stairway, dry, descending into a glow the color of which you have no name for. You note the door. You do not open it. Yet.' },
            { id: 'cc_secret_parlor',  name: 'The Host of the Parlor',   reward: 9_000, reveal: 'You finally meet who keeps the cushions warm: a vast, gentle thing of facets and firelight that has been hosting lost explorers since before the word "lost." It refreshes your tea and your finances. You are invited back.' },
        ],
    },

    // ── Core: tier 4 ─────────────────────────────────────────────────────────
    sunken_docks: {
        id: 'sunken_docks',
        name: 'Sunken Docks',
        emoji: '⚓',
        color: '#1565c0',
        defaultUnlocked: false,
        unlockLevel: 20,
        unlockCost: 60_000,
        payoutMultiplier: 2.25,
        tagline: 'The harbor drowned. Business hours continue.',
        description: 'A port city half-swallowed by a patient sea. Bells ring under the water at shift change, and the tide does the bookkeeping.',
        intros: [
            'Low tide. The drowned harbor surfaces its rooftops like it\'s checking if anyone\'s still waiting for a ship.',
            'Barnacled bollards, kelp-strung cranes. Beneath your boots, a cobblestone street and, beneath that, lamplight.',
            'A harbor bell rings under thirty feet of water. Right on schedule. The Docks never missed a shift; they just changed management.',
            'The gulls here don\'t cry. They mutter. Mostly figures, freight rates, and your name once, which you ignore.',
        ],
        eventWeights: { encounter: 22, discovery: 16, trap: 18, treasure: 24, lore: 12, secret: 4, quiet: 4 },
        landmarks: [
            { id: 'sd_lighthouse',   name: 'The Inverted Lighthouse', line: 'A lighthouse standing whole beneath the surface, beam sweeping the sea floor. It is looking for something. It has narrowed it down.' },
            { id: 'sd_customs',      name: 'The Customs House',       line: 'Ledgers still open on the counters, ink still wet. The last entry is dated tomorrow.' },
            { id: 'sd_figurehead',   name: 'The Figurehead Yard',     line: 'A yard of salvaged figureheads, all facing the water. At high tide, locals say, they trade gossip. The gossip is about ships. Mostly.' },
            { id: 'sd_drowned_inn',  name: 'The Drowned Anchor Inn',  line: 'The taproom is six feet under at high tide and dry at low. The regulars adjusted. You can tell which ones by the gills.' },
            { id: 'sd_bell_tower',   name: 'The Tide Bell',           line: 'The great harbor bell, green with age, rings itself for every ship that never came home. It rings often. It never rings twice for the same ship.' },
        ],
        lore: [
            { id: 'sd_lore_1', text: '“The sea took the harbor in a single night, gently, the way you\'d move a sleeping child. Not one cup was broken. They\'re all still on their shelves, underwater, full.”' },
            { id: 'sd_lore_2', text: '“The Customs House never closed. Duties are still assessed on everything the tide brings in. The tide, to its credit, pays.”' },
            { id: 'sd_lore_3', text: '“Divers report the Inverted Lighthouse\'s beam follows them home. Harmless, they insist. Their candles do burn brighter now.”' },
            { id: 'sd_lore_4', text: '“The last harbormaster\'s log ends mid-sentence: \'tide\'s in early, and it\'s brought—\'. The next page is just salt.”' },
            { id: 'sd_lore_5', text: '“Ships still dock here on fog-thick nights. Cargo manifests list: memory, ballast, and one (1) passenger, return ticket.”' },
        ],
        encounters: [
            {
                id: 'sd_enc_harbormaster',
                name: 'The Harbormaster\'s Late Shift',
                emoji: '🧜',
                intro: 'At the Customs House counter, something with too many opinions about tariffs and a coat of wet barnacles looks up. "Declarations?" it gurgles, stamp already inked.',
                winChance: 0.55,
                reward: { min: 2_400, max: 4_800 },
                winLine: 'You declare everything, honestly, including the lint. The Harbormaster is so moved by the paperwork that it pays out a "compliance dividend" from the drowned treasury. Bureaucracy, but wet.',
                loseLine: 'You undeclare one (1) souvenir. The stamp comes down like a depth charge. The fine is itemized, alphabetized, and immediate.',
                safeLine: 'You fill out the visitor form only and touch nothing. The Harbormaster nods at a jar on the counter: the gratuity box, outbound. Visitors who behave get the interest.',
            },
            {
                id: 'sd_enc_crew',
                name: 'The Crew Still Unloading',
                emoji: '👻',
                intro: 'A ghost crew hauls phantom cargo from a ship that isn\'t there to a warehouse that mostly is. The bosun waves you over. They\'re one pair of hands short. They have been for ninety years.',
                winChance: 0.50,
                reward: { min: 2_200, max: 4_400 },
                winLine: 'You take the end of a rope that isn\'t there and pull like it is. The crate lands — REAL — on the dock. Your share of the freight fee has been waiting in the manifest since before your grandparents.',
                loseLine: 'You lift with your back, not your legs, and drop a crate of phantom porcelain. Phantom porcelain, it turns out, bills like the real thing.',
                safeLine: 'You watch the whole operation and tip your hat to the bosun at shift\'s end. Dockworkers respect a good audience. They point you to where the loose cargo washes up.',
            },
            {
                id: 'sd_enc_siren',
                name: 'A Siren, Off the Clock',
                emoji: '🎶',
                intro: 'On the seawall sits a siren, hair dripping, doing the harbor\'s crossword. She glances up. "I\'m not singing," she says. "Lunch break. But I do trade in interesting rumors, if you\'ve got one."',
                winChance: 0.45,
                reward: { min: 2_800, max: 5_500 },
                winLine: 'You trade her the strangest true thing you\'ve seen out here. She laughs — a sound that briefly stops the tide — and pays in salvage coordinates that check out brilliantly.',
                loseLine: 'You make a rumor up. Her eyes narrow; sirens fact-check. The tide takes a personal interest in your pockets on the walk back.',
                safeLine: 'You help with the crossword instead. Seven across, "drowned." She finishes the puzzle, hums one bar of thanks — and the harbor leaves a finder\'s fee in your boot.',
            },
        ],
        traps: [
            { id: 'sd_trap_tide',    name: 'The Early Tide',        line: 'The tide comes in twenty minutes ahead of schedule, which the Customs House later confirms is "within tolerance." Your boots, supplies, and coin pouch disagree.', penalty: { min: 500, max: 1_200 }, injuryChance: 0.25 },
            { id: 'sd_trap_plank',   name: 'A Gangplank\'s Opinion', line: 'The gangplank holds for exactly as long as it finds you amusing. You stop being amusing halfway across. The harbor charges a docking fee for bodies, apparently.', penalty: { min: 400, max: 1_000 }, injuryChance: 0.35 },
            { id: 'sd_trap_net',     name: 'The Patient Net',       line: 'A fishing net, abandoned ninety years, finally catches something: you. By the time you cut loose, the gulls have unionized around your snack budget.', penalty: { min: 350, max: 900 },  injuryChance: 0.20 },
        ],
        treasureLines: [
            'A strongbox in the Customs House marked "UNCLAIMED — 90 YEARS." The Harbormaster stamps it over to you without looking up.',
            'Low tide bares a rooftop with a chimney, and the chimney is stuffed with a smuggler\'s retirement plan. The smuggler, presumably, retired differently.',
            'The Tide Bell rings once as you pass — and the wave it shrugs ashore is carrying cargo with your timing written all over it.',
        ],
        relics: [
            { itemId: 'Harbormaster\'s Stamp',  rarity: 'rare',      lore: 'Still inked. Anything you stamp becomes, in a small administrative way, yours. Use responsibly. Or don\'t; the paperwork is self-correcting.' },
            { itemId: 'Bottled Fog',           rarity: 'epic',      lore: 'Fog from the night the harbor drowned, corked. Through the glass, faintly: lamplight, and a bell, and someone whistling.' },
            { itemId: 'The Return Ticket',     rarity: 'legendary', lore: 'One (1) passage on a ship that docks only on fog-thick nights. Unpunched. The destination line just says "back."' },
        ],
        secrets: [
            { id: 'sd_secret_ship',     name: 'The Ship That Came Home',    reward: 10_000, reveal: 'In a sea cave behind the lighthouse: a ship, intact, sails furled, waiting. The Tide Bell rings twice for the first time in history. You map the berth. The bell approves.' },
            { id: 'sd_secret_vault',    name: 'The Wet Vault',              reward: 9_000,  reveal: 'Beneath the Customs House, a vault that floods at high tide — by design. The water inside counts itself. You are paid an "auditor\'s fee" for confirming the total. The total is rude.' },
            { id: 'sd_secret_song',     name: 'The Song That Sank It',      reward: 9_500,  reveal: 'The siren finally tells you, off the record, what was sung the night the harbor went under. It was a lullaby. The city was tired. You write down only the first three notes. Even those are heavy.' },
            { id: 'sd_secret_passenger',name: 'The Passenger\'s Name',       reward: 11_000, reveal: 'You find the manifest line for that one (1) passenger, return ticket. The name is blank — until you read it, and then, briefly, it isn\'t. The Docks consider you family now. Family rates apply.' },
        ],
    },

    // ── Core: tier 5 ─────────────────────────────────────────────────────────
    starfall_wastes: {
        id: 'starfall_wastes',
        name: 'Starfall Wastes',
        emoji: '🌠',
        color: '#37474f',
        defaultUnlocked: false,
        unlockLevel: 26,
        unlockCost: 100_000,
        payoutMultiplier: 2.75,
        tagline: 'The sky fell here once. It left a tab.',
        description: 'A desert of fused black glass where a meteor shower never quite finished landing. Stars still drift down some nights, slow as snow, and the sand remembers every single one.',
        intros: [
            'Black glass sand crunches underfoot, still faintly warm from an impact centuries old.',
            'A shooting star crosses overhead — at walking pace. It seems to be looking for something. It is not subtle about it.',
            'The horizon is full of craters, each one a different size of "something landed here and meant it."',
            'Your shadow points at the sky instead of away from the sun. The Wastes have opinions about geometry.',
        ],
        eventWeights: { encounter: 20, discovery: 16, trap: 18, treasure: 22, lore: 14, secret: 5, quiet: 5 },
        landmarks: [
            { id: 'sw_crater_field',  name: 'The Singing Crater Field', line: 'A field of craters that hum in different pitches when the wind crosses them. Someone, at some point, tuned them. You do not ask who.' },
            { id: 'sw_glass_spire',   name: 'The Fused Spire',          line: 'A meteor that landed standing up and never fell over. It is still, the locals insist, slightly annoyed about it.' },
            { id: 'sw_starwell',     name: 'The Starwell',             line: 'A perfectly round shaft of black glass that goes down further than the meteor that made it should explain. Drop a pebble. Wait. It\'s still falling.' },
            { id: 'sw_nightmarket',  name: 'The Market That Only Opens at Apogee', line: 'A ring of stalls that exist for the eleven minutes a year the sky is closest. The merchants are very fast. So is the haggling.' },
            { id: 'sw_ash_garden',   name: 'The Cinder Garden',        line: 'Flowers grown from impact ash, blooming in colors that don\'t otherwise occur in nature. They close when you reach for them. They open again when you don\'t.' },
        ],
        lore: [
            { id: 'sw_lore_1', text: '“The shower was supposed to last one night. The records are vague on why it never finished. The sky, when asked, changes the subject.”' },
            { id: 'sw_lore_2', text: '“Glass from the Wastes is colder at noon than at midnight. Nobody has explained this satisfactorily. Several have tried. None have stayed to finish the paper.”' },
            { id: 'sw_lore_3', text: '“The Fused Spire was, before it fell, apparently part of something. The hum it makes at dusk has never repeated the same note twice.”' },
            { id: 'sw_lore_4', text: '“Caravans that camp near the Starwell report dreams of falling, pleasantly, for a very long time. They wake up rested. They do not recommend looking down.”' },
            { id: 'sw_lore_5', text: '“The Cinder Garden\'s flowers were cataloged once, by a botanist who is no longer available for comment. The notes simply end: \'and then it bloomed at me.\'”' },
        ],
        encounters: [
            {
                id: 'sw_enc_cartographer',
                name: 'The Sky\'s Own Cartographer',
                emoji: '🔭',
                intro: 'A figure made of compacted starlight squints through a telescope built from a meteor fragment. "You\'re off the chart," it says, not unkindly. "Want to be on it? There\'s a fee. There\'s also a discount."',
                winChance: 0.50,
                reward: { min: 2_600, max: 5_200 },
                winLine: 'You answer three questions about where you\'ve been honestly, including the embarrassing parts. The cartographer is delighted by the detail and pays you for "exceptional fieldwork."',
                loseLine: 'You exaggerate your travels slightly. The telescope catches the lie mid-orbit. The correction fee is steep and the cartographer looks personally betrayed.',
                safeLine: 'You decline the chart and just admire the stars with it for a while. It charges nothing for company and, on your way out, presses a fragment into your hand. "For the conversation."',
            },
            {
                id: 'sw_enc_glassbeast',
                name: 'The Glassback Wyrm',
                emoji: '🦂',
                intro: 'Something the size of a wagon unfolds from the crater floor, plated in black glass, eyes like banked coals. It does not attack. It poses. It has clearly been waiting for an audience.',
                winChance: 0.45,
                reward: { min: 3_000, max: 5_800 },
                winLine: 'You applaud, sincerely, at the right moments. The wyrm preens so hard a plate of fused glass shakes loose, gem-bright underneath. A standing ovation fee, apparently.',
                loseLine: 'You yawn. Visibly. The wyrm takes it personally and slams its tail down hard enough to crack the crater and your coin pouch in the same motion.',
                safeLine: 'You watch quietly from a respectful distance and let the performance run its course. It bows when finished, old showbiz instinct, and tosses a shard your way for being good audience.',
            },
            {
                id: 'sw_enc_fallen',
                name: 'Something Still Arriving',
                emoji: '☄️',
                intro: 'A streak of light is coming down, slow, deliberate, clearly not in a hurry after several hundred years of travel. It seems to want to land near you specifically.',
                winChance: 0.40,
                reward: { min: 3_400, max: 6_500 },
                winLine: 'You stand your ground and let it land an arm\'s length away. It cools instantly into a smooth stone that hums when you touch it, and a pocket of glassy ground nearby is suddenly, generously, full of coin.',
                loseLine: 'You flinch and step back at the last second. It lands anyway, throwing up a spray of molten glass that costs you dearly in singed supplies and scattered coin.',
                safeLine: 'You watch it land from well outside the blast radius, patient and unbothered. It cracks open gently rather than violently, grateful for the lack of drama, and rolls a little of itself toward you.',
            },
        ],
        traps: [
            { id: 'sw_trap_glass',    name: 'A Field of Hidden Edges', line: 'The black sand hides shards at exactly boot height. You make it across, eventually, but the toll is paid in torn supplies and dropped coin.', penalty: { min: 500, max: 1_300 }, injuryChance: 0.30 },
            { id: 'sw_trap_starwell', name: 'The Starwell\'s Invitation', line: 'You lean over the Starwell to look down. It looks back, and something about gravity briefly renegotiates. You climb out fine. Your pockets do not.', penalty: { min: 450, max: 1_100 }, injuryChance: 0.25 },
            { id: 'sw_trap_heat',     name: 'Noon\'s Cold Snap',        line: 'The glass sand goes inexplicably, dangerously cold at exactly noon, same as always, and you are exactly as unprepared as always. The Wastes charge for the lesson.', penalty: { min: 400, max: 1_000 }, injuryChance: 0.20 },
        ],
        treasureLines: [
            'A crater rim crumbles to reveal a strongbox fused half into glass, the rest of it still negotiable.',
            'The Market That Only Opens at Apogee left a stall standing. The till, somehow, is still in it.',
            'You crack open a cooled meteor fragment out of curiosity. Curiosity, this once, pays extremely well.',
        ],
        relics: [
            { itemId: 'Compacted Starlight',  rarity: 'rare',      lore: 'A fragment of the cartographer\'s telescope lens. Looking through it shows you exactly where you are. Disappointingly accurate.' },
            { itemId: 'Glassback Plate',      rarity: 'epic',      lore: 'A shed plate from the wyrm\'s hide. Still warm. Still, faintly, expecting applause.' },
            { itemId: 'The Still-Falling Stone', rarity: 'legendary', lore: 'A meteor fragment that has technically not finished landing. Set it down and it settles, very slightly, every single night.' },
        ],
        secrets: [
            { id: 'sw_secret_apogee',  name: 'The Eleven Minutes',         reward: 9_500,  reveal: 'You time your arrival to the Market\'s eleven minutes exactly. The stalls are real, the merchants are kind, and one of them sells you something that wasn\'t for sale a moment ago. You map the minute. It only works once a year, but the map remembers the timing.' },
            { id: 'sw_secret_core',    name: 'What the Spire Holds',       reward: 8_500,  reveal: 'Deep in the Fused Spire, past the hum, a chamber of compacted starlight pulses in time with something that might be a heartbeat, if stars had those. You leave before you find out for certain.' },
            { id: 'sw_secret_well',    name: 'The Bottom of the Starwell', reward: 10_000, reveal: 'You finally see the pebble land, after the longest wait of your life. At the bottom: not rock, but a small room, lit from nowhere, holding every pebble anyone has ever dropped in. Yours joins them. You\'re given, in exchange, something that was already falling toward you anyway.' },
            { id: 'sw_secret_garden',  name: 'What Grows From Impact',     reward: 9_000,  reveal: 'The Cinder Garden opens fully, just once, while you\'re watching instead of reaching. Every flower is, you realize, a tiny held breath from the night of the shower. You\'re given a seed. It will not grow anywhere else. It grows here, in your honor, immediately.' },
        ],
    },

    // ── Seasonal: Winter Wonderland ──────────────────────────────────────────
    frostveil_pass: {
        id: 'frostveil_pass',
        name: 'Frostveil Pass',
        emoji: '❄️',
        color: '#a8d8f0',
        defaultUnlocked: false,
        unlockLevel: 1,
        unlockCost: 0,
        seasonalEventId: 'winter_wonderland',
        payoutMultiplier: 1.5,
        eventCurrency: { min: 3, max: 8 },
        tagline: 'Open until the thaw. The snow remembers visitors fondly.',
        description: 'A mountain pass that only exists while the snow does. Lantern-lit, hushed, and generous in the way of things that know they are temporary.',
        intros: [
            'You step into snowfall so quiet you can hear the lanterns thinking. The Pass is open. For now.',
            'Fresh snow, no footprints — and then, ahead of you, one set, walking out. The Pass likes a little drama.',
            'The cold here doesn\'t bite. It escorts. You are walked politely into the white.',
            'Every snowflake that lands on your map melts into a tiny, helpful annotation.',
        ],
        eventWeights: { encounter: 20, discovery: 18, trap: 12, treasure: 24, lore: 14, secret: 5, quiet: 7 },
        landmarks: [
            { id: 'fp_lantern_road',  name: 'The Lantern Road',     line: 'A mile of lanterns nobody lights and nothing extinguishes. They dim, slightly, when you pass — a bow, lantern-style.' },
            { id: 'fp_frozen_falls',  name: 'The Listening Falls',  line: 'A waterfall frozen mid-roar. Press an ear to the ice and the roar is still in there, saving itself for spring.' },
            { id: 'fp_snow_garden',   name: 'The Unmelting Garden', line: 'Roses of packed snow that bloom at dusk. Picked, they last exactly one act of kindness before melting.' },
        ],
        lore: [
            { id: 'fp_lore_1', text: '“The Pass appears with the first true snow and leaves with the last. Mapmakers mark it in pencil.”' },
            { id: 'fp_lore_2', text: '“Travelers caught out at night report being tucked in by the snowdrifts. Awakening warm, rested, and slightly tucked.”' },
            { id: 'fp_lore_3', text: '“Nothing is ever lost in Frostveil. Mislaid things surface in the spring melt, miles downhill, neatly labeled.”' },
        ],
        encounters: [
            {
                id: 'fp_enc_yeti',
                name: 'A Yeti With a Ledger',
                emoji: '🦣',
                intro: 'An enormous white shape blocks the trail, holding a tiny notebook. "Toll," it rumbles, then squints at the page. "Or... rebate? The handwriting is bad. It\'s mine, and it\'s bad."',
                winChance: 0.55,
                reward: { min: 1_400, max: 2_800 },
                winLine: 'You help it decipher its own bookkeeping. It\'s a rebate. The yeti pays out happily and initials your map with one enormous, careful Y.',
                loseLine: 'You guess "toll." It was a rebate. The yeti, flustered, charges you the toll anyway to balance the books. Accounting is merciless at altitude.',
                safeLine: 'You wait in line behind a snow hare, who handles the negotiation. The hare wins. The yeti pays out everyone in line on principle. You were in line.',
            },
            {
                id: 'fp_enc_skater',
                name: 'The Skater on the Falls',
                emoji: '⛸️',
                intro: 'Someone is figure-skating on the frozen waterfall. Vertically. They pause mid-axel, upside down, and beckon: the ice apparently seats two.',
                winChance: 0.45,
                reward: { min: 1_600, max: 3_200 },
                winLine: 'You manage thirty vertical seconds without dying. The skater is delighted. Prize money materializes from a sponsor you never see and the ice itself applauds.',
                loseLine: 'You make it four seconds. Gravity, that traditionalist, files an objection. The entry fee is non-refundable and so is your composure.',
                safeLine: 'You judge from the bank, holding up scores on snowballs. The skater bows. Judges, it turns out, get an appearance fee here.',
            },
        ],
        traps: [
            { id: 'fp_trap_drift',  name: 'An Affectionate Snowdrift', line: 'The drift hugs you. Wholeheartedly. By the time you\'re excavated, your pockets have been redistributed to the spring melt.', penalty: { min: 200, max: 600 }, injuryChance: 0.20 },
            { id: 'fp_trap_ice',    name: 'Black Ice With Timing',     line: 'The Pass waits until your most confident stride. The lanterns dim out of respect. The toll for the performance is collected from whatever scattered.', penalty: { min: 250, max: 700 }, injuryChance: 0.30 },
        ],
        treasureLines: [
            'A snowdrift unzips itself to show you a strongbox it\'s been keeping warm. Cold. Keeping cold.',
            'Under the Lantern Road\'s seventh lantern: last winter\'s lost-and-found, compounding interest in snowflakes and coins.',
        ],
        relics: [
            { itemId: 'Unmelting Rose',     rarity: 'rare',      lore: 'A snow rose from the garden. It will last until you do something kind, so realistically, forever. (It melted. We both knew it would.)' },
            { itemId: 'The Yeti\'s Pencil',  rarity: 'epic',      lore: 'Tiny in your hand, tinier in his. Anything tallied with it comes out slightly in your favor. The yeti has noticed. He is too polite to say.' },
        ],
        secrets: [
            { id: 'fp_secret_spring', name: 'Where the Pass Goes in Spring', reward: 6_000, reveal: 'Behind the Listening Falls, a corridor of unmelting frost spirals down past the roots of the mountain. The Pass doesn\'t vanish in spring. It commutes. You map the door and promise to knock.' },
            { id: 'fp_secret_first',  name: 'The First Snowflake',           reward: 7_000, reveal: 'In a shrine of ice at the summit, under glass: the first snowflake of every winter, all of them, going back further than winters should. This year\'s is already there. It looks like your map. Exactly like your map.' },
        ],
    },

    // ── Seasonal: Spooky Season ──────────────────────────────────────────────
    hollowgrave_lane: {
        id: 'hollowgrave_lane',
        name: 'Hollowgrave Lane',
        emoji: '🎃',
        color: '#ff6b00',
        defaultUnlocked: false,
        unlockLevel: 1,
        unlockCost: 0,
        seasonalEventId: 'spooky_season',
        payoutMultiplier: 1.5,
        eventCurrency: { min: 3, max: 8 },
        tagline: 'One street long. Longer after dark.',
        description: 'A crooked lane of leaning houses that only appears in October. Every door is carved with a different grin, and the porch lights are always on for you. Specifically you.',
        intros: [
            'The lane unrolls out of the fog like it was waiting for your footsteps to start the show.',
            'Jack-o\'-lanterns line every porch. As you pass, each one turns. Politely. Like sunflowers, if sunflowers gossiped.',
            'Somewhere down the lane, a door creaks open. Then another. Then all of them, in welcome or in appetite.',
            'The fog smells like cider and old paper. The houses lean in. You\'re the most interesting thing to happen all evening, and the evening is very long here.',
        ],
        eventWeights: { encounter: 24, discovery: 16, trap: 16, treasure: 20, lore: 14, secret: 5, quiet: 5 },
        landmarks: [
            { id: 'hl_pumpkin_field', name: 'The Self-Carving Patch', line: 'A pumpkin field where the carving happens from the inside. Tonight\'s crop is doing portraits. One of them is flattering. One of them is you.' },
            { id: 'hl_last_house',    name: 'The House at the End',   line: 'The lane ends at a house that is all door. You knock once. From inside, eventually: one knock back. Pleased to meet you too.' },
            { id: 'hl_candy_well',    name: 'The Candy Well',         line: 'A wishing well that dispenses instead of receiving. The bucket comes up rattling. The well considers this a long-term investment in your goodwill.' },
        ],
        lore: [
            { id: 'hl_lore_1', text: '“Hollowgrave Lane has thirteen houses, twelve of which are occupied. The thirteenth is taking applications.”' },
            { id: 'hl_lore_2', text: '“The residents do not haunt. They host. The distinction matters enormously to them and is enforced by committee.”' },
            { id: 'hl_lore_3', text: '“Trick-or-treaters who visit the Lane receive full-size everything. The Lane does not discuss its budget.”' },
        ],
        encounters: [
            {
                id: 'hl_enc_skeleton',
                name: 'The Understudy Skeleton',
                emoji: '💀',
                intro: 'A skeleton in a half-painted set rattles its script at you. "The lead ghost called in alive," it sighs. "Run lines with me? The haunting\'s at eight and the pay is criminal. In a good way."',
                winChance: 0.55,
                reward: { min: 1_400, max: 2_800 },
                winLine: 'You deliver "BOO" with subtext, layers, motivation. The skeleton weeps from sockets that shouldn\'t allow it. You\'re paid scale plus a cut of the screams.',
                loseLine: 'You laugh in the dramatic pause. The skeleton goes very still — professionally hurt — and the union fines you for breaking immersion.',
                safeLine: 'You volunteer as audience instead. The dress rehearsal is genuinely terrifying. You applaud. Ushers tip YOU here, which says everything about the Lane\'s economy.',
            },
            {
                id: 'hl_enc_witch',
                name: 'A Witch Doing Inventory',
                emoji: '🧙',
                intro: 'A witch counts jars on her porch: eyeballs (pickled), screams (assorted), regret (top shelf). "I\'m over-stocked on luck," she says, not looking up. "Care to trade?"',
                winChance: 0.50,
                reward: { min: 1_500, max: 3_000 },
                winLine: 'You trade her a true story she hasn\'t heard. She laughs herself off the rocking chair, recovers with dignity, and pays in luck. It works retroactively. The walk home is suspiciously smooth.',
                loseLine: 'You try to haggle with a witch on her own porch. The jars all turn to watch. The trade goes through; the exchange rate is a lesson.',
                safeLine: 'You help her alphabetize. (Regret files under R; the screams insist on S-sharp.) She pays an honest wage and bags you a sample of the house blend.',
            },
        ],
        traps: [
            { id: 'hl_trap_porch',  name: 'A Porch With Opinions',   line: 'The third step was a mimic. The whole porch was a mimic. The welcome mat — also a mimic — collects the cover charge while you flee.', penalty: { min: 250, max: 700 }, injuryChance: 0.25 },
            { id: 'hl_trap_candy',  name: 'The Long Con Caramel',    line: 'You take candy from the unattended bowl marked TAKE ONE. You take two. The Lane\'s honor system has teeth, and a payment plan.', penalty: { min: 200, max: 600 }, injuryChance: 0.15 },
        ],
        treasureLines: [
            'A jack-o\'-lantern grins wider as you approach and coughs up its savings. It\'s been holding that in all month.',
            'The Candy Well\'s bucket comes up heavy tonight: coins among the caramels. The well winks. Wells can wink here.',
        ],
        relics: [
            { itemId: 'Grinning Doorknocker', rarity: 'rare',      lore: 'A brass knocker from the House at the End. Knock once anywhere and something, somewhere, politely knocks back.' },
            { itemId: 'Jar of Bottled Dusk',  rarity: 'epic',      lore: 'October dusk, preserved at peak atmosphere. Open for ten seconds of perfect Halloween, any month. Refills annually. The witch insists it\'s a sample, not a gift; samples imply she\'ll see you again.' },
        ],
        secrets: [
            { id: 'hl_secret_thirteenth', name: 'The Thirteenth House',  reward: 6_500, reveal: 'The house that was taking applications has reviewed yours — you applied the moment you stepped onto the Lane; everyone does, it\'s in the fog\'s fine print. The door opens. Inside is a furnished map room. Yours. October residency only.' },
            { id: 'hl_secret_parade',     name: 'The Quiet Parade',      reward: 7_000, reveal: 'At the exact middle of the night, the Lane\'s residents parade — silent, candlelit, splendid — to honor the one night a year the living visit them. You\'re handed a candle. Front row. The map gains a date circled in orange.' },
        ],
    },

    // ── Seasonal: Summer Festival ────────────────────────────────────────────
    scorchglass_shore: {
        id: 'scorchglass_shore',
        name: 'Scorchglass Shore',
        emoji: '☀️',
        color: '#ffd700',
        defaultUnlocked: false,
        unlockLevel: 1,
        unlockCost: 0,
        seasonalEventId: 'summer_festival',
        payoutMultiplier: 1.5,
        eventCurrency: { min: 3, max: 8 },
        tagline: 'The beach where summer goes to show off.',
        description: 'A coastline of sun-fused glass sand that only surfaces in high summer. The waves keep time with festival drums nobody can find, and the tide pools hold last year\'s best afternoons.',
        intros: [
            'Glass sand chimes under your boots. The whole beach is one long wind-chime and the wind knows the tune.',
            'The sun here doesn\'t beat down. It performs. The sea provides percussion.',
            'A wave rolls in carrying festival streamers from a party that ended a century ago, or starts tomorrow. Tides are flexible about tense.',
            'Somewhere down the shore, drums. There are always drums. No one has ever found the drummers, and stopping to look means missing the song.',
        ],
        eventWeights: { encounter: 22, discovery: 18, trap: 12, treasure: 24, lore: 12, secret: 5, quiet: 7 },
        landmarks: [
            { id: 'ss_glass_dunes',  name: 'The Singing Dunes',    line: 'Dunes of pure scorchglass that ring in harmony at noon. At 12:01 they argue about the setlist.' },
            { id: 'ss_tide_pools',   name: 'The Keepsake Pools',   line: 'Tide pools that hold reflections of perfect summer days. Lean in and one of them is yours, from before you knew to keep it.' },
            { id: 'ss_bonfire',      name: 'The Bonfire That Stays Lit', line: 'A driftwood bonfire burning steadily above the tide line. It has never been fed. It has never gone out. There are always exactly enough seats.' },
        ],
        lore: [
            { id: 'ss_lore_1', text: '“The Shore surfaces with the first true heat of summer. Cartographers mark it in sunscreen.”' },
            { id: 'ss_lore_2', text: '“The festival the drums belong to has no recorded start and no scheduled end. Locals say you don\'t attend it; you realize you\'ve been attending it.”' },
            { id: 'ss_lore_3', text: '“Glass from this beach holds warmth for years. Winter merchants pay absurdly for a pocketful of July.”' },
        ],
        encounters: [
            {
                id: 'ss_enc_crab',
                name: 'The Crab With the Conch Concession',
                emoji: '🦀',
                intro: 'A crab in a tiny visor runs a stall of conch shells. "Each one plays a different summer," it clicks. "Most are paid for. One\'s a free sample. I forget which. Wanna gamble?"',
                winChance: 0.55,
                reward: { min: 1_400, max: 2_800 },
                winLine: 'You pick the third shell from the left, on instinct. The free sample — AND it plays the summer the crab opened the stall. Sentimental value pays out in actual value.',
                loseLine: 'You pick the biggest shell. Rookie. It plays a summer of jellyfish stings and sunburn, billed at full price. The crab does not do refunds; the visor says so.',
                safeLine: 'You buy the cheapest shell honestly. It plays one perfect minute of last July. The crab, touched by a customer who just pays, slips a bonus in the bag.',
            },
            {
                id: 'ss_enc_lifeguard',
                name: 'The Lifeguard of the Deep End',
                emoji: '🌊',
                intro: 'A figure of living seawater sits on a lifeguard chair facing the open ocean. "No one\'s drowned on my watch in four hundred years," it says. "Race you to the buoy. I\'ll give you the head start and the current."',
                winChance: 0.45,
                reward: { min: 1_700, max: 3_400 },
                winLine: 'You lose, obviously — it IS the water — but you finish, which apparently no one does. The prize for finishing has been compounding since the chair was built.',
                loseLine: 'You cramp at the halfway buoy and get escorted back with overwhelming, humiliating gentleness. The rescue is free. Your dropped valuables join the collection in the deep end.',
                safeLine: 'You decline the race and hold its towel instead. Four hundred years and no one has ever held its towel. It tips like the sea: largely.',
            },
        ],
        traps: [
            { id: 'ss_trap_sunglare', name: 'The Glare Off the Dunes',  line: 'Noon hits the scorchglass and the whole beach becomes one lens. You navigate out by sound, lighter in pocket and crispier in general.', penalty: { min: 200, max: 600 }, injuryChance: 0.25 },
            { id: 'ss_trap_undertow', name: 'A Flirtatious Undertow',   line: 'The undertow only wanted to show you the sandbar. The sandbar is lovely. The walk back through the surf costs you everything not zipped shut.', penalty: { min: 250, max: 700 }, injuryChance: 0.20 },
        ],
        treasureLines: [
            'The tide rolls a sea chest up the glass sand and waits for you to take the hint.',
            'Under the bonfire\'s third seat: the festival\'s lost-and-found. The festival defines "lost" generously in your favor.',
        ],
        relics: [
            { itemId: 'Pocketful of July',  rarity: 'rare',      lore: 'A handful of scorchglass, still warm. Will be warm in ten winters. Has strong opinions about being kept in drawers.' },
            { itemId: 'The Free Sample',    rarity: 'epic',      lore: 'A conch from the crab\'s stall. Plays a different perfect summer every time. The crab maintains you stole it. The receipt in the shell says otherwise.' },
        ],
        secrets: [
            { id: 'ss_secret_drummers', name: 'The Drummers, Finally',    reward: 6_500, reveal: 'You follow the drums at dusk, the one hour the glass doesn\'t glare — and find them: the waves themselves, drumming on the hulls of every ship that ever missed this festival. You\'re given a drum. The map gains a rhythm.' },
            { id: 'ss_secret_tide',     name: 'Where Summer Winters',     reward: 7_000, reveal: 'Beneath the Keepsake Pools, a grotto where the Shore stores the off-season: folded sunlight, stacked afternoons, the smell of hot sand in labeled jars. You\'re allowed one jar. You take June.' },
        ],
    },

    // ── Seasonal: Valentine's Day ────────────────────────────────────────────
    velvet_arcade: {
        id: 'velvet_arcade',
        name: 'The Velvet Arcade',
        emoji: '💝',
        color: '#ff69b4',
        defaultUnlocked: false,
        unlockLevel: 1,
        unlockCost: 0,
        seasonalEventId: 'valentines_day',
        payoutMultiplier: 1.5,
        eventCurrency: { min: 3, max: 8 },
        tagline: 'A covered promenade of old flames and older letters.',
        description: 'A gaslit arcade of shops that appears for one week in February. Every storefront sells something that can\'t usually be bought: apologies, first dances, the right words.',
        intros: [
            'The arcade\'s gas lamps light themselves one by one ahead of you, like a slow round of applause.',
            'Every shop window displays something you almost said once. The mannequins are tactful about it.',
            'Violin music from nowhere in particular. It changes key when you slow down at a window. The arcade works on commission.',
            'The air smells of roses and sealing wax. Somewhere a register rings for a purchase made forty years ago, finally.',
        ],
        eventWeights: { encounter: 22, discovery: 18, trap: 12, treasure: 22, lore: 16, secret: 5, quiet: 5 },
        landmarks: [
            { id: 'va_letter_office', name: 'The Dead Letter Office',  line: 'Every love letter never sent ends up here, filed by ache. The clerk assures you yours are well cared for. You didn\'t mention having any. The clerk smiles.' },
            { id: 'va_dance_floor',   name: 'The Borrowed Ballroom',   line: 'A ballroom that lends out first dances. The floor remembers every step ever taken on it and will cover for yours.' },
            { id: 'va_mirror_shop',   name: 'The Flattering Mirror',   line: 'A mirror shop with one mirror. It shows you the way someone, somewhere, once looked at you. People stand there a long time. The shop sells handkerchiefs, too. Brisk business.' },
        ],
        lore: [
            { id: 'va_lore_1', text: '“The Arcade opens the week of the 14th and not one lamp sooner. Couples who met there can find it any day of the year, but only together.”' },
            { id: 'va_lore_2', text: '“The Dead Letter Office has never lost a letter. Delivery is available. The postage is courage, exact change only.”' },
            { id: 'va_lore_3', text: '“Nothing in the Arcade is priced in coin, officially. Unofficially, the merchants accept it with a sigh, like everyone else.”' },
        ],
        encounters: [
            {
                id: 'va_enc_matchmaker',
                name: 'The Retired Matchmaker',
                emoji: '🏹',
                intro: 'At a café table sits a small ancient person with a ledger of every match they ever made. "Four thousand weddings," they say. "One mistake. Help me find it in the books and I\'ll make it worth your while."',
                winChance: 0.50,
                reward: { min: 1_500, max: 3_000 },
                winLine: 'You find it: page 812, two names matched to each other\'s handwriting instead of each other. The matchmaker stares, laughs for a full minute, and pays the finder\'s fee. The couple, for the record, is still happy. Some mistakes hold.',
                loseLine: 'You point confidently at page 9. Page 9 is the matchmaker\'s own wedding. The coffee you must now buy by way of apology is the most expensive in the Arcade.',
                safeLine: 'You just keep them company while they search. At closing they find it themselves, and tip you for the conversation — matchmakers know exactly what company is worth.',
            },
            {
                id: 'va_enc_cupid',
                name: 'A Cupid on Inventory Day',
                emoji: '💘',
                intro: 'A cupid counts arrows behind the fletcher\'s stall, frowning. "One missing. Do you know what an unaccounted arrow DOES out there? Help me track it. Hazard pay included."',
                winChance: 0.50,
                reward: { min: 1_600, max: 3_200 },
                winLine: 'You trace it to the Dead Letter Office, lodged in a mailbag — the arrow had a crush on a letter. Naturally. The cupid pays hazard rate and swears you to secrecy. (This embed doesn\'t count.)',
                loseLine: 'You find the arrow by stepping on it. The paperwork for a self-inflicted administrative crush takes hours and costs you the filing fee. You feel very fondly about the form afterward. That\'s the arrow.',
                safeLine: 'You hold the quiver and count while the cupid searches. The count comes out right twice in a row, which has never happened. Audit bonus. Cupids pay union rates.',
            },
        ],
        traps: [
            { id: 'va_trap_perfume',  name: 'The Sample Spritz',     line: 'A perfume called "Remember Me" is enthusiastically administered. You spend an hour remembering everyone. The lost time and the bottle you somehow bought are both billed.', penalty: { min: 200, max: 600 }, injuryChance: 0.15 },
            { id: 'va_trap_dance',    name: 'The Pity Waltz',        line: 'The Borrowed Ballroom\'s floor decides you need the practice and refuses to release you for three full waltzes. Cover charge, shoe wear, dignity: itemized.', penalty: { min: 250, max: 650 }, injuryChance: 0.20 },
        ],
        treasureLines: [
            'A shopkeeper hands you a velvet box: "Paid for in 1962. He never came back for it. It should be SOMEONE\'S." The box disagrees politely, then relents.',
            'The Dead Letter Office pays cash bounties for re-shelving misfiled aches. You\'re efficient. The clerk is impressed and the drawer is generous.',
        ],
        relics: [
            { itemId: 'Exact Change (Courage)',  rarity: 'rare',      lore: 'A small brass token, legal postage at the Dead Letter Office. Spend it to send the unsendable. They mint very few. Most people keep them forever, which the mint considers the point.' },
            { itemId: 'The Unclaimed Velvet Box', rarity: 'epic',     lore: 'Paid for in 1962. Inside: a ring sized, impossibly, for whoever opens it. The Arcade does not explain itself.' },
        ],
        secrets: [
            { id: 'va_secret_post',   name: 'The Midnight Delivery Round', reward: 6_500, reveal: 'At midnight the Dead Letter Office delivers — one letter a year, the one whose courage finally arrived. You\'re invited to walk the round. The recipient\'s face goes on your map of things worth finding.' },
            { id: 'va_secret_lamp',   name: 'The First Lamp',              reward: 7_000, reveal: 'The Arcade\'s oldest gas lamp burns from no line and no main. Inside the flame, very small, two figures dance. The lamplighter tells you who they were. The Arcade exists because of them. Now your map does, a little, too.' },
        ],
    },
    // ── Seasonal: The Winter Hunt ────────────────────────────────────────────
    arctic_tundra: {
        id: 'arctic_tundra',
        name: 'The Arctic Tundra',
        emoji: '🏔️',
        color: '#6ab4f5',
        defaultUnlocked: false,
        unlockLevel: 1,
        unlockCost: 0,
        seasonalEventId: 'winter_hunt',
        payoutMultiplier: 1.5,
        eventCurrency: { min: 3, max: 8 },
        tagline: 'New year, old cold. The hunt is already on.',
        description: 'A frozen stretch beyond Misty Lake where the first two weeks of the year belong to whoever\'s willing to track something across the ice. The snow here keeps better records than you do.',
        intros: [
            'The wind doesn\'t howl so much as narrate. You\'re the subject. It\'s not flattering.',
            'Fresh tracks cross the ice ahead of you — too large, too even, gone the second you look directly at them.',
            'The tundra is flat, white, and lying about it. Something below the surface is keeping very still.',
            'Your breath freezes mid-air and hangs there, politely waiting for you to catch up to it.',
        ],
        eventWeights: { encounter: 24, discovery: 16, trap: 16, treasure: 22, lore: 12, secret: 5, quiet: 5 },
        landmarks: [
            { id: 'at_frozen_camp',  name: 'The Abandoned Hunting Camp', line: 'Tents still pitched, fire still circled in stones, nobody home. The cold preserved the coffee. Don\'t.' },
            { id: 'at_bonecairn',    name: 'The Bone Cairn',              line: 'A stack of antlers, tusks, and one very confused-looking ski. Someone\'s been keeping score for a long time.' },
            { id: 'at_aurora_rift', name: 'The Aurora Rift',             line: 'A crack in the ice that glows the same colors as the sky above it, as if the tundra got tired of waiting for the lights and grew its own.' },
        ],
        lore: [
            { id: 'at_lore_1', text: '“The Hunt starts the first morning of the year and ends two weeks later, whether anyone\'s ready or not. Mostly nobody\'s ready.”' },
            { id: 'at_lore_2', text: '“Trackers say the prize isn\'t the catch. It\'s being the thing the tundra decided to notice for once.”' },
            { id: 'at_lore_3', text: '“Frost Tokens don\'t melt. Nobody knows what they\'re made of. The mint isn\'t talking and neither is the ice.”' },
        ],
        encounters: [
            {
                id: 'at_enc_tracker',
                name: 'A Tracker Twice Your Age',
                emoji: '🥾',
                intro: 'An old hunter kneels over a print in the snow that doesn\'t match anything alive. "Fresh," she says, without looking up. "Help me follow it or get out of the wind. Your call."',
                winChance: 0.55,
                reward: { min: 1_500, max: 3_000 },
                winLine: 'You match her pace for three miles without complaint. The trail ends at a cache she\'s clearly been saving for someone who could keep up. That\'s apparently you now.',
                loseLine: 'You lose the trail at the second ridge. She doesn\'t say anything, which is worse than if she had. The walk back costs you in coin and dignity.',
                safeLine: 'You hang back and let her work alone. She finds what she\'s after, and tosses you a cut anyway — for, in her words, "not getting in the way for once."',
            },
            {
                id: 'at_enc_white_stag',
                name: 'Something White and Patient',
                emoji: '🦌',
                intro: 'A shape that might be a stag, made of packed snow and old moonlight, watches you from the ridgeline. It has been there, the tracks suggest, since before you arrived.',
                winChance: 0.45,
                reward: { min: 1_800, max: 3_600 },
                winLine: 'You sit down in the snow instead of approaching. Eventually it comes to you, sheds a sliver of something cold and valuable at your feet, and walks back into the white.',
                loseLine: 'You approach too fast. It\'s gone before you blink, taking the warmth out of the air with it. You shiver the rest of the way home, lighter in pocket.',
                safeLine: 'You photograph the tracks and leave it be. The tundra, oddly grateful for the restraint, leaves something behind on your way out.',
            },
        ],
        traps: [
            { id: 'at_trap_thinice', name: 'Thin Ice With a Grudge', line: 'The ice was load-bearing right up until it had an audience. You climb out colder, wetter, and short a few coins that are now, technically, the lake\'s problem.', penalty: { min: 300, max: 800 }, injuryChance: 0.30 },
            { id: 'at_trap_whiteout', name: 'A Sudden Whiteout',     line: 'The snow erases the horizon, the path, and briefly your confidence. You find your way out by accident and pay the tundra\'s toll for the detour.', penalty: { min: 250, max: 700 }, injuryChance: 0.25 },
        ],
        treasureLines: [
            'A hunting cache half-buried in a drift, left by someone who never came back for it. You do.',
            'The Bone Cairn shifts as you pass, and a pouch of frost-rimed coins tumbles loose from somewhere inside it.',
        ],
        relics: [
            { itemId: 'Tundra Tracker\'s Compass', rarity: 'rare', lore: 'Points not north, but toward whatever\'s worth following. Currently it\'s pointing at you, which is either a malfunction or a compliment.' },
            { itemId: 'Sliver of the White Stag',  rarity: 'epic', lore: 'Cold to the touch, year-round. Hunters who carry one report the strong feeling of being allowed to.' },
        ],
        secrets: [
            { id: 'at_secret_denning', name: 'The Denning Grounds', reward: 7_000, reveal: 'Beneath the Aurora Rift, a hollow where the tundra\'s oldest things sleep through the dark months. You note the entrance and back away slowly, with enormous respect and a small souvenir.' },
        ],
    },

};

const REGION_LIST = Object.values(REGIONS);
const CORE_REGION_IDS = REGION_LIST.filter(r => !r.seasonalEventId).map(r => r.id);
const SEASONAL_REGION_IDS = REGION_LIST.filter(r => r.seasonalEventId).map(r => r.id);

// Total secrets across core regions — used by achievements
const TOTAL_CORE_SECRETS = REGION_LIST
    .filter(r => !r.seasonalEventId)
    .reduce((sum, r) => sum + r.secrets.length, 0);

// ─── RELICS ──────────────────────────────────────────────────────────────────
// Relics live in the shared /inventory as bare itemIds. This index is what
// lets everything else — the display case, /inventory, the collection bonus —
// know what a relic is worth and where it came from.

const RELIC_RARITY_ORDER = ['rare', 'epic', 'legendary'];

// Indicative worth, used for display and for pricing a market listing. Relics
// are not sold to the bot: exploration already has a daily coin cap, and a
// bot-side buyback would be an uncapped faucet straight around it.
const RELIC_VALUES = {
    rare:      3_000,
    epic:      7_500,
    legendary: 20_000,
};

const RELIC_EMOJI = {
    rare:      '🏺',
    epic:      '⚱️',
    legendary: '👑',
};

// itemId → { itemId, rarity, lore, regionId, regionName, emoji, value }
const RELIC_INDEX = Object.fromEntries(
    REGION_LIST.flatMap(region =>
        (region.relics ?? []).map(relic => [relic.itemId, {
            ...relic,
            regionId:   region.id,
            regionName: region.name,
            emoji:      RELIC_EMOJI[relic.rarity] ?? '🏺',
            value:      RELIC_VALUES[relic.rarity] ?? 0,
        }])
    )
);

const RELIC_LIST = Object.values(RELIC_INDEX);
const TOTAL_CORE_RELICS = RELIC_LIST.filter(r => !REGIONS[r.regionId].seasonalEventId).length;

function getRelicMeta(itemId) {
    return RELIC_INDEX[itemId] ?? null;
}

// ─── SHARED VOICE LINES ──────────────────────────────────────────────────────

// Quiet runs — nothing happened, in an atmospheric way
const QUIET_LINES = [
    'Nothing finds you today. You walk, the world holds its breath, and you both agree to call it a draw.',
    'A long, beautiful, profitless wander. The map gains nothing. You gain the kind of quiet money can\'t buy, which is convenient, because there isn\'t any.',
    'Today the wilderness simply watches you pass. You get the feeling you were the event.',
    'You find footprints. They\'re yours. You\'ve been walking in one enormous, contemplative circle, and honestly? Good for you.',
    'The horizon stays exactly where horizons stay. Some expeditions are just stretching your legs with extra steps.',
];

// Footer flavor rotated on result embeds
const FOOTER_LINES = [
    'The map fills in. The blank spaces take notes.',
    'Somewhere, the unexplored is rearranging itself to stay interesting.',
    'I watched the whole thing. You did fine. Mostly.',
    'Every expedition ends. The good ones end at home.',
    'The world is bigger than your map. For now.',
];

// Trap injury notice
const INJURY_LINES = [
    'You\'ll walk that off. Eventually. Sit down for a bit.',
    'Nothing broken except momentum. Rest up.',
    'The wilderness plays rough when it likes you. Take ten.',
];

module.exports = {
    LIMITS,
    EXPLORER_LEVELS,
    EVENT_XP,
    TREASURE_TIERS,
    TIER_COLORS,
    REGIONS,
    REGION_LIST,
    CORE_REGION_IDS,
    SEASONAL_REGION_IDS,
    TOTAL_CORE_SECRETS,
    RELIC_INDEX,
    RELIC_LIST,
    RELIC_VALUES,
    RELIC_EMOJI,
    RELIC_RARITY_ORDER,
    TOTAL_CORE_RELICS,
    getRelicMeta,
    QUIET_LINES,
    FOOTER_LINES,
    INJURY_LINES,
};
