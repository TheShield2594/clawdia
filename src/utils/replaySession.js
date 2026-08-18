'use strict';

const { ComponentType, MessageFlags } = require('discord.js');

// Discord expires an interaction token 15 minutes after the command was
// invoked, and every follow-up in these sessions is an editReply against that
// token. Sessions idle out after a minute without a click, and carry a hard cap
// under the token's life so the last edit — the one taking the buttons off —
// still lands instead of rejecting into nothing.
const IDLE_MS = 60_000;
const MAX_MS  = 13 * 60_000;

/**
 * Buttons on a command's own reply that the invoker can click over and over —
 * "flip again", "roll again", "shake again".
 *
 * One collector serves the whole session. Arming a fresh max:1 collector per
 * click leaves the replacement buttons on screen for a beat with nothing
 * listening behind them, and a click landing in that gap dies as "This
 * interaction failed".
 *
 * Everything here runs after execute() has already returned, so the command
 * dispatcher's try/catch is long out of scope: an error escaping onCollect
 * would surface as a process-level unhandled rejection rather than a log line.
 * Hence the wrapper.
 *
 * @param {object} opts
 * @param {import('discord.js').ChatInputCommandInteraction} opts.interaction
 * @param {import('discord.js').Message} opts.message - the reply carrying the buttons
 * @param {string[]} opts.customIds                   - the buttons this session owns
 * @param {string}   opts.label                       - log prefix, e.g. 'coinflip'
 * @param {string}   [opts.claim]                     - ephemeral text for other members
 * @param {(button: import('discord.js').ButtonInteraction, session: object) => Promise<void>} opts.onCollect
 * @returns {object} the session handle
 */
function createReplaySession({
    interaction,
    message,
    customIds,
    label,
    claim,
    onCollect,
    idle = IDLE_MS,
    maxDuration = MAX_MS,
}) {
    const owned    = new Set(customIds);
    const deadline = Date.now() + maxDuration;
    let busy       = false;

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i => owned.has(i.customId),
        idle,
        time: maxDuration,
    });

    const session = {
        collector,

        get ended() { return collector.ended; },

        // Claim the session for a render. Returns false if one is already in
        // flight, which is what keeps a double-click from starting two.
        hold() {
            if (busy) return false;
            busy = true;
            return true;
        },

        // Drop the claim ahead of a wait that shouldn't freeze the buttons — a
        // modal, say, which the member has to dismiss before they can click.
        release() { busy = false; },

        // Restart the idle timer after work the collector never saw, without
        // pushing the session past the deadline it was given.
        extend() {
            if (collector.ended) return;
            collector.resetTimer({ idle, time: Math.max(1_000, deadline - Date.now()) });
        },
    };

    collector.on('collect', async button => {
        try {
            if (button.user.id !== interaction.user.id) {
                // Turning these away in the collector filter instead would show
                // every other member a bare "This interaction failed".
                return await button.reply({
                    content: claim ?? `That one belongs to ${interaction.user} — run the command yourself to play.`,
                    flags:   MessageFlags.Ephemeral,
                });
            }

            if (!session.hold()) return await button.deferUpdate().catch(() => {});

            await onCollect(button, session);
        } catch (error) {
            console.error(`[${label}] component handler error:`, error);
        } finally {
            session.release();
        }
    });

    collector.on('end', () => {
        // A render still in flight settles the components itself; see how the
        // callers consult session.ended when choosing what to attach.
        if (busy) return;
        interaction.editReply({ components: [] }).catch(() => {});
    });

    return session;
}

module.exports = { createReplaySession, IDLE_MS, MAX_MS };
