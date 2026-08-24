// Rarity tier mapping for all hunt/fish/mine materials
// Tiers: 1=common, 2=uncommon, 3=rare, 4=epic, 5=legendary

const MATERIAL_RARITY = {
    // Hunt materials
    rabbits_foot:      { tier: 1, emoji: '🐾', label: 'Rabbit\'s Foot',     source: 'hunt' },
    acorn_cache:       { tier: 1, emoji: '🌰', label: 'Acorn Cache',         source: 'hunt' },
    feather:           { tier: 1, emoji: '🪶', label: 'Feather',             source: 'hunt' },
    down_feather:      { tier: 1, emoji: '🪶', label: 'Down Feather',        source: 'hunt' },
    antler_fragment:   { tier: 2, emoji: '🦌', label: 'Antler Fragment',     source: 'hunt' },
    tusk_shard:        { tier: 2, emoji: '🐗', label: 'Tusk Shard',          source: 'hunt' },
    badger_pelt:       { tier: 2, emoji: '🦡', label: 'Badger Pelt',         source: 'hunt' },
    beaver_pelt:       { tier: 2, emoji: '🦫', label: 'Beaver Pelt',         source: 'hunt' },
    coyote_fang:       { tier: 3, emoji: '🐺', label: 'Coyote Fang',         source: 'hunt' },
    wolf_pelt:         { tier: 3, emoji: '🐺', label: 'Wolf Pelt',           source: 'hunt' },
    elk_antler:        { tier: 3, emoji: '🦌', label: 'Elk Antler',          source: 'hunt' },
    lynx_fang:         { tier: 3, emoji: '🐱', label: 'Lynx Fang',          source: 'hunt' },
    eagle_talon:       { tier: 4, emoji: '🦅', label: 'Eagle Talon',         source: 'hunt' },
    mountain_horn:     { tier: 4, emoji: '🏔️', label: 'Mountain Horn',       source: 'hunt' },
    bear_claw:         { tier: 4, emoji: '🐻', label: 'Bear Claw',           source: 'hunt' },
    moose_rack:        { tier: 4, emoji: '🫎', label: 'Moose Rack',          source: 'hunt' },
    lion_tooth:        { tier: 5, emoji: '🦁', label: 'Lion\'s Tooth',       source: 'hunt' },
    wolverine_fur:     { tier: 5, emoji: '🦡', label: 'Wolverine Fur',       source: 'hunt' },
    spirit_pelt:       { tier: 5, emoji: '👻', label: 'Spirit Pelt',         source: 'hunt' },
    megaloceros_crown: { tier: 5, emoji: '⚡', label: 'Megaloceros Crown',   source: 'hunt' },
    golden_fur:        { tier: 5, emoji: '🌟', label: 'Golden Fur',          source: 'hunt' },
    spirit_essence:    { tier: 5, emoji: '💎', label: 'Spirit Essence',      source: 'hunt' },
    ancient_claw:      { tier: 5, emoji: '🔮', label: 'Ancient Claw',        source: 'hunt' },
    thunderfeather:    { tier: 5, emoji: '⚡', label: 'Thunderfeather',      source: 'hunt' },
    spectral_bone:     { tier: 5, emoji: '💀', label: 'Spectral Bone',       source: 'hunt' },
    bandit_mask:       { tier: 5, emoji: '🎭', label: 'Bandit Mask',         source: 'hunt' },

    // Fishing materials
    fish_scale:        { tier: 1, emoji: '🐟', label: 'Fish Scale',          source: 'fish' },
    seaweed_bundle:    { tier: 1, emoji: '🌿', label: 'Seaweed Bundle',      source: 'fish' },
    driftwood:         { tier: 1, emoji: '🪵', label: 'Driftwood',           source: 'fish' },
    rare_scale:        { tier: 2, emoji: '✨', label: 'Rare Scale',          source: 'fish' },
    old_coin:          { tier: 2, emoji: '🪙', label: 'Old Coin',            source: 'fish' },
    pearl:             { tier: 3, emoji: '🫧', label: 'Pearl',               source: 'fish' },
    coral_fragment:    { tier: 3, emoji: '🪸', label: 'Coral Fragment',      source: 'fish' },
    shark_tooth:       { tier: 4, emoji: '🦈', label: 'Shark Tooth',         source: 'fish' },
    tentacle_ink:      { tier: 4, emoji: '🦑', label: 'Tentacle Ink',        source: 'fish' },
    mythic_scale:      { tier: 5, emoji: '💠', label: 'Mythic Scale',        source: 'fish' },

    // Mining materials
    rock_fragment:     { tier: 1, emoji: '🪨', label: 'Rock Fragment',       source: 'mine' },
    coal_dust:         { tier: 1, emoji: '🖤', label: 'Coal Dust',           source: 'mine' },
    copper_flake:      { tier: 1, emoji: '🟤', label: 'Copper Flake',        source: 'mine' },
    iron_filing:       { tier: 2, emoji: '⚙️', label: 'Iron Filing',         source: 'mine' },
    silver_dust:       { tier: 2, emoji: '🔘', label: 'Silver Dust',         source: 'mine' },
    lead_slug:         { tier: 2, emoji: '🔩', label: 'Lead Slug',           source: 'mine' },
    quartz_shard:      { tier: 3, emoji: '🔷', label: 'Quartz Shard',        source: 'mine' },
    gold_nugget:       { tier: 3, emoji: '🌕', label: 'Gold Nugget',         source: 'mine' },
    raw_sapphire:      { tier: 3, emoji: '💙', label: 'Raw Sapphire',        source: 'mine' },
    amethyst_chip:     { tier: 3, emoji: '💜', label: 'Amethyst Chip',       source: 'mine' },
    topaz_shard:       { tier: 3, emoji: '🟡', label: 'Topaz Shard',         source: 'mine' },
    raw_emerald:       { tier: 4, emoji: '💚', label: 'Raw Emerald',         source: 'mine' },
    raw_ruby:          { tier: 4, emoji: '❤️', label: 'Raw Ruby',            source: 'mine' },
    obsidian_chip:     { tier: 4, emoji: '🖤', label: 'Obsidian Chip',       source: 'mine' },
    platinum_dust:     { tier: 4, emoji: '⬜', label: 'Platinum Dust',       source: 'mine' },
    raw_diamond:       { tier: 4, emoji: '💎', label: 'Raw Diamond',         source: 'mine' },
    crystal_sliver:    { tier: 5, emoji: '🔮', label: 'Crystal Sliver',      source: 'mine' },
    mythril_dust:      { tier: 5, emoji: '🌀', label: 'Mythril Dust',        source: 'mine' },
    zenith_essence:    { tier: 5, emoji: '⭐', label: 'Zenith Essence',      source: 'mine' },
    primordial_ash:    { tier: 5, emoji: '🌋', label: 'Primordial Ash',      source: 'mine' },
    stardust:          { tier: 5, emoji: '✨', label: 'Stardust',            source: 'mine' },
    void_essence:      { tier: 5, emoji: '🌑', label: 'Void Essence',        source: 'mine' },

    // Exploration materials (#753). Exploration used to produce coins, Explorer
    // XP and relics and nothing else, which is why it was the one grind system
    // with no rare companion: a pet's favourite food has to resolve here to be
    // feedable at all, and relics are the wrong shape to point one at — their
    // standing payout bonus counts *distinct* relics, so eating a duplicate
    // would delete part of that bonus.
    //
    // The theme is fieldcraft rather than carcass or ore: what a surveyor comes
    // back with. They drop from treasure finds, tier-matched to the treasure.
    survey_chalk:      { tier: 1, emoji: '🖍️', label: 'Survey Chalk',        source: 'explore' },
    pressed_fern:      { tier: 1, emoji: '🌿', label: 'Pressed Fern',         source: 'explore' },
    frayed_map_corner: { tier: 1, emoji: '🗒️', label: 'Frayed Map Corner',    source: 'explore' },
    waypoint_flint:    { tier: 2, emoji: '🪨', label: 'Waypoint Flint',       source: 'explore' },
    compass_shard:     { tier: 2, emoji: '🧭', label: 'Compass Shard',        source: 'explore' },
    charted_vellum:    { tier: 3, emoji: '📜', label: 'Charted Vellum',       source: 'explore' },
    surveyors_lens:    { tier: 3, emoji: '🔎', label: 'Surveyor\'s Lens',     source: 'explore' },
    lantern_glass:     { tier: 4, emoji: '🏮', label: 'Lantern Glass',        source: 'explore' },
    trailwardens_knot: { tier: 4, emoji: '🪢', label: 'Trailwarden\'s Knot',  source: 'explore' },
    wayfarers_seal:    { tier: 5, emoji: '🕯️', label: 'Wayfarer\'s Seal',     source: 'explore' },
    cartographers_ink: { tier: 5, emoji: '🖋️', label: 'Cartographer\'s Ink',  source: 'explore' }
};

