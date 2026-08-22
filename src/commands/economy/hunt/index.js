'use strict';

// /hunt — the command definition and nothing else but dispatch.
//
// This was one 3,476-line file: the hunt roll, the aim phase, every embed, the
// shop, quests, repairs and zone handling, all beside a service layer that
// already existed for exactly this logic (#721). Each group now has its own
// file and this one only routes to it, which is also why the folder is a
// command rather than a file — the loader treats <category>/<name>/index.js as
// one command, so the siblings here never register as commands of their own.

const { SlashCommandBuilder } = require('discord.js');
const { ZONE_LIST, CONSUMABLES, AMMO_PACKS, WEAPON_TIERS, WEAPON_UPGRADES, HUNT_QUEST_TEMPLATES } = require('../../../data/huntData');
const { executeStart } = require('./start');
const { executeProfile, executePrestige, executeRecords } = require('./profile');
const { executeInv } = require('./inventory');
const { executeQuests } = require('./quests');
const { executeShop } = require('./shop');
const { executeZone } = require('./zone');
const {
    buildHuntEmbed, buildBonusLines, buildAmmoField, buildLowAmmoField, AMMO_LOW_THRESHOLD,
    buildDailyTollField,
} = require('./embeds');
const { buildTrophyField, buildFieldTrophyField, buildTodayField } = require('./profile');
const { buildWeaponPages, WEAPON_SEPARATOR } = require('./inventory');
const {
    isCrossEconomyWeapon, huntingDaysFor, huntingDaysLabel, fullRepairCost, CROSS_ECONOMY_DAYS,
} = require('./shop');
// The one shared constant the command definition itself needs: /hunt shop use
// offers exactly the items /hunt shop buy knows how to activate.
const { ACTIVATABLE } = require('./shared');

// ─── SHARED CHOICE LISTS ──────────────────────────────────────────────────────

