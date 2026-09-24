'use strict';

// The buttons on a /fish cast result: cast again, and — for a landed fish —
// keep it or let it go.
//
// A cast used to end on a wall of status with nothing to press, so the loop
// closed with the player retyping a slash command. "Cast again" is /fish cast
// itself, run through the same dispatch as the slash command: same handler,
// same economy lock, and the same server policy and economy-freeze gates the
// command dispatcher applies, which a button press would otherwise walk past.
// This is the /hunt start result's action row (hunt/actions.js) for fishing.
//
// Keep / release is the one decision a catch asks for. The fish was sold when
// it landed; releasing it hands those coins back for the catch's XP again and a
// charge of river karma — a better shot at a rare fish next cast (see
// fishService.releaseCatch and friends). Keep closes the offer.
//
// The session runs after execute() returns, so it holds no lock while it waits:
// each press takes the lock for itself, exactly as a fresh command would.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { createReplaySession } = require('../../../utils/replaySession');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { getPolicyDecision, claimCommandCooldown } = require('../../../utils/commandPolicy');
const {
    commandIsFreezeGated, isEconomyFrozen, FROZEN_NOTICE, FREEZE_UNKNOWN_NOTICE,
} = require('../../../utils/economyFreeze');
const { attachGrind } = require('../../../utils/grindProfile');
const { withEconomyLock } = require('../../../utils/economyLock');
const { chargeExact, refundCharge } = require('../../../utils/balanceDebit');
const { ensureFishingData, releasePlan, applyRelease, declineRelease, getLevelData } = require('../../../services/fishService');

const IDS = {
    again:   'fish_act_again',
    keep:    'fish_act_keep',
    release: 'fish_act_release',
};

// Long enough to outlast the 45-second cooldown several times over, so "Cast
// again" is still there when the angler is; short enough that the session's
// final edit — taking the buttons off — lands well inside the token's life.
const ACTION_IDLE_MS = 5 * 60_000;

// Button labels are plain text — a custom currency emoji would print as its raw
// `<:name:id>` markup — so amounts on buttons are always in coins.
const coins = n => `${Number(n).toLocaleString()} coins`;

/**
 * The action row for a result. `release` is the cast's pending release (from
 * fishService.recordPendingRelease), or null when there is nothing to decide.
 */
function buildResultActions(release) {
    const buttons = [
        new ButtonBuilder().setCustomId(IDS.again).setLabel('🎣 Cast again').setStyle(ButtonStyle.Primary),
    ];
    if (release) {
        buttons.push(
            new ButtonBuilder().setCustomId(IDS.keep).setLabel(`💰 Keep (${coins(release.payout)})`).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(IDS.release).setLabel(`🌊 Release (+${release.xp} XP, +1 karma)`).setStyle(ButtonStyle.Success),
        );
    }
    return [new ActionRowBuilder().addComponents(...buttons)];
}

/**
 * A component interaction dressed as the /fish subcommand it stands for, so the
 * command's own handlers — which read `interaction.options` — run unchanged.
 * Everything else (reply, editReply, user, guild, id…) is the button's own.
 */
