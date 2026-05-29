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
    void_essence:      { tier: 5, emoji: '🌑', label: 'Void Essence',        source: 'mine' }
};

const TIER_LABELS = { 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic', 5: 'Legendary' };
const TIER_STARS  = { 1: '⭐', 2: '⭐⭐', 3: '⭐⭐⭐', 4: '⭐⭐⭐⭐', 5: '⭐⭐⭐⭐⭐' };
const TIER_COLORS = { 1: '#9e9e9e', 2: '#4caf50', 3: '#2196f3', 4: '#9c27b0', 5: '#ff9800' };

module.exports = { MATERIAL_RARITY, TIER_LABELS, TIER_STARS, TIER_COLORS };