const ZONE_CHOICES    = ZONE_LIST.map(z => ({ name: z.name, value: z.id }));
const WEAPON_CHOICES  = WEAPON_TIERS.map(w => ({ name: `${w.emoji} ${w.name} — ${w.cost.toLocaleString()} coins`, value: w.slug }));
const ALL_ITEMS       = [...Object.values(CONSUMABLES), ...AMMO_PACKS];
const ITEM_CHOICES    = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const UPGRADE_CHOICES = Object.values(WEAPON_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES  = ZONE_LIST.filter(z => !z.defaultUnlocked).map(z => ({ name: `${z.emoji} ${z.name}`, value: z.id }));
const ZONE_SET_CHOICES = ZONE_LIST.map(z => ({ name: `${z.emoji} ${z.name}`, value: z.id }));


module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('hunt')
        .setDescription('Hunt animals, manage gear, quests, zones, and prestige — all in one place')
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Go on a hunt. Uses 1 stamina. 45s cooldown. Equip a weapon with /hunt inv equip.')
                .addStringOption(o =>
                    o.setName('zone')
                        .setDescription('Zone to hunt in (defaults to your active zone)')
                        .setRequired(false)
                        .addChoices(...ZONE_CHOICES))
                .addBooleanOption(o =>
                    o.setName('quick')
                        .setDescription('Skip the stealth & aim phases (no phase bonuses). Remembered for future hunts.')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's hunter profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Reset your hunter level for permanent prestige bonuses (requires Level 50)'))
        .addSubcommand(sub =>
            sub.setName('records')
                .setDescription("View the server's all-time hunting records"))
        .addSubcommandGroup(group =>
            group.setName('inv')
                .setDescription('View and manage your hunt inventory')
                .addSubcommand(sub =>
                    sub.setName('weapons')
                        .setDescription('View your weapon collection'))
                .addSubcommand(sub =>
                    sub.setName('equip')
                        .setDescription('Equip a weapon by its inventory number')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Weapon number from /hunt inv weapons')
                                .setRequired(true)
                                .setMinValue(1)))
                .addSubcommand(sub =>
                    sub.setName('ammo')
                        .setDescription('View your ammo stocks'))
                .addSubcommand(sub =>
                    sub.setName('consumables')
                        .setDescription('View your consumables and active buffs'))
                .addSubcommand(sub =>
                    sub.setName('materials')
                        .setDescription('View your crafting materials'))
                .addSubcommand(sub =>
                    sub.setName('discard')
                        .setDescription('Discard a broken or condemned weapon')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Weapon number to discard')
                                .setRequired(true)
                                .setMinValue(1))))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily hunt quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('See your active daily hunt quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addStringOption(o =>
                            o.setName('quest')
                                .setDescription('Quest to claim')
                                .setRequired(true)
                                .addChoices(...HUNT_QUEST_TEMPLATES.map(t => ({ name: t.name, value: t.id }))))))
        .addSubcommandGroup(group =>
            group.setName('shop')
                .setDescription('Browse and purchase all hunting gear, ammo, and supplies')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse everything available in the hunting shop'))
                .addSubcommand(sub =>
                    sub.setName('weapon')
                        .setDescription('Buy a new hunting weapon')
                        .addStringOption(o =>
                            o.setName('type')
                                .setDescription('Which weapon to buy')
                                .setRequired(true)
                                .addChoices(...WEAPON_CHOICES))
                        .addBooleanOption(o =>
                            o.setName('equip')
                                .setDescription('Auto-equip after purchase (default: true)')
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('upgrade')
                        .setDescription('Install a module upgrade on your equipped weapon (one per weapon, permanent)')
                        .addStringOption(o =>
                            o.setName('module')
                                .setDescription('Upgrade module to install')
                                .setRequired(true)
                                .addChoices(...UPGRADE_CHOICES)))
                .addSubcommand(sub =>
                    sub.setName('buy')
                        .setDescription('Purchase ammo packs or consumables')
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
                                .setDescription('Consumable to activate')
                                .setRequired(true)
                                .addChoices(...ACTIVATABLE.map(id => ({ name: CONSUMABLES[id].name, value: id })))))
                .addSubcommand(sub =>
                    sub.setName('repair')
                        .setDescription('Repair your equipped weapon at the shop or use a repair kit')
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
                                    { name: 'Small (+20 durability)', value: 'repair_kit_small' },
                                    { name: 'Large (+50 durability)', value: 'repair_kit_large' }
                                ))
                        .addIntegerOption(o =>
                            o.setName('amount')
                                .setDescription('Durability to restore at shop (default: full repair)')
                                .setRequired(false)
                                .setMinValue(20)))
                .addSubcommand(sub =>
                    sub.setName('unlock')
                        .setDescription('Unlock a new hunting zone')
                        .addStringOption(o =>
                            o.setName('zone')
                                .setDescription('Zone to unlock')
                                .setRequired(true)
                                .addChoices(...UNLOCK_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('zone')
                .setDescription('View and switch your active hunting zone')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View all zones and their unlock status'))
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Switch your active hunting zone')
                        .addStringOption(o =>
                            o.setName('zone')
                                .setDescription('Zone to switch to')
                                .setRequired(true)
                                .addChoices(...ZONE_SET_CHOICES)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'start')    return executeStart(interaction);
            if (sub === 'profile')  return executeProfile(interaction);
            if (sub === 'prestige') return executePrestige(interaction);
            if (sub === 'records')  return executeRecords(interaction);
        }
        if (group === 'inv')    return executeInv(interaction, sub);
        if (group === 'quests') return executeQuests(interaction, sub);
        if (group === 'shop')   return executeShop(interaction, sub);
        if (group === 'zone')   return executeZone(interaction, sub);
    }
};

// Test hooks. The command loader only looks for `data` and `execute`
// (utils/commandLoader), so extra exports are inert at runtime. They are pulled
// back together here, from the modules that now own each one, so the suites that
// reach for them do not have to know which file a helper ended up in.
module.exports.__test__ = {
    ...require('./aim'),
    buildHuntEmbed, buildBonusLines, buildAmmoField, buildLowAmmoField, AMMO_LOW_THRESHOLD,
    buildDailyTollField,
    buildTrophyField, buildFieldTrophyField, buildTodayField,
    buildWeaponPages, WEAPON_SEPARATOR,
    isCrossEconomyWeapon, huntingDaysFor, huntingDaysLabel, fullRepairCost, CROSS_ECONOMY_DAYS,
};

// ── Per-user economy lock ─────────────────────────────────────────────────────
// Hunting mutates the user document with read-modify-write saves, so concurrent
// /hunt invocations from the same user can race stamina, daily caps, and drops.
// The lock key is the player rather than this command, so a hand of blackjack
// races the same document and contends for it too — see utils/economyLock.js.
const { withEconomyLock, exceptReadOnly } = require('../../../utils/economyLock');
// Reads that persist nothing, so they never wait on a lease — see
// exceptReadOnly. Everything else, including /hunt inv equip and discard,
// still locks.
const HUNT_READ_ONLY = [
    'profile', 'records',
    'inv weapons', 'inv ammo', 'inv consumables', 'inv materials',
    'shop list',
    'zone list',
];
module.exports.execute = withEconomyLock(module.exports.execute, {
    activity: 'hunt',
    only:     exceptReadOnly(HUNT_READ_ONLY),
});