// Tier 6 is the `event` rarity that hunt, fish and mine all roll (Thunderbird,
// Leviathan, Void Ore …). No *material* sits at tier 6 — the event catches drop
// tier-5 materials — but the catch itself outranks legendary, and every presentation
// path keys off these tables, so the ladder has to carry the rung. Leaving it out is
// what made the rarest drops in the game render as common.
const TIER_LABELS = { 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic', 5: 'Legendary', 6: 'Event' };
const TIER_STARS  = { 1: '⭐', 2: '⭐⭐', 3: '⭐⭐⭐', 4: '⭐⭐⭐⭐', 5: '⭐⭐⭐⭐⭐', 6: '☀️☀️☀️☀️☀️' };
const TIER_COLORS = { 1: '#9e9e9e', 2: '#4caf50', 3: '#2196f3', 4: '#9c27b0', 5: '#ff9800', 6: '#e74c3c' };

// Maps tier name strings (used in hunt/fish/mine results) to numeric tier levels.
const TIER_NUM = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, event: 6 };

const RIBBON_DOTS = ['🟢', '🔵', '🟣', '🟡', '🌌', '☄️'];

// Returns the formatted rarity ribbon for a tier number (1–6).
// e.g. TIER_RIBBON(3) → "🟢 ─ 🔵 ─ [🟣] ─ 🟡 ─ 🌌 ─ ☄️"
function TIER_RIBBON(tier) {
    return RIBBON_DOTS.map((dot, i) => {
        const t = i + 1;
        return t === tier ? `[${dot}]` : dot;
    }).join(' ─ ');
}

module.exports = { MATERIAL_RARITY, TIER_LABELS, TIER_STARS, TIER_COLORS, TIER_NUM, TIER_RIBBON };
