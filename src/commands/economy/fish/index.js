'use strict';

// /fish — the command definition and nothing else but dispatch.
//
// Before #721 this was one file of about 3,200 lines holding roughly forty-five
// top-level functions: the cast roll, every embed, the shop, crafting, quests,
// repairs and location handling, all beside a service layer that already
// existed for exactly this logic. What it comes to today is in README's "Shape
// of the codebase" table, which is generated — a second figure written down
// here is the drift #916 was about.
//
// Each group now has its own file and this one only routes to it,
// which is also why the folder is a command rather than a file — the loader
// treats <category>/<name>/index.js as one command, so the siblings here never
// register as commands of their own.

const { SlashCommandBuilder } = require('discord.js');
const {
    LOCATION_LIST, ROD_UPGRADES, BAIT_PACKS, CONSUMABLES, ROD_TIERS,
    FISH_CRAFT_RECIPES
} = require('../../../data/fishData');
const { handleCast } = require('./cast');
const { handleProfile, handlePrestige, handleInv } = require('./profile');
const { handleQuests } = require('./quests');
const { handleShop } = require('./shop');
const { handleCraft } = require('./craft');
const { handleLocation } = require('./location');
const { handleTournament, handleRecords } = require('./tournament');

const LOCATION_CHOICES = LOCATION_LIST.map(l => ({ name: l.name, value: l.id }));

