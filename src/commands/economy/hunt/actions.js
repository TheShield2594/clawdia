'use strict';

// The buttons on a /hunt start result: go again, fix what the hunt just broke,
// restock what it just spent, and the quick-hunt switch.
//
// A hunt used to end on a wall of status with nothing to press, so the loop
// closed with the player retyping a slash command — and quick mode, the
// preference most worth flipping mid-session, lived in a slash option nobody
// sees. Each button here is an existing /hunt subcommand, run through the same
// dispatch as the slash command: same handler, same economy lock, and the same
// server policy and economy-freeze gates the command dispatcher applies, which
// a button press would otherwise walk straight past.
//
// The session runs after execute() returns, so it holds no lock while it waits:
// each press takes the lock for itself, exactly as a fresh command would.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { createReplaySession } = require('../../../utils/replaySession');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { getPolicyDecision } = require('../../../utils/commandPolicy');
const {
    commandIsFreezeGated, isEconomyFrozen, FROZEN_NOTICE, FREEZE_UNKNOWN_NOTICE,
} = require('../../../utils/economyFreeze');
const { attachGrind } = require('../../../utils/grindProfile');
const { withEconomyLock } = require('../../../utils/economyLock');
const { ensureHuntData, quoteRepair, isCondemned } = require('../../../services/huntService');
const { AMMO_PACKS, CONSUMABLES, WEAPON_BY_TIER } = require('../../../data/huntData');
const { AMMO_LOW_THRESHOLD, ammoContext } = require('./embeds');

const IDS = {
    again:  'hunt_act_again',
    repair: 'hunt_act_repair',
    ammo:   'hunt_act_ammo',
    quick:  'hunt_act_quick',
};

// Long enough to outlast the 45-second cooldown several times over, so "Hunt
// again" is still there when the hunter is; short enough that the session's
// final edit — taking the buttons off — lands well inside the token's life.
const ACTION_IDLE_MS = 5 * 60_000;

// Largest first: a player holding both should spend the kit that does the job.
const REPAIR_KITS = ['repair_kit_large', 'repair_kit_small'];

// Button labels are plain text — a custom currency emoji would print as its raw
// `<:name:id>` markup — so prices on buttons are always in coins.
const coins = n => `${Number(n).toLocaleString()} coins`;

/** What the Repair button would do, or null when the weapon needs nothing (or cannot be fixed). */
function repairAction(user, weapon) {
    if (!weapon || isCondemned(weapon)) return null;
    const worn = weapon.status === 'broken' || weapon.currentDurability <= Math.floor(weapon.maxDurability * 0.20);
    if (!worn || weapon.currentDurability >= weapon.maxDurability) return null;

    const kitId = REPAIR_KITS.find(id => (user.hunt.consumables?.[id] ?? 0) > 0);
    if (kitId) {
        return { kitId, label: `🪛 Use ${CONSUMABLES[kitId]?.name ?? 'Repair Kit'}` };
    }
    if (!WEAPON_BY_TIER[weapon.tier]) return null;
    const quote = quoteRepair(weapon);
    if (quote.error) return null;
    return { kitId: null, label: `🔧 Repair (${coins(quote.cost)})` };
}

/** What the Buy Ammo button would buy, or null when the weapon takes none or the pouch is fine. */
function ammoAction(user, weapon) {
    const ammo = weapon ? ammoContext(user, weapon) : null;
    if (!ammo || ammo.remaining > AMMO_LOW_THRESHOLD) return null;
    const ammoType = WEAPON_BY_TIER[weapon.tier].ammoType;
    const pack = AMMO_PACKS.find(p => p.ammoType === ammoType);
    if (!pack) return null;
    return { itemId: pack.id, label: `${pack.emoji} Buy ${pack.name} (${coins(pack.cost)})` };
}

/**
 * The action row for a result card. `weapon` is the one the hunt used, read
 * after the hunt, so the Repair and Buy Ammo buttons appear only when this
 * hunt left something to fix or restock.
 */
function buildResultActions(user, weapon, quick) {
    const buttons = [
        new ButtonBuilder().setCustomId(IDS.again).setLabel('🏹 Hunt again').setStyle(ButtonStyle.Primary),
    ];
    const repair = repairAction(user, weapon);
    if (repair) buttons.push(new ButtonBuilder().setCustomId(IDS.repair).setLabel(repair.label).setStyle(ButtonStyle.Secondary));
    const ammo = ammoAction(user, weapon);
    if (ammo) buttons.push(new ButtonBuilder().setCustomId(IDS.ammo).setLabel(ammo.label).setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder()
        .setCustomId(IDS.quick)
        .setLabel(`⚡ Quick mode: ${quick ? 'On' : 'Off'}`)
        .setStyle(quick ? ButtonStyle.Success : ButtonStyle.Secondary));
    return [new ActionRowBuilder().addComponents(...buttons)];
}

/**
 * A component interaction dressed as the /hunt subcommand it stands for, so the
 * command's own handlers — which read `interaction.options` — run unchanged.
 * Everything else (reply, editReply, user, guild, id…) is the button's own.
 */
