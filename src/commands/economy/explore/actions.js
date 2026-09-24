'use strict';

// The buttons on a finished /explore go result: set out again, by one of the
// three routes (data/exploreData.js ROUTES). The route you took last is the
// highlighted one, so "same again" is still one obvious click, and the other
// two make every trip start with a choice — a safer trail to protect a streak,
// or the deep wilds to cash one in.
//
// An expedition used to end on a wall of text with nothing to press, so every
// trip after the first began with the player retyping the slash command —
// /fish and /hunt had grown "again" buttons, /explore had not. Each route
// button is /explore go itself, run through the same dispatch as the slash command:
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

const { ROUTE_LIST } = require('../../../data/exploreData');

const ROUTE_PREFIX = 'explore_act_route_';
const IDS = Object.fromEntries(ROUTE_LIST.map(r => [r.id, `${ROUTE_PREFIX}${r.id}`]));

// Long enough to outlast the 60-second cooldown several times over, so "Set
// out again" is still there when the explorer is; short enough that the
// session's final edit — taking the button off — lands well inside the token's
// life.
const ACTION_IDLE_MS = 5 * 60_000;

/** One button per route; `currentRoute` — the one just taken — is highlighted. */
function buildResultActions(currentRoute = null) {
    return [new ActionRowBuilder().addComponents(
        ...ROUTE_LIST.map(r => new ButtonBuilder()
            .setCustomId(IDS[r.id])
            .setLabel(`${r.emoji} ${r.name}`)
            .setStyle(r.id === currentRoute ? ButtonStyle.Primary : ButtonStyle.Secondary)),
    )];
}

/** The route a result button stands for, or null for anything else. */
function routeFromCustomId(customId) {
    if (!customId?.startsWith(ROUTE_PREFIX)) return null;
    const id = customId.slice(ROUTE_PREFIX.length);
    return ROUTE_LIST.some(r => r.id === id) ? id : null;
}

/**
 * A component interaction dressed as `/explore go`, so the command's own
 * handler — which reads `interaction.options` — runs unchanged. Everything else
 * (reply, editReply, user, guild, id…) is the button's own.
 */
function asExploreGo(button, { region = null, route = null } = {}) {
    const strings = { region, route };
    const options = {
        getSubcommandGroup: () => null,
        getSubcommand:      () => 'go',
        getString:          name => strings[name] ?? null,
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
 * Arms the buttons on a finished result. `message` is the reply carrying them;
 * `regionId` is where this expedition went, so the next one walks the same
 * ground by whichever route was pressed.
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

            const route = routeFromCustomId(button.customId);
            const outcome = await command.execute(asExploreGo(button, { region: regionId, route }), button.client);
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
    routeFromCustomId,
};