const SHOP_CHOICES = [
    ...BAIT_PACKS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost} coins`, value: p.id })),
    ...Object.values(CONSUMABLES).map(c => ({ name: `${c.emoji} ${c.name} — ${c.cost} coins`, value: c.id }))
];

const USE_CHOICES = Object.values(CONSUMABLES)
    .filter(c => c.type !== 'repair')
    .map(c => ({ name: `${c.emoji} ${c.name}`, value: c.id }));

const ROD_CHOICES     = ROD_TIERS.map(r => ({ name: `${r.emoji} ${r.name} (${r.cost.toLocaleString()} coins)`, value: r.slug }));

const UPGRADE_CHOICES = Object.values(ROD_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));

const UNLOCK_CHOICES  = LOCATION_LIST.filter(l => !l.defaultUnlocked).map(l => ({ name: `${l.emoji} ${l.name}`, value: l.id }));

const RECIPE_CHOICES = Object.values(FISH_CRAFT_RECIPES).map(r => ({ name: r.name, value: r.id }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fish')
        .setDescription('Fishing: cast lines, manage gear, shop, craft, quests, locations, and prestige.')
        .addSubcommand(sub =>
            sub.setName('cast')
                .setDescription('Cast your line and catch fish. 1 stamina per cast. Cooldown: 45s.')
                .addStringOption(o =>
                    o.setName('location')
                        .setDescription('Location to fish at (defaults to your active location).')
                        .setRequired(false)
                        .addChoices(...LOCATION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's fishing profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Reset your fisher level for permanent prestige bonuses (requires Level 50)'))
        .addSubcommand(sub =>
            sub.setName('records')
                .setDescription('View the server\'s all-time fishing world records'))
        .addSubcommandGroup(group =>
            group.setName('inv')
                .setDescription('View and manage your fishing inventory')
                .addSubcommand(sub =>
                    sub.setName('rods')
                        .setDescription('View your fishing rods'))
                .addSubcommand(sub =>
                    sub.setName('equip')
                        .setDescription('Equip a rod by its inventory number')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Rod number from /fish inv rods')
                                .setMinValue(1)
                                .setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('bait')
                        .setDescription('View your bait and consumable stock'))
                .addSubcommand(sub =>
                    sub.setName('materials')
                        .setDescription('View your crafting materials')))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily fishing quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View your active daily fishing quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Quest number to claim')
                                .setMinValue(1)
                                .setRequired(true))))
        .addSubcommandGroup(group =>
            group.setName('shop')
                .setDescription('Browse and purchase fishing gear, bait, and supplies')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse everything available in the fishing shop'))
                .addSubcommand(sub =>
                    sub.setName('rod')
                        .setDescription('Buy a new fishing rod')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which rod to buy')
                                .setRequired(true)
                                .addChoices(...ROD_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('upgrade')
                        .setDescription('Install an upgrade on your equipped rod (one per rod, permanent)')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which upgrade to install')
                                .setRequired(true)
                                .addChoices(...UPGRADE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('buy')
                        .setDescription('Purchase bait packs or consumables')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Item to buy')
                                .setRequired(true)
                                .addChoices(...SHOP_CHOICES))
                        .addIntegerOption(o =>
                            o.setName('quantity')
                                .setDescription('How many to buy (default 1; bait packs are per-pack)')
                                .setMinValue(1)
                                .setMaxValue(10)
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('use')
                        .setDescription('Activate a consumable (bait / luck / xp scroll / energy drink)')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Which consumable to activate')
                                .setRequired(true)
                                .addChoices(...USE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('repair')
                        .setDescription('Repair your equipped rod at the shop or use a repair kit')
                        .addStringOption(o =>
                            o.setName('method')
                                .setDescription('Repair method')
                                .setRequired(true)
                                .addChoices(
                                    { name: '🔧 Shop Repair — costs coins, slightly degrades max durability', value: 'shop' },
                                    { name: '🪛 Repair Kit — free from inventory, no degradation',           value: 'kit' }
                                ))
                        .addStringOption(o =>
                            o.setName('kit')
                                .setDescription('Kit size to use (kit method only)')
                                .setRequired(false)
                                .addChoices(
                                    { name: 'Small Repair Kit (+20 durability)', value: 'repair_kit_small' },
                                    { name: 'Large Repair Kit (+50 durability)', value: 'repair_kit_large' }
                                ))
                        .addIntegerOption(o =>
                            o.setName('amount')
                                .setDescription('Durability to restore at shop (default: full repair)')
                                .setMinValue(1)
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('unlock')
                        .setDescription('Unlock a new fishing location')
                        .addStringOption(o =>
                            o.setName('location')
                                .setDescription('Location to unlock')
                                .setRequired(true)
                                .addChoices(...UNLOCK_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('craft')
                .setDescription('Craft items from fishing (and hunting) materials')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse all available fishing crafting recipes'))
                .addSubcommand(sub =>
                    sub.setName('make')
                        .setDescription('Craft an item from your materials')
                        .addStringOption(o =>
                            o.setName('recipe')
                                .setDescription('Recipe to craft')
                                .setRequired(true)
                                .addChoices(...RECIPE_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('location')
                .setDescription('View and switch your active fishing location')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View all fishing locations and their requirements'))
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Switch to an unlocked location')
                        .addStringOption(o =>
                            o.setName('location')
                                .setDescription('Location to fish at')
                                .setRequired(true)
                                .addChoices(...LOCATION_LIST.map(l => ({ name: `${l.emoji} ${l.name}`, value: l.id }))))))
        .addSubcommandGroup(group =>
            group.setName('tournament')
                .setDescription('Fishing tournament commands')
                .addSubcommand(sub =>
                    sub.setName('status')
                        .setDescription('View the current tournament leaderboard'))
                .addSubcommand(sub =>
                    sub.setName('start')
                        .setDescription('Start a fishing tournament (admin only)')
                        .addIntegerOption(o =>
                            o.setName('duration')
                                .setDescription('Tournament duration in minutes (default 60)')
                                .setMinValue(15)
                                .setMaxValue(180)
                                .setRequired(false))
                        .addIntegerOption(o =>
                            o.setName('prize_pool')
                                .setDescription('Starting prize pool (coins to seed)')
                                .setMinValue(0)
                                .setRequired(false))
                        .addIntegerOption(o =>
                            o.setName('entry_fee')
                                .setDescription('Entry fee per participant (0 = free)')
                                .setMinValue(0)
                                .setRequired(false)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'cast')     return handleCast(interaction);
            if (sub === 'profile')  return handleProfile(interaction);
            if (sub === 'prestige') return handlePrestige(interaction);
            if (sub === 'records')  return handleRecords(interaction);
            return;
        }

        if (group === 'inv')         return handleInv(interaction, sub);
        if (group === 'quests')      return handleQuests(interaction, sub);
        if (group === 'shop')        return handleShop(interaction, sub);
        if (group === 'craft')       return handleCraft(interaction, sub);
        if (group === 'location')    return handleLocation(interaction, sub);
        if (group === 'tournament')  return handleTournament(interaction, sub);
    }
};

// ── Per-user economy lock ─────────────────────────────────────────────────────
// Fishing mutates the user document with read-modify-write saves, so concurrent
// /fish invocations from the same user can race stamina, daily caps, and drops.
// The lock key is the player rather than this command, so a hand of blackjack
// races the same document and contends for it too — see utils/economyLock.js.
const { withEconomyLock, exceptReadOnly } = require('../../../utils/economyLock');
// Reads that persist nothing, so they never wait on a lease — see
// exceptReadOnly. Everything else, including /fish inv equip, still locks.
const FISH_READ_ONLY = [
    'profile', 'records',
    'inv rods', 'inv bait', 'inv materials',
    'shop list',
    'craft list',
    'location list',
];
module.exports.execute = withEconomyLock(module.exports.execute, {
    activity: 'fish',
    only:     exceptReadOnly(FISH_READ_ONLY),
});