function asHuntSubcommand(button, { group = null, sub, strings = {}, integers = {}, booleans = {} }) {
    const options = {
        getSubcommandGroup: () => group,
        getSubcommand:      () => sub,
        getString:          name => strings[name] ?? null,
        getInteger:         name => integers[name] ?? null,
        getBoolean:         name => booleans[name] ?? null,
        getUser:            () => null,
    };
    return new Proxy(button, {
        get(target, prop) {
            if (prop === 'options') return options;
            if (prop === 'commandName') return 'hunt';
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/**
 * The gates the command dispatcher applies before any /hunt runs
 * (events/interactionCreate.js): server command policy, then the economy
 * freeze. Returns a refusal to send, or null to go ahead.
 */
async function gateRefusal(button, command) {
    let guildSettings;
    try {
        guildSettings = await getGuildSettings(button.guild.id);
    } catch {
        return 'Could not load server settings. Try again in a moment.';
    }
    const policy = getPolicyDecision(button, guildSettings, 'hunt');
    if (!policy.allowed) return policy.reason;

    if (commandIsFreezeGated(command)) {
        try {
            if (await isEconomyFrozen({ userId: button.user.id, guildId: button.guild.id })) return FROZEN_NOTICE;
        } catch {
            return FREEZE_UNKNOWN_NOTICE;
        }
    }
    return null;
}

async function loadHunter(userId, guildId) {
    const user = await User.findOne({ userId, guildId });
    if (!user) return null;
    await attachGrind(user);
    ensureHuntData(user);
    return user;
}

/** Re-draws the card's buttons from the hunter's current state. */
async function refreshActions(interaction, session, weaponIndex) {
    if (session.ended) return;
    const user = await loadHunter(interaction.user.id, interaction.guild.id);
    if (!user) return;
    const weapon = user.hunt.weapons[weaponIndex] ?? user.hunt.weapons[user.hunt.equippedWeaponIndex];
    await interaction.editReply({ components: buildResultActions(user, weapon, user.hunt.quickHunt ?? false) }).catch(() => {});
}

// Flipping the preference is a read-modify-write of the hunt profile, so it
// holds the same lock a hunt does.
const toggleQuick = withEconomyLock(async function toggleQuick(button, interaction, weaponIndex) {
    await button.deferUpdate().catch(() => {});
    const user = await loadHunter(button.user.id, button.guild.id);
    if (!user) return;
    user.hunt.quickHunt = !(user.hunt.quickHunt ?? false);
    user.markModified('hunt');
    await user.save();
    const weapon = user.hunt.weapons[weaponIndex] ?? user.hunt.weapons[user.hunt.equippedWeaponIndex];
    await interaction.editReply({ components: buildResultActions(user, weapon, user.hunt.quickHunt) }).catch(() => {});
}, { activity: 'hunt' });

/**
 * Arms the buttons on a finished result card. `interaction` is the one that
 * rendered it; `weaponIndex` pins the weapon the hunt used, so a re-equip in
 * the meantime does not point Repair at a different gun.
 */
async function attachResultActions(interaction, weaponIndex) {
    const message = await interaction.fetchReply().catch(() => null);
    if (!message) return null;

    const session = createReplaySession({
        interaction,
        message,
        customIds: Object.values(IDS),
        label: 'hunt',
        claim: `That hunt belongs to ${interaction.user} — run \`/hunt start\` for your own.`,
        idle: ACTION_IDLE_MS,
        onCollect: async (button, s) => {
            const command = button.client.commands?.get('hunt');
            if (!command) {
                return button.reply({ content: 'Hunting is unavailable right now.', flags: MessageFlags.Ephemeral });
            }
            const refusal = await gateRefusal(button, command);
            if (refusal) return button.reply({ content: refusal, flags: MessageFlags.Ephemeral }).catch(() => {});

            if (button.customId === IDS.quick) {
                await toggleQuick(button, interaction, weaponIndex);
                s.extend();
                return;
            }

            if (button.customId === IDS.again) {
                const outcome = await command.execute(asHuntSubcommand(button, { sub: 'start' }), button.client);
                // The new hunt carries its own buttons; these would only race it.
                // Taken off here rather than by the session's end handler, which
                // leaves components alone while a press is still in flight.
                if (outcome?.started) {
                    s.collector.stop('replayed');
                    await interaction.editReply({ components: [] }).catch(() => {});
                } else {
                    s.extend();
                }
                return;
            }

            const hunter = await loadHunter(button.user.id, button.guild.id);
            const weapon = hunter?.hunt.weapons[weaponIndex];
            if (button.customId === IDS.repair) {
                const plan = hunter && repairAction(hunter, weapon);
                if (!plan) return button.reply({ content: 'Your weapon has nothing left to repair here.', flags: MessageFlags.Ephemeral });
                if (hunter.hunt.equippedWeaponIndex !== weaponIndex) {
                    return button.reply({ content: 'You have equipped a different weapon since this hunt — use `/hunt shop repair` for it.', flags: MessageFlags.Ephemeral });
                }
                await command.execute(asHuntSubcommand(button, {
                    group: 'shop', sub: 'repair',
                    strings: plan.kitId ? { method: 'kit', kit: plan.kitId } : { method: 'shop' },
                }), button.client);
            } else if (button.customId === IDS.ammo) {
                const plan = hunter && ammoAction(hunter, weapon);
                if (!plan) return button.reply({ content: 'You are stocked up — nothing to buy.', flags: MessageFlags.Ephemeral });
                await command.execute(asHuntSubcommand(button, {
                    group: 'shop', sub: 'buy', strings: { item: plan.itemId }, integers: { quantity: 1 },
                }), button.client);
            }
            await refreshActions(interaction, s, weaponIndex);
            s.extend();
        },
    });
    return session;
}

module.exports = {
    ACTION_IDLE_MS,
    IDS: Object.freeze({ ...IDS }),
    ammoAction,
    asHuntSubcommand,
    attachResultActions,
    buildResultActions,
    gateRefusal,
    repairAction,
};
