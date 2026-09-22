#!/usr/bin/env node
'use strict';

/**
 * Builds the full icon generation manifest for Clawdia's economy/shop icons.
 *
 * One entry per catalogue key: 83 shop-browse activity ids + 35 guild shop
 * items + 144 catch/kill/mine results (caught fish, hunted animals, mined ores)
 * + 14 pet species (issue #1082) + 10 explore regions + 25 explore relics. Each
 * entry carries the storage key, the on-disk filename, the item's rarity, the
 * rim colour that rarity maps to, and the finished Higgsfield prompt.
 *
 * The look was settled on 2026-09-21 (STYLE.md §0): idiom B (minimal flat
 * shading, two tones per material, no gloss) + a rarity-coloured rim (option
 * 3). This file is the single source of truth for the prompts so the whole
 * catalogue can be regenerated identically.
 *
 *   node assets/icons/build-manifest.mjs            # writes icons.map.json seed + manifest.json
 *
 * It reads the game data directly, so a data change (new tier, renamed item)
 * flows through here rather than being retyped.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const hunt = require('../../src/data/huntData');
const fish = require('../../src/data/fishData');
const mine = require('../../src/data/mineData');
const explore = require('../../src/data/exploreData');
const shopMod = require('../../src/data/defaultShopItems.js');
const SHOP = Array.isArray(shopMod)
    ? shopMod
    : shopMod.DEFAULT_SHOP_ITEMS || shopMod.default || Object.values(shopMod).find(Array.isArray);

// --- rarity palette (RARITY_CONFIG from src/commands/economy/forge.js) -------
// word: an intuitive colour name the image model understands for the rim.
// hex:  the canonical rarity colour, recorded for reference / future tinting.
const RARITY = {
    Common:    { word: 'silver-grey',     hex: '#AAAAAA' },
    Uncommon:  { word: 'emerald-green',   hex: '#2ECC71' },
    Rare:      { word: 'sapphire-blue',   hex: '#3498DB' },
    Epic:      { word: 'amethyst-purple', hex: '#9B59B6' },
    Mythic:    { word: 'molten-orange',   hex: '#FF6600' },
    Legendary: { word: 'radiant-gold',    hex: '#FFD700' },
};

const STYLE = (rarityName) => {
    const rim = RARITY[rarityName].word;
    return `Style: bold cartoon game icon, thick ${rim} rarity rim, minimal flat shading with two tones per material, no gloss highlight, vibrant saturated colors, single object centered with generous padding, no text, transparent background. Readable at small emoji size.`;
};

const prompt = (subject, rarityName) => `Game item icon: ${subject} ${STYLE(rarityName)}`;

// --- tier -> rarity ladders --------------------------------------------------
const RIFLE_RARITY = ['Common', 'Common', 'Uncommon', 'Uncommon', 'Rare', 'Rare', 'Epic', 'Epic', 'Mythic', 'Mythic', 'Legendary', 'Legendary'];
const FIVE_RARITY = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']; // rods, pickaxes
const PLACE_RARITY = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']; // zones, locations, depths
const PACK_RARITY = ['Common', 'Uncommon', 'Rare', 'Epic']; // ammo, bait, blast (4 packs)

// --- ladder subjects (STYLE.md §4: same silhouette, escalate material+detail)-
const RIFLE_SUBJECT = {
    wooden_rifle:     'Same silhouette as a basic hunting rifle: raw timber barrel and receiver, plain wooden stock, a rope-wrapped grip. Angled diagonally from lower-left to upper-right.',
    iron_rifle:       'Same silhouette as a basic hunting rifle: forged iron barrel and receiver, plain wooden stock, a riveted iron band around the barrel. Angled diagonally from lower-left to upper-right.',
    copper_rifle:     'Same silhouette as a basic hunting rifle: polished copper and brass barrel and receiver, dark wooden stock, delicate engraved scrollwork. Angled diagonally from lower-left to upper-right.',
    steel_rifle:      'Same silhouette as a basic hunting rifle: polished steel barrel and receiver, dark synthetic stock, a compact telescopic scope mounted on top. Angled diagonally from lower-left to upper-right.',
    cobalt_rifle:     'Same silhouette as a basic hunting rifle: cobalt-blue alloy barrel and receiver, dark synthetic stock, a telescopic scope, and a faint blue energy glow running along the barrel. Angled diagonally from lower-left to upper-right.',
    gold_rifle:       'Same silhouette as a basic hunting rifle: gleaming gold barrel and receiver, dark lacquered stock, ornate engraved filigree, a telescopic scope, glowing accents. Angled diagonally from lower-left to upper-right.',
    platinum_rifle:   'Same silhouette as a basic hunting rifle: sleek white platinum all-metal frame with no wooden parts, a telescopic scope, subtle glowing accents. Angled diagonally from lower-left to upper-right.',
    crimson_rifle:    'Same silhouette as a basic hunting rifle: crimson-lacquered iron barrel and receiver, black grip, a telescopic scope, glowing red runes and wisps of muzzle smoke. Angled diagonally from lower-left to upper-right.',
    adamantine_rifle: 'Same silhouette as a basic hunting rifle: dark adamantine metal barrel and receiver with faceted armor plating, armored grip, a telescopic scope, glowing accents. Angled diagonally from lower-left to upper-right.',
    fateful_rifle:    'Same silhouette as a basic hunting rifle: void-black metal barrel and receiver wrapped in woven glowing fate-threads, void-black grip, a telescopic scope. Angled diagonally from lower-left to upper-right.',
    angelic_rifle:    'Same silhouette as a basic hunting rifle: white and pale-gold barrel and receiver with feathered wing motifs and a golden halo, white grip, a telescopic scope, a radiant divine glow. Angled diagonally from lower-left to upper-right.',
    altair_rifle:     'Same silhouette as a basic hunting rifle: cosmic blue-black barrel and receiver with a swirling starfield surface and glowing constellation points, a telescopic scope, a cosmic glow. Angled diagonally from lower-left to upper-right.',
};

const ROD_SUBJECT = {
    bamboo_rod:     'Same silhouette as a fishing rod: a natural bamboo rod shaft with a simple cord wrap, no reel, fishing line hanging with a small hook. Angled diagonally from lower-left to upper-right.',
    fiberglass_rod: 'Same silhouette as a fishing rod: a green fiberglass rod shaft with a simple spinning reel, fishing line and a small hook. Angled diagonally from lower-left to upper-right.',
    carbon_rod:     'Same silhouette as a fishing rod: a black carbon-fiber rod shaft with a precision spinning reel and metal handle, fishing line and a small hook. Angled diagonally from lower-left to upper-right.',
    titanium_rod:   'Same silhouette as a fishing rod: a polished titanium rod shaft with a high-end machined reel and a subtle metallic sheen, fishing line and a small hook. Angled diagonally from lower-left to upper-right.',
    crystal_rod:    'Same silhouette as a fishing rod: a translucent glowing crystal rod shaft with an ornate reel and a soft magical glow, enchanted line with a shimmering lure. Angled diagonally from lower-left to upper-right.',
};

const PICKAXE_SUBJECT = {
    wooden_pickaxe:  'Same silhouette as a mining pickaxe: a rough hewn stone-and-wood head on a sturdy wooden handle. Angled diagonally from lower-left to upper-right.',
    iron_pickaxe:    'Same silhouette as a mining pickaxe: a forged iron head on a wooden handle with a riveted band. Angled diagonally from lower-left to upper-right.',
    steel_pickaxe:   'Same silhouette as a mining pickaxe: a hardened polished steel head on a reinforced wooden handle. Angled diagonally from lower-left to upper-right.',
    diamond_pickaxe: 'Same silhouette as a mining pickaxe: a steel head tipped with glittering diamond edges on a metal-banded handle, a faint sparkle. Angled diagonally from lower-left to upper-right.',
    void_pickaxe:    'Same silhouette as a mining pickaxe: a dark void-matter head wreathed in purple smoke on an obsidian handle, a soft purple magical glow. Angled diagonally from lower-left to upper-right.',
};

// --- non-ladder subjects, keyed by bare id ----------------------------------
const SUBJECT = {
    // hunt upgrades / ammo
    rifled_barrel: 'a machined steel rifle barrel section with visible internal rifling grooves.',
    scope: 'a compact black telescopic rifle scope with glass lenses and adjustment turrets.',
    reinforced_stock: 'a heavy-duty reinforced rifle stock padded with metal bracing.',
    iron_shot_pack: 'an open cardboard box of iron shotgun shells, brass-capped orange shells spilling out.',
    steel_shot_pack: 'an open cardboard box of dark steel shotgun shells with gunmetal casings.',
    composite_round_pack: 'an open box of sleek blue composite rifle rounds.',
    titanium_round_pack: 'an open box of gleaming titanium rifle rounds with a diamond sheen.',
    // hunt consumables
    basic_bait: 'a small open pouch of hunting bait feed pellets.',
    premium_bait: 'a premium hunting bait pouch with a golden tag and richer feed pellets.',
    luck_charm: 'a four-leaf clover lucky charm on a small chain.',
    hunters_focus: 'a red-and-white archery target with an arrow struck in the bullseye.',
    stamina_tonic: 'a glowing yellow energy tonic in a small glass bottle with a lightning-bolt label.',
    xp_scroll: 'an unrolled parchment scroll glowing with arcane symbols.',
    // fish upgrades / bait
    enhanced_line: 'a spool of strong braided fishing line, a neat coil of thin high-tensile line.',
    polarized_lens: 'a pair of polarized sunglasses with sleek dark frames and a blue reflective sheen.',
    reinforced_grip: 'a reinforced rubber fishing-rod grip handle with metal bracing.',
    worm_bait_pack: 'a small plastic tub of pink fishing worms.',
    shrimp_bait_pack: 'a small tub of pink shrimp bait.',
    lure_pack: 'a set of shiny metal fishing lures with treble hooks.',
    enchanted_lure_pack: 'a set of glowing enchanted fishing lures shedding sparkles.',
    // fish consumables
    chum_bait: 'a metal bucket of fish chum bait.',
    premium_chum: 'a premium metal bucket of shrimp chum with a golden tag.',
    anglers_luck: 'a four-leaf clover charm tied to a red-and-white fishing bobber.',
    fish_xp_scroll: 'an unrolled parchment scroll glowing with blue aquatic runes.',
    energy_drink: 'a tall can of energy drink with a lightning-bolt logo.',
    hunters_brew: 'a bubbling brown potion in a glass Erlenmeyer flask.',
    // mine upgrades / blasts
    tempered_edge: 'a gleaming honed tempered pickaxe blade edge.',
    gem_lens: "a jeweler's gem loupe, a small magnifying lens in a metal frame with a faint gem sparkle.",
    reinforced_handle: 'a reinforced pickaxe handle wrapped in metal bracing and grip tape.',
    iron_blast_pack: 'a bundle of iron blasting charges tied together with a fuse.',
    steel_blast_pack: 'a cluster of round steel bombs with short lit fuses.',
    explosive_charge_pack: 'a bundle of red dynamite explosive charges tied together.',
    void_charge_pack: 'a cluster of glowing purple void-energy orbs.',
    // mine consumables
    ore_magnet: 'a red horseshoe magnet attracting small chunks of ore.',
    premium_magnet: 'a large premium magnet with golden accents attracting glowing ore.',
    miners_lamp: "a glowing brass miner's oil lamp.",
    miners_instinct: 'a glowing brass compass with a crystal needle.',
    energy_tonic: 'a bubbling green stamina tonic in a glass flask.',
    mine_lock: 'a heavy iron padlock clamped shut over crossed pickaxes.',
    // shared consumables (same concept across activities)
    repair_kit_small: 'a small open toolkit with a wrench and a screwdriver.',
    repair_kit_large: 'a large open toolbox with a hammer and assorted tools.',
    // hunt zones
    beginner_forest: 'a round scene emblem of a peaceful green pine forest lit by sunlight.',
    desert_wastes: 'a round scene emblem of a harsh sandy desert with dunes and a cactus under a hot sun.',
    arctic_tundra: 'a round scene emblem of a snowy frozen tundra with ice and distant white mountains.',
    murky_swamp: 'a round scene emblem of a misty green swamp with murky water, reeds and gnarled trees.',
    legendary_peaks: 'a round scene emblem of towering majestic snow-capped mountain peaks glowing at dawn.',
    // fish locations
    pond: 'a round scene emblem of a calm pond with lily pads ringed by green reeds.',
    river: 'a round scene emblem of a fast-flowing blue river between grassy banks.',
    lake: 'a round scene emblem of a vast misty blue lake with mountains behind it.',
    ocean: 'a round scene emblem of the open ocean with big rolling blue waves.',
    deep_sea: 'a round scene emblem of the dark crushing deep-sea abyss with faint bioluminescent glow.',
    // mine depths
    surface_quarry: 'a round scene emblem of a sunlit open-pit rock quarry with grey boulders.',
    coal_tunnels: 'a round scene emblem of dark sooty mine tunnels with black coal seams and timber supports.',
    iron_mines: 'a round scene emblem of deep mine tunnels with rusty-red iron ore veins in the rock.',
    crystal_caves: 'a round scene emblem of a glittering cavern with glowing blue crystals growing from the walls.',
    the_abyss: 'a round scene emblem of a bottomless dark mining fissure glowing with veins of treasure far below.',
    // guild shop
    padlock: 'a sturdy metal padlock clasped shut over a small bank vault.',
    shield: 'a polished heraldic shield with a few battle dents and a glowing edge.',
    invisibility_cloak: 'a translucent shimmering hooded cloak, partly see-through, shedding faint sparkles.',
    knife: 'a sharp curved combat knife with a dark wrapped handle.',
    robbery_bag: 'a bulging burlap money sack marked with a dollar sign.',
    lifesaver: 'a red-and-white ring life preserver.',
    lucky_charm: 'a four-leaf clover charm with a small golden horseshoe and a thin gold clasp.',
    streak_shield: 'a shield with a small glowing flame ember emblem in the center.',
    streak_freeze: 'a glowing blue ice cube with a small flame frozen inside it.',
    tier_skip_token: 'a golden token coin stamped with a fast-forward skip arrow.',
    coin_booster_2x: 'a stack of gold coins launching upward on a rocket flame.',
    xp_booster_2x: 'a glowing blue bottle emitting a bright star, a jolt of energy.',
    lucky_streak: 'a glowing golden dart striking a bullseye target with sparkles.',
    salary_raise: 'a rising green financial arrow over a paycheck.',
    pet_food: 'a bowl of brown kibble pet food with a bone beside it.',
    revive_scroll: 'a glowing parchment scroll marked with a green phoenix rune.',
    custom_job_title: 'an engraved blank golden name plate.',
    vip_badge: 'a shiny diamond-studded VIP badge medallion.',
    golden_profile_frame: 'an ornate empty golden picture frame with gold accents.',
    server_trophy: "a golden winner's trophy cup.",
    zone_unlock_token: 'a glowing golden token coin stamped with a map and compass.',
    pet_slot_expansion: 'a glowing paw-print emblem with a small plus sign.',
    permanent_stamina: 'a radiant yellow lightning bolt with a small plus sign.',
    prestige_accelerator: 'a glowing rocket launching upward on a star trail.',
    diamond_profile_frame: 'an ornate empty crystal-diamond picture frame sparkling blue.',
    title_sovereign: 'an ornate royal golden crown on purple velvet with a regal glow.',
    prestige_aura: 'a glowing radiant orb wreathed in a swirl of golden light.',
    grand_master_badge: "an ornate golden master's medal framed by laurel branches.",
    title_apex_legend: 'a radiant golden winged star crest.',
    phantom_token: 'a translucent ghostly coin token with a faint glow.',
    silvered_talisman: 'an ornate engraved silver coin talisman on a chain.',
    black_market_contract: 'a rolled dark parchment contract sealed with black wax and a quill.',
    voidsteel_cache: 'a dark metal treasure chest overflowing with glowing void-blue coins.',
    ghost_ledger: 'an old ledger book with ghostly fading ink entries and a faint glow.',
    obsidian_crown: 'a dark obsidian crown with sharp black points and a subtle glow.',
};

// --- assemble ----------------------------------------------------------------
const manifest = [];
let index = 0;
const add = (key, rarityName, subject) => {
    if (!subject) throw new Error(`no subject for ${key}`);
    manifest.push({
        index: index++,
        key,
        file: `${key.replace(/:/g, '__')}.png`,
        rarity: rarityName,
        rim: RARITY[rarityName].word,
        rimHex: RARITY[rarityName].hex,
        prompt: prompt(subject, rarityName),
    });
};

// activity ladders
hunt.WEAPON_TIERS.forEach((w) => add(`hunt:${w.slug}`, RIFLE_RARITY[w.tier - 1], RIFLE_SUBJECT[w.slug]));
fish.ROD_TIERS.forEach((r) => add(`fish:${r.slug}`, FIVE_RARITY[r.tier - 1], ROD_SUBJECT[r.slug]));
mine.PICKAXE_TIERS.forEach((p) => add(`mine:${p.slug}`, FIVE_RARITY[p.tier - 1], PICKAXE_SUBJECT[p.slug]));

// activity upgrades (successBonus -> Uncommon, rarityBonus -> Rare, else Uncommon)
const upgradeRarity = (u) => (u.effect && u.effect.rarityBonus ? 'Rare' : 'Uncommon');
[['hunt', hunt.WEAPON_UPGRADES], ['fish', fish.ROD_UPGRADES], ['mine', mine.PICKAXE_UPGRADES]].forEach(([ns, ups]) => {
    Object.values(ups).forEach((u) => add(`${ns}:${u.id}`, upgradeRarity(u), SUBJECT[u.id]));
});

// activity packs (ammo / bait / blast) -> escalate Common..Epic
[['hunt', hunt.AMMO_PACKS], ['fish', fish.BAIT_PACKS], ['mine', mine.BLAST_PACKS]].forEach(([ns, packs]) => {
    packs.forEach((p, i) => add(`${ns}:${p.id}`, PACK_RARITY[i] || 'Epic', SUBJECT[p.id]));
});

// activity consumables -> per-id rarity table
const CONSUMABLE_RARITY = {
    basic_bait: 'Uncommon', premium_bait: 'Rare', luck_charm: 'Rare', hunters_focus: 'Uncommon',
    repair_kit_small: 'Common', repair_kit_large: 'Uncommon', stamina_tonic: 'Common', xp_scroll: 'Uncommon',
    chum_bait: 'Uncommon', premium_chum: 'Rare', anglers_luck: 'Uncommon', fish_xp_scroll: 'Uncommon',
    energy_drink: 'Common', hunters_brew: 'Uncommon',
    ore_magnet: 'Uncommon', premium_magnet: 'Rare', miners_lamp: 'Rare', miners_instinct: 'Uncommon',
    energy_tonic: 'Common', mine_lock: 'Uncommon',
};
[['hunt', hunt.CONSUMABLES], ['fish', fish.CONSUMABLES], ['mine', mine.CONSUMABLES]].forEach(([ns, cons]) => {
    Object.values(cons).forEach((c) => add(`${ns}:${c.id}`, CONSUMABLE_RARITY[c.id] || 'Uncommon', SUBJECT[c.id]));
});

// activity places (zones / locations / depths) -> escalate Common..Legendary
[['hunt', hunt.ZONE_LIST], ['fish', fish.LOCATION_LIST], ['mine', mine.DEPTH_LIST]].forEach(([ns, places]) => {
    places.forEach((pl, i) => add(`${ns}:${pl.id}`, PLACE_RARITY[i] || 'Legendary', SUBJECT[pl.id]));
});

// guild shop -> explicit rarity field, bare itemId key
SHOP.forEach((s) => add(s.itemId, s.rarity, SUBJECT[s.itemId]));

// --- catch / kill / mine results --------------------------------------------
// The species/animals/ores a cast, hunt or dig produces. They are not gear and
// not shop items, so they carry their own namespace (`fishcatch:`, `animal:`,
// `ore:`) — see src/data/activityItems.js. Their rarity is the item's own `tier`
// field, and the subject is written from the item's name + `flavor` (the flavor
// is where the visual idea lives, the same role `lore`/`description` plays for
// gear). The `event` tier — Clawdia's rarest, the "MYTHICAL CATCH" bracket —
// maps onto the Mythic rim (molten-orange), the one rarity above Legendary.
const CATCH_RARITY = {
    common: 'Common', uncommon: 'Uncommon', rare: 'Rare',
    epic: 'Epic', legendary: 'Legendary', event: 'Mythic',
};
// Flavor lines open with a scene-setting emoji on the rarest drops (🚨, 🔥, 🌠);
// strip any leading non-letters so the prompt starts on the sentence.
const flavorText = (s) => (s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
const RESULT_SUBJECT = {
    fish:   (f) => `a ${f.name}, a single fish shown side-on. ${flavorText(f.flavor)}`,
    animal: (a) => `a ${a.name}, a single wild animal. ${flavorText(a.flavor)}`,
    ore:    (o) => `a single raw chunk of ${o.name}, a mined mineral ore. ${flavorText(o.flavor)}`,
};
const addResult = (ns, kind, item) => {
    const rarityName = CATCH_RARITY[item.tier];
    if (!rarityName) throw new Error(`${ns}:${item.id}: unmapped tier "${item.tier}"`);
    add(`${ns}:${item.id}`, rarityName, RESULT_SUBJECT[kind](item));
};
Object.values(fish.FISH).forEach((f) => addResult('fishcatch', 'fish', f));
Object.values(hunt.ANIMALS).forEach((a) => addResult('animal', 'animal', a));
Object.values(mine.ORES).forEach((o) => addResult('ore', 'ore', o));

// --- pets --------------------------------------------------------------------
// Pets (issue #1082) are a fixed roster rendered in /pet. They carry their own
// `pet:` namespace (src/data/activityItems.js) and a *portrait* framing distinct
// from the item silhouettes — a front-facing character mascot rather than a
// centered object — while keeping the B3 rarity rim + flat two-tone shading so
// they read as the same set. Art is per species, not per personality.
//
// Rarity by tier: the six ownable species escalate by adoption cost
// (dog/cat Common → bird/fish Uncommon → fox Rare → wolf Epic), the four
// unpurchasable rare companions (eagle/shark/crystal_fox/lantern_owl) that only
// drop from a legendary grind result are Legendary, and the four wild battle
// opponents are Common.
const PET_STYLE = (rarityName) => {
    const rim = RARITY[rarityName].word;
    return `Style: bold cartoon creature portrait, front-facing friendly character mascot, head-and-shoulders framing, thick ${rim} rarity rim, minimal flat shading with two tones, no gloss highlight, vibrant saturated colors, single character centered with generous padding, no text, transparent background. Readable at small emoji size.`;
};
const petPrompt = (subject, rarityName) => `Pet portrait icon: ${subject} ${PET_STYLE(rarityName)}`;

const PET_RARITY = {
    dog: 'Common', cat: 'Common', bird: 'Uncommon', fish: 'Uncommon', fox: 'Rare', wolf: 'Epic',
    eagle: 'Legendary', shark: 'Legendary', crystal_fox: 'Legendary', lantern_owl: 'Legendary',
    wild_boar: 'Common', feral_cat: 'Common', stray_hound: 'Common', cave_bat: 'Common',
};

// One portrait per species, front-facing so the whole set frames alike. The
// four Legendary companions carry a soft glow the way the higher gear tiers do,
// to read as the rarer tier without breaking the flat B3 look.
const PET_SUBJECT = {
    dog:          'a cheerful brown-and-tan puppy with big friendly eyes, floppy ears and a lolling tongue, sitting and facing the viewer.',
    cat:          'a sleek orange tabby cat with green eyes and a calm, curious expression, sitting upright and facing the viewer.',
    bird:         'a small round songbird with bright blue and yellow plumage and a cheerful beak, perched and facing the viewer with its head tilted.',
    fish:         'a plump tropical pet fish with orange and white fins, flowing tail and big round eyes, shown side-on and facing the viewer.',
    fox:          'a bright orange-red fox with a white chest and a bushy tail, sitting alert with a clever grin and facing the viewer.',
    wolf:         'a proud grey timber wolf with amber eyes and a thick furry ruff, head and shoulders facing the viewer.',
    eagle:        'a majestic bald eagle with a white head, sharp golden hooked beak and a fierce gaze, head and shoulders facing the viewer, a faint radiant glow.',
    shark:        'a sleek grey great white shark with a toothy grin and a pale underbelly, shown side-on facing the viewer, a faint aura.',
    crystal_fox:  'a mystical fox sculpted from glowing translucent blue crystal, faceted fur and shining eyes, sitting and facing the viewer, a soft magical glow.',
    lantern_owl:  'a wise round owl whose chest holds a glowing amber lantern, big luminous eyes and soft feathers, facing the viewer, a warm soft glow.',
    wild_boar:    'a bristly brown wild boar with curved tusks, a snorting snout and small angry eyes, head and shoulders facing the viewer.',
    feral_cat:    'a scruffy grey alley cat with a torn ear, patchy fur and a wary hiss, facing the viewer.',
    stray_hound:  'a lean scruffy stray hound with matted brown fur and a scrappy, alert stance, facing the viewer.',
    cave_bat:     'a small dark cave bat with spread leathery wings, big ears and beady eyes, facing the viewer.',
};

const addPet = (petId) => {
    const rarityName = PET_RARITY[petId];
    const subject = PET_SUBJECT[petId];
    if (!rarityName) throw new Error(`no rarity for pet ${petId}`);
    if (!subject) throw new Error(`no subject for pet ${petId}`);
    manifest.push({
        index: index++,
        key: `pet:${petId}`,
        file: `pet__${petId}.png`,
        rarity: rarityName,
        rim: RARITY[rarityName].word,
        rimHex: RARITY[rarityName].hex,
        prompt: petPrompt(subject, rarityName),
    });
};
Object.keys(PET_SUBJECT).forEach(addPet);

// --- explore regions and relics ---------------------------------------------
// Exploration's two icon families (see src/data/activityItems.js). Regions are
// the "places" of /explore — the analog of hunt zones / fish locations / mine
// depths — so they take the same "round scene emblem" framing, and the five
// core regions the same Common..Legendary depth ladder. The five seasonal
// regions have no depth tier (the calendar gates them, not the level) and
// neither /hunt nor /fish has a seasonal-place rarity to mirror, so they take a
// flat Rare rim. Relics are the collectible payoff — single objects like the
// gear icons — and read their rarity straight off the relic's own tier.
const REGION_SUBJECT = {
    whispering_forest: 'a round scene emblem of a moody old-growth pine forest in green half-light, gnarled trunks and drifting mist.',
    crumbling_ruins:   'a round scene emblem of toppled marble ruins, broken columns and a headless statue under a pale sky.',
    crystal_caves:     'a round scene emblem of a glittering cavern of humming violet crystals, faceted walls glowing from within.',
    sunken_docks:      'a round scene emblem of a half-sunken harbor town, barnacled docks and rooftops rising from calm blue water.',
    starfall_wastes:   'a round scene emblem of a black-glass desert under a starry night sky, meteor craters and a single falling star.',
    frostveil_pass:    'a round scene emblem of a snowbound mountain pass strung with glowing lanterns and soft falling snow.',
    hollowgrave_lane:  "a round scene emblem of a foggy crooked lane of leaning houses lit by grinning jack-o'-lanterns.",
    scorchglass_shore: 'a round scene emblem of a sunlit beach of shimmering glass sand beside turquoise summer waves.',
    velvet_arcade:     'a round scene emblem of a gaslit covered arcade of little shopfronts with warm rose light and hanging lamps.',
    arctic_tundra:     'a round scene emblem of a flat frozen tundra under a green aurora, ice and distant white peaks.',
};

const RELIC_SUBJECT = {
    // whispering_forest
    whisperwood_charm:         'a small charm of pale knotted wood on a leather cord, faint carved swirls.',
    candlewax_antler:          'a shed deer antler tip dripping warm candlewax, a tiny flame glowing at its point.',
    the_tenth_owl:             'a small carved stone owl statuette with softly glowing eyes.',
    // crumbling_ruins
    headless_coin:             'an ancient tarnished gold coin stamped with a faceless headless figure.',
    curators_brass_key:        'an ornate antique brass key with a museum-crest bow, faintly gleaming.',
    the_final_decree:          'an imperial wax seal on a ribbon, pressed with a signet crest and still glowing warm.',
    // crystal_caves
    singing_scale:             'a single translucent crystal dragon scale ringing with faint sound waves.',
    bottled_resonance:         'a corked glass vial holding swirling glowing sound-waves of violet light.',
    shard_of_the_frozen_storm: 'a jagged crystal shard with a bolt of golden lightning frozen and crackling inside it.',
    // sunken_docks
    harbormasters_stamp:       "a heavy brass-bound wooden harbormaster's ink stamp dripping blue ink.",
    bottled_fog:               'a corked glass bottle full of swirling grey harbor fog with a tiny lantern glow inside.',
    the_return_ticket:         'an old unpunched steamship ticket, edges water-stained, faintly glowing gold.',
    // starfall_wastes
    compacted_starlight:       'a polished shard of glowing blue-white starlight lens, cool light held within.',
    glassback_plate:           'a faceted plate of black volcanic glass armor with warm orange light in its cracks.',
    the_still_falling_stone:   'a dark meteor fragment hovering just above the ground, trailing faint golden falling-star light.',
    // frostveil_pass (seasonal)
    unmelting_rose:            'a delicate rose sculpted entirely from packed glittering snow.',
    the_yetis_pencil:          'a stubby well-chewed wooden pencil, oversized and dusted with frost.',
    // hollowgrave_lane (seasonal)
    grinning_doorknocker:      'an ornate brass door knocker shaped like a grinning face.',
    jar_of_bottled_dusk:       "a corked jar holding glowing orange October dusk, a tiny jack-o'-lantern light within.",
    // scorchglass_shore (seasonal)
    pocketful_of_july:         'a small handful of warm amber-gold glass pebbles catching sunlight.',
    the_free_sample:           'a polished spiral conch shell glowing with soft summer light, faint music rising from it.',
    // velvet_arcade (seasonal)
    exact_change_courage:      'a small engraved brass token stamped with a heart-and-envelope crest.',
    the_unclaimed_velvet_box:  'an open red velvet ring box holding a softly glowing gold ring.',
    // arctic_tundra (seasonal)
    tundra_trackers_compass:   'a worn brass compass with a glowing needle and frost on its glass.',
    sliver_of_the_white_stag:  'a sliver of pale antler carved with frost patterns, radiating faint cold blue light.',
};

const RELIC_RARITY = { rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

// Regions: the core five ladder Common..Legendary by depth, the seasonal five
// take a flat Rare rim.
const coreRegions     = explore.REGION_LIST.filter(r => !r.seasonalEventId);
const seasonalRegions = explore.REGION_LIST.filter(r =>  r.seasonalEventId);
coreRegions.forEach((r, i) => add(`explore:${r.id}`, PLACE_RARITY[i] || 'Legendary', REGION_SUBJECT[r.id]));
seasonalRegions.forEach((r) => add(`explore:${r.id}`, 'Rare', REGION_SUBJECT[r.id]));

// Relics: single-object icons, rarity from the relic's own tier.
explore.RELIC_LIST.forEach((r) => add(`relic:${r.slug}`, RELIC_RARITY[r.rarity], RELIC_SUBJECT[r.slug]));

// --- validate against the game registries -----------------------------------
// Every namespaced key must be a known game key: a shop-browse gear id or a
// catch/kill/mine result id (both uploadable), or a pet species / explore region
// / explore relic id (all bundle-only, see src/data/activityItems.js) —
// otherwise it is a typo the app will never ask for. The bundle-only keys are
// included here but not in `isUploadableItemId`: their art ships only as a baked
// default, never a per-guild upload.
const { ACTIVITY_ITEM_IDS, RESULT_ITEM_IDS, PET_ITEM_IDS, EXPLORE_ITEM_IDS } = require('../../src/data/activityItems.js');
const knownKeys = new Set([...ACTIVITY_ITEM_IDS, ...RESULT_ITEM_IDS, ...PET_ITEM_IDS, ...EXPLORE_ITEM_IDS]);
// Every prompt ends with the shared B3 style block; "rarity rim," is the phrase
// both the item and the pet-portrait style blocks carry, so its absence means a
// prompt was never assembled.
const missingSubjects = manifest.filter((m) => !m.prompt.includes('rarity rim,')).map((m) => m.key);
const badActivity = manifest
    .filter((m) => m.key.includes(':'))
    .filter((m) => !knownKeys.has(m.key))
    .map((m) => m.key);
if (missingSubjects.length) throw new Error(`missing subjects: ${missingSubjects.join(', ')}`);
if (badActivity.length) throw new Error(`keys not in the known id set: ${badActivity.join(', ')}`);

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest: ${manifest.length} items`);
const byRarity = manifest.reduce((a, m) => ((a[m.rarity] = (a[m.rarity] || 0) + 1), a), {});
console.log('by rarity:', JSON.stringify(byRarity));
