'use strict';

// /mine — the command definition and nothing else but dispatch.
//
// This was one 2,806-line file: the dig roll, every embed, the shop, quests,
// raids and depth handling, all beside a service layer that already existed for
// exactly this logic (#721). Each group now has its own file and this one only
// routes to it, which is also why the folder is a command rather than a file —
// the loader treats <category>/<name>/index.js as one command, so the siblings
// here never register as commands of their own.

const { SlashCommandBuilder } = require('discord.js');
const {
    DEPTH_LIST,
    CONSUMABLES,
    BLAST_PACKS,
    PICKAXE_TIERS,
    PICKAXE_UPGRADES,
    CHOOSABLE_INTENSITY,
    MINE_QUEST_TEMPLATES
} = require('../../../data/mineData');
const { handleDig } = require('./dig');
const { handleProfile, handlePrestige } = require('./profile');
const { handleInv, handleEquip, handleDiscard } = require('./inventory');
const { handleQuests } = require('./quests');
const { handleShop } = require('./shop');
const { handleMap } = require('./map');
const { handleRaid } = require('./raid');
// /mine shop use picks from the consumables the player holds.
const { autocompleteUse } = require('./shop/use');

const DEPTH_CHOICES    = DEPTH_LIST.map(d => ({ name: d.name, value: d.id }));
const PICKAXE_CHOICES  = PICKAXE_TIERS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost.toLocaleString()} coins`, value: p.slug }));
const ALL_ITEMS        = [...Object.values(CONSUMABLES), ...BLAST_PACKS];
const ITEM_CHOICES     = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const UPGRADE_CHOICES  = Object.values(PICKAXE_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES   = DEPTH_LIST.filter(d => !d.defaultUnlocked).map(d => ({ name: `${d.emoji} ${d.name}`, value: d.id }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Mining: dig, profile, inventory, quests, and shop.')
        .addSubcommand(sub =>
            sub.setName('dig')
                .setDescription('Mine ore in your current depth. Uses 1 stamina. Cooldown: 30s.')
                .addStringOption(o =>
                    o.setName('depth')
                        .setDescription('Depth to mine in (defaults to your active depth).')
                        .setRequired(false)
                        .addChoices(...DEPTH_CHOICES))
                .addIntegerOption(o =>
                    o.setName('intensity')
                        .setDescription('How hard to push. Skips the prompt, so you dig without reading the rock first.')
                        .setRequired(false)
                        .addChoices(...CHOOSABLE_INTENSITY.map(l => ({
                            name:  `${l.emoji} ${l.name} — ${l.multiplier}× base payout, ${Math.round(l.caveInRisk * 100)}% base cave-in risk`,
                            value: l.level,
                        })))))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's miner profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('inv')
                .setDescription('View your whole mining inventory, or one category in full')
                .addStringOption(o =>
                    o.setName('category')
                        .setDescription('Open one category in full (default: an overview of everything)')
                        .setRequired(false)
                        .addChoices(
                            { name: '🪓 Pickaxes',    value: 'pickaxes' },
                            { name: '💥 Charges',     value: 'charges' },
                            { name: '🎒 Consumables', value: 'consumables' },
                            { name: '🪨 Materials',   value: 'materials' }
                        )))
        .addSubcommand(sub =>
            sub.setName('equip')
                .setDescription('Equip a pickaxe from your inventory')
                .addIntegerOption(o =>
                    o.setName('slot')
                        .setDescription('Pickaxe slot number (use /mine inv to see slots)')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('discard')
                .setDescription('Discard a broken or condemned pickaxe')
                .addIntegerOption(o =>
                    o.setName('slot')
                        .setDescription('Pickaxe slot number (use /mine inv to see slots)')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily mine quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('See your active daily mine quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addStringOption(o =>
                            o.setName('quest')
                                .setDescription('Quest to claim')
                                .setRequired(true)
                                .addChoices(...MINE_QUEST_TEMPLATES.map(t => ({ name: t.name, value: t.id }))))))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Reset your Miner Level for permanent bonuses (requires Miner Level 50)'))
        .addSubcommand(sub =>
            sub.setName('map')
                .setDescription('View your persistent mine map — see every cell you have excavated.'))
        .addSubcommand(sub =>
            sub.setName('raid')
                .setDescription('Raid another miner and steal some of their crafting materials (requires pickaxe equipped)')
                .addUserOption(o =>
                    o.setName('target')
                        .setDescription('The miner to raid')
                        .setRequired(true)))
        .addSubcommandGroup(group =>
            group.setName('shop')
                .setDescription('Browse and purchase all mining gear, charges, and supplies')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse everything available in the mining shop'))
                .addSubcommand(sub =>
                    sub.setName('pickaxe')
                        .setDescription('Buy a new pickaxe')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which pickaxe to buy')
                                .setRequired(true)
                                .addChoices(...PICKAXE_CHOICES))
                        .addBooleanOption(o =>
                            o.setName('equip')
                                .setDescription('Auto-equip after purchase (default: true)')
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('upgrade')
                        .setDescription('Install a module upgrade on your equipped pickaxe (one per pickaxe, permanent)')
                        .addStringOption(o =>
                            o.setName('module')
                                .setDescription('Upgrade module to install')
                                .setRequired(true)
                                .addChoices(...UPGRADE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('buy')
                        .setDescription('Purchase blast charge packs or consumables')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Item to buy')
                                .setRequired(true)
                                .addChoices(...ITEM_CHOICES))
                        .addIntegerOption(o =>
                            o.setName('quantity')
                                .setDescription('How many to buy (default: 1)')
                                .setRequired(false)
                                .setMinValue(1)
                                .setMaxValue(20)))
                .addSubcommand(sub =>
                    sub.setName('use')
                        .setDescription('Activate a consumable buff')
                        .addStringOption(o =>
                            o.setName('item')
                                .setDescription('Consumable to activate — start typing to pick from what you hold')
                                .setRequired(true)
                                .setMaxLength(100)
                                .setAutocomplete(true)))
                .addSubcommand(sub =>
                    sub.setName('repair')
                        .setDescription('Repair your equipped pickaxe at the shop or use a repair kit')
                        .addStringOption(o =>
                            o.setName('method')
                                .setDescription('Repair method')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Shop repair (pay coins)', value: 'shop' },
                                    { name: 'Use Small Repair Kit',    value: 'kit_small' },
                                    { name: 'Use Large Repair Kit',    value: 'kit_large' }
                                )))
                .addSubcommand(sub =>
                    sub.setName('unlock')
                        .setDescription('Unlock a new mine depth')
                        .addStringOption(o =>
                            o.setName('depth')
                                .setDescription('Depth to unlock')
                                .setRequired(true)
                                .addChoices(...UNLOCK_CHOICES)))),

    // Only `shop use` autocompletes: the consumables the player holds, with how
    // many and whether each is ready (utils/grindUsePicker).
    async autocomplete(interaction) {
        if (interaction.options.getSubcommandGroup(false) === 'shop'
            && interaction.options.getSubcommand(false) === 'use') {
            return autocompleteUse(interaction);
        }
        return interaction.respond([]);
    },

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'dig')     return handleDig(interaction);
            if (sub === 'profile') return handleProfile(interaction);
            if (sub === 'map')     return handleMap(interaction);
            if (sub === 'raid')    return handleRaid(interaction);
            if (sub === 'prestige') return handlePrestige(interaction);
            if (sub === 'inv')     return handleInv(interaction);
            if (sub === 'equip')   return handleEquip(interaction);
            if (sub === 'discard') return handleDiscard(interaction);
        }
        if (group === 'quests') return handleQuests(interaction, sub);
        if (group === 'shop')   return handleShop(interaction, sub);
    }
};

// ── Per-user economy lock ─────────────────────────────────────────────────────
// Mining mutates the user document with read-modify-write saves, so concurrent
// /mine invocations from the same user can race stamina, daily caps, and drops.
// The lock key is the player rather than this command, so a hand of blackjack
// races the same document and contends for it too — see utils/economyLock.js.
const { withEconomyLock, exceptReadOnly } = require('../../../utils/economyLock');
// Reads that persist nothing, so they never wait on a lease — see
// exceptReadOnly. Everything else, including /mine raid, /mine equip and
// /mine discard, still locks.
const MINE_READ_ONLY = [
    'profile', 'map',
    'inv',
    'shop list',
];
module.exports.execute = withEconomyLock(module.exports.execute, {
    activity: 'mine',
    only:     exceptReadOnly(MINE_READ_ONLY),
});

