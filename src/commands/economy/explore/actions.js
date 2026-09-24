'use strict';

// The button on a finished /explore go result: set out again.
//
// An expedition used to end on a wall of text with nothing to press, so every
// trip after the first began with the player retyping the slash command —
// /fish and /hunt had grown "again" buttons, /explore had not. "Set out again"
// is /explore go itself, run through the same dispatch as the slash command:
// same handler, same economy lock, and the same server policy and
// economy-freeze gates the command dispatcher applies, which a button press
// would otherwise walk past. This is fish/actions.js's "Cast again" for
// exploring.
//
// The session runs after execute() returns, so it holds no lock while it waits:
// a press takes the lock for itself, exactly as a fresh command would. A press
// before the cooldown is up gets the same "catching your breath" countdown a
// typed command does.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { createReplaySession } = require('../../../utils/replaySession');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { getPolicyDecision, claimCommandCooldown } = require('../../../utils/commandPolicy');
const {
    commandIsFreezeGated, isEconomyFrozen, FROZEN_NOTICE, FREEZE_UNKNOWN_NOTICE,
} = require('../../../utils/economyFreeze');

const IDS = {
    again: 'explore_act_again',
};

// Long enough to outlast the 60-second cooldown several times over, so "Set
// out again" is still there when the explorer is; short enough that the
// session's final edit — taking the button off — lands well inside the token's
// life.
const ACTION_IDLE_MS = 5 * 60_000;

function buildResultActions() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.again).setLabel('🥾 Set out again').setStyle(ButtonStyle.Primary),
    )];
}

/**
 * A component interaction dressed as `/explore go`, so the command's own
 * handler — which reads `interaction.options` — runs unchanged. Everything else
 * (reply, editReply, user, guild, id…) is the button's own.
 */
function asExploreGo(button, { region = null } = {}) {
    const options = {
        getSubcommandGroup: () => null,
        getSubcommand:      () => 'go',
        getString:          name => (name === 'region' ? region : null),
        getInteger:         () => null,
        getBoolean:         () => null,
        getUser:            () => null,
    };
    return new Proxy(button, {
        get(target, prop) {
            if (prop === 'options') return options;
            if (prop === 'commandName') return 'explore';
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/**
 * The gates the command dispatcher applies before any /explore runs
 * (events/interactionCreate.js), in its order: server command policy, the
 * economy freeze, then the command's cooldown — the same bucket a typed
 * /explore spends, so a button is never a way round a cooldown an admin set.
 * Returns a refusal to send, or null to go ahead.
 */
async function gateRefusal(button, command) {
    let guildSettings;
    try {
        guildSettings = await getGuildSettings(button.guild.id);
    } catch {
        return 'Could not load server settings. Try again in a moment.';
    }
    const policy = getPolicyDecision(button, guildSettings, 'explore');
    if (!policy.allowed) return policy.reason;

    if (commandIsFreezeGated(command)) {
        try {
            if (await isEconomyFrozen({ userId: button.user.id, guildId: button.guild.id })) return FROZEN_NOTICE;
        } catch {
            return FREEZE_UNKNOWN_NOTICE;
        }
    }
    return claimCommandCooldown(button.client, command, asExploreGo(button), guildSettings);
}

/**
 * Arms the button on a finished result. `message` is the reply carrying it;
 * `regionId` is where this expedition went, so "Set out again" walks the same
 * ground.
 */
function attachResultActions(interaction, message, { regionId = null } = {}) {
    if (!message) return null;

    return createReplaySession({
        interaction,
        message,
        customIds: Object.values(IDS),
        label: 'explore',
        claim: `That expedition belongs to ${interaction.user} — run \`/explore go\` for your own.`,
        idle: ACTION_IDLE_MS,
        onCollect: async (button, s) => {
            const command = button.client.commands?.get('explore');
            if (!command) {
                return button.reply({ content: 'Exploring is unavailable right now.', flags: MessageFlags.Ephemeral });
            }
            const refusal = await gateRefusal(button, command);
            if (refusal) return button.reply({ content: refusal, flags: MessageFlags.Ephemeral }).catch(() => {});

            const outcome = await command.execute(asExploreGo(button, { region: regionId }), button.client);
            // The new expedition carries its own button; this one would only
            // race it. Taken off here rather than by the session's end handler,
            // which leaves components alone while a press is still in flight.
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
    asExploreGo,
    attachResultActions,
    buildResultActions,
    gateRefusal,
};