function asFishSubcommand(button, { group = null, sub, strings = {}, integers = {}, booleans = {} }) {
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
            if (prop === 'commandName') return 'fish';
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/**
 * The gates the command dispatcher applies before any /fish runs
 * (events/interactionCreate.js), in its order: server command policy, the
 * economy freeze, then the command's cooldown — the same bucket a typed /fish
 * spends, with the guild's per-role overrides, so a button is never a way round
 * a cooldown an admin set. `claimCooldown: false` is for a press that runs no
 * command (keep / release). Returns a refusal to send, or null to go ahead.
 */
async function gateRefusal(button, command, { claimCooldown = true } = {}) {
    let guildSettings;
    try {
        guildSettings = await getGuildSettings(button.guild.id);
    } catch {
        return 'Could not load server settings. Try again in a moment.';
    }
    const policy = getPolicyDecision(button, guildSettings, 'fish');
    if (!policy.allowed) return policy.reason;

    if (commandIsFreezeGated(command)) {
        try {
            if (await isEconomyFrozen({ userId: button.user.id, guildId: button.guild.id })) return FROZEN_NOTICE;
        } catch {
            return FREEZE_UNKNOWN_NOTICE;
        }
    }
    if (claimCooldown) {
        return claimCommandCooldown(button.client, command, asFishSubcommand(button, { sub: 'cast' }), guildSettings);
    }
    return null;
}

async function loadAngler(userId, guildId) {
    const user = await User.findOne({ userId, guildId });
    if (!user) return null;
    await attachGrind(user);
    ensureFishingData(user);
    return user;
}

/**
 * The result text embed with a line saying what the angler chose. The picture
 * card leads the message and the text embed follows it; whichever embed is
 * last before any boss result is the text — the one that carries a Balance.
 */
function withDecision(message, line) {
    const embeds = (message?.embeds ?? []).map(e => EmbedBuilder.from(e));
    const at = embeds.findIndex(e => (e.data.fields ?? []).some(f => f.name === 'Balance'));
    if (at < 0) return null;
    embeds[at].addFields({ name: '🎣 Your Call', value: line, inline: false });
    return embeds;
}

/**
 * Let the fish go. Holds the economy lock, as any /fish write does. The coins
 * come back through an all-or-nothing charge, so an angler who has spent them
 * since is told so and nothing moves.
 */
const releaseFish = withEconomyLock(async function releaseFish(button, interaction) {
    await button.deferUpdate().catch(() => {});
    const user = await loadAngler(button.user.id, button.guild.id);
    const plan = user && releasePlan(user, interaction.id);
    if (!plan) {
        await button.followUp({ content: 'That fish is no longer yours to release.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return { done: true };
    }

    const filter = { userId: user.userId, guildId: user.guildId };
    const charged = await chargeExact(User, filter, plan.payout);
    if (!charged) {
        await button.followUp({
            content: `You no longer have the ${coins(plan.payout)} this ${plan.fishName} sold for, so it stays kept.`,
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return { done: false };
    }

    const out = applyRelease(user, plan);
    user.balance = charged.balance;
    user.unmarkModified('balance');
    try {
        await user.save();
    } catch (err) {
        console.error('[fish] release save error:', err);
        await refundCharge(User, filter, plan.payout, 'fish release');
        await button.followUp({ content: 'Something went wrong releasing that fish — nothing was changed.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return { done: false };
    }

    const level = out.levelUp ? ` · ⬆️ Fisher Level ${out.levelUp.newLevel} (${getLevelData(out.levelUp.newLevel).title})` : '';
    const embeds = withDecision(button.message,
        `🌊 Released the **${plan.fishName}** — ${coins(plan.payout)} handed back for **+${out.xp} XP** and river karma ` +
        `(**${out.karma}** charge${out.karma === 1 ? '' : 's'}: better odds on your next fish).${level}`);
    await interaction.editReply({ ...(embeds ? { embeds } : {}), components: buildResultActions(null) }).catch(() => {});
    return { done: true };
}, { activity: 'fish' });

/** Keep the fish: the coins stay, and the offer comes off the message. */
const keepFish = withEconomyLock(async function keepFish(button, interaction) {
    await button.deferUpdate().catch(() => {});
    const user = await loadAngler(button.user.id, button.guild.id);
    if (user && declineRelease(user, interaction.id)) await user.save().catch(() => {});
    const embeds = withDecision(button.message, '💰 Kept — the coins are yours.');
    await interaction.editReply({ ...(embeds ? { embeds } : {}), components: buildResultActions(null) }).catch(() => {});
    return { done: true };
}, { activity: 'fish' });

/**
 * Arms the buttons on a finished result. `interaction` is the one that
 * rendered it — its id is the cast's release key — and `locationId` is where
 * the cast was made, so "Cast again" fishes the same water.
 */
async function attachResultActions(interaction, { locationId = null } = {}) {
    const message = await interaction.fetchReply().catch(() => null);
    if (!message) return null;

    return createReplaySession({
        interaction,
        message,
        customIds: Object.values(IDS),
        label: 'fish',
        claim: `That catch belongs to ${interaction.user} — run \`/fish cast\` for your own.`,
        idle: ACTION_IDLE_MS,
        onCollect: async (button, s) => {
            const command = button.client.commands?.get('fish');
            if (!command) {
                return button.reply({ content: 'Fishing is unavailable right now.', flags: MessageFlags.Ephemeral });
            }
            const refusal = await gateRefusal(button, command, { claimCooldown: button.customId === IDS.again });
            if (refusal) return button.reply({ content: refusal, flags: MessageFlags.Ephemeral }).catch(() => {});

            if (button.customId === IDS.again) {
                const outcome = await command.execute(
                    asFishSubcommand(button, { sub: 'cast', strings: locationId ? { location: locationId } : {} }),
                    button.client,
                );
                // The new cast carries its own buttons; these would only race it.
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

            if (button.customId === IDS.release) await releaseFish(button, interaction);
            else if (button.customId === IDS.keep) await keepFish(button, interaction);
            s.extend();
        },
    });
}

module.exports = {
    ACTION_IDLE_MS,
    IDS: Object.freeze({ ...IDS }),
    asFishSubcommand,
    attachResultActions,
    buildResultActions,
    gateRefusal,
};
