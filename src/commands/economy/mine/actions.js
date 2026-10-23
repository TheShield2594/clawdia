'use strict';

// The button on a /mine dig result: dig again.
//
// A dig used to end on a wall of status with nothing to press, so every one of
// the ~120 digs a day started with the player retyping the slash command. "Dig
// again" is /mine dig itself, run through the same dispatch as the slash
// command: same handler, same economy lock, and the same server policy,
// economy-freeze and command-cooldown gates the dispatcher applies, which a
// button press would otherwise walk past. This is /fish's "Cast again"
// (fish/actions.js) for the mine.
//
// It digs the same depth and opens the rock survey again rather than repeating
// the last intensity: the survey is different every dig, and the intensity
// choice is only a decision if it is made against it.
//
// The session runs after execute() returns, so it holds no lock while it waits:
// a press takes the lock for itself, exactly as a fresh command would.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { createReplaySession } = require('../../../utils/replaySession');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { getPolicyDecision, claimCommandCooldown } = require('../../../utils/commandPolicy');
const {
    commandIsFreezeGated, isEconomyFrozen, FROZEN_NOTICE, FREEZE_UNKNOWN_NOTICE,
} = require('../../../utils/economyFreeze');

const IDS = {
    again: 'mine_act_again',
};

// Long enough to outlast the 30-second cooldown several times over, so "Dig
// again" is still there when the miner is; short enough that the session's
// final edit — taking the button off — lands well inside the token's life.
const ACTION_IDLE_MS = 5 * 60_000;

function buildResultActions() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.again).setLabel('⛏️ Dig again').setStyle(ButtonStyle.Primary),
    )];
}

/**
 * A component interaction dressed as the /mine subcommand it stands for, so the
 * command's own handlers — which read `interaction.options` — run unchanged.
 * Everything else (reply, editReply, user, guild, id…) is the button's own.
 */
function asMineSubcommand(button, { group = null, sub, strings = {}, integers = {} }) {
    const options = {
        getSubcommandGroup: () => group,
        getSubcommand:      () => sub,
        getString:          name => strings[name] ?? null,
        getInteger:         name => integers[name] ?? null,
        getBoolean:         () => null,
        getUser:            () => null,
    };
    return new Proxy(button, {
        get(target, prop) {
            if (prop === 'options') return options;
            if (prop === 'commandName') return 'mine';
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/**
 * The gates the command dispatcher applies before any /mine runs
 * (events/interactionCreate.js), in its order: server command policy, the
 * economy freeze, then the command's cooldown — the same bucket a typed /mine
 * spends, with the guild's per-role overrides. Returns a refusal to send, or
 * null to go ahead.
 */
async function gateRefusal(button, command) {
    let guildSettings;
    try {
        guildSettings = await getGuildSettings(button.guild.id);
    } catch {
        return 'Could not load server settings. Try again in a moment.';
    }
    const policy = getPolicyDecision(button, guildSettings, 'mine');
    if (!policy.allowed) return policy.reason;

    if (commandIsFreezeGated(command)) {
        try {
            if (await isEconomyFrozen({ userId: button.user.id, guildId: button.guild.id })) return FROZEN_NOTICE;
        } catch {
            return FREEZE_UNKNOWN_NOTICE;
        }
    }
    return claimCommandCooldown(button.client, command, asMineSubcommand(button, { sub: 'dig' }), guildSettings);
}

/**
 * Arms "Dig again" on a finished result. `depthId` is where the dig was made,
 * so the next one digs the same depth.
 */
async function attachResultActions(interaction, { depthId = null } = {}) {
    const message = await interaction.fetchReply().catch(() => null);
    if (!message) return null;

    return createReplaySession({
        interaction,
        message,
        customIds: Object.values(IDS),
        label: 'mine',
        claim: `That dig belongs to ${interaction.user} — run \`/mine dig\` for your own.`,
        idle: ACTION_IDLE_MS,
        onCollect: async (button, s) => {
            const command = button.client.commands?.get('mine');
            if (!command) {
                return button.reply({ content: 'Mining is unavailable right now.', flags: MessageFlags.Ephemeral });
            }
            const refusal = await gateRefusal(button, command);
            if (refusal) return button.reply({ content: refusal, flags: MessageFlags.Ephemeral }).catch(() => {});

            const outcome = await command.execute(
                asMineSubcommand(button, { sub: 'dig', strings: depthId ? { depth: depthId } : {} }),
                button.client,
            );
            // The new dig carries its own button; this one would only race it.
            // Taken off here rather than by the session's end handler, which
            // leaves components alone while a press is still in flight.
            if (outcome?.started) {
                s.collector.stop('replayed');
                await interaction.editReply({ components: [] }).catch(() => {});
            } else {
                s.extend();
            }
        },
    });
}

module.exports = {
    ACTION_IDLE_MS,
    IDS: Object.freeze({ ...IDS }),
    asMineSubcommand,
    attachResultActions,
    buildResultActions,
    gateRefusal,
};
