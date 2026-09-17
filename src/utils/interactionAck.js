'use strict';

/**
 * Early acknowledgement for slash commands whose work can exceed Discord's
 * three-second response deadline (#995).
 *
 * The dispatcher in `events/interactionCreate.js` awaits `getGuildSettings`, the
 * freeze read and the cooldown claim, and only then calls `command.execute` —
 * where the moderation commands await `resolveMember`, which fetches from the
 * gateway on a member-cache miss. The member cache holds 200 per guild and is
 * swept hourly, so a miss is normal, and the combined latency can invalidate the
 * interaction token before its first response ever lands.
 *
 * `deferReply` fixes the deadline but commits the initial response's visibility:
 *
 *   - A *public* deferral makes an ephemeral refusal impossible on the same
 *     message, because a public "thinking" placeholder cannot be turned
 *     ephemeral.
 *   - An *ephemeral* deferral makes a public success embed impossible on the
 *     same message.
 *
 * The moderation commands want the reverse of neither: a public success embed in
 * the channel and an ephemeral refusal only the moderator sees. So the policy is
 * a **public deferral**, and `sendEphemeralResponse` below drops the public
 * placeholder and delivers the refusal as an ephemeral follow-up. The one cost
 * is a transient public "thinking" on a refused action, which is deleted the
 * instant the refusal is known — the accepted trade for keeping the common
 * success path a single clean `editReply`.
 *
 * A command opts in by exporting a `deferral` hook (see docs/EXTENDING.md). The
 * dispatcher reads it, defers with the chosen visibility, and records that
 * visibility on the interaction so the two helpers below know whether the
 * placeholder is public (drop it before an ephemeral reply) or already
 * ephemeral (edit it in place).
 */

const { MessageFlags } = require('discord.js');

// Where the dispatcher records how it pre-acknowledged an interaction. A Symbol
// so it never collides with a discord.js field and never shows up in
// `Object.keys`, which the command-contract typo check walks.
const DEFER_VISIBILITY = Symbol('clawdia.deferVisibility');

/** Record that the dispatcher deferred this interaction, and how. */
function markDeferred(interaction, ephemeral) {
    interaction[DEFER_VISIBILITY] = ephemeral ? 'ephemeral' : 'public';
}

/** `'public'`, `'ephemeral'`, or `null` when the dispatcher did not defer. */
function deferVisibility(interaction) {
    return interaction?.[DEFER_VISIBILITY] ?? null;
}

/**
 * Turn a command's `deferral` hook into the dispatcher's decision.
 *
 * The hook may be:
 *   - a function `(interaction) => spec` evaluated per interaction (so a command
 *     can defer only some of its subcommands),
 *   - `true` or `'public'` — defer with a channel-visible placeholder,
 *   - `'ephemeral'` — defer with a placeholder only the caller sees,
 *   - `{ ephemeral: boolean }` — the same, explicitly,
 *   - anything falsy — do not defer.
 *
 * @returns {{ ephemeral: boolean } | null}
 */
function resolveDeferral(spec, interaction) {
    const resolved = typeof spec === 'function' ? spec(interaction) : spec;
    if (!resolved) return null;

    // Computed rather than written as an `{ ephemeral: true }` literal, which the
    // repo's lint rule reserves for the deprecated discord.js reply option.
    let ephemeral;
    if (resolved === true || resolved === 'public') ephemeral = false;
    else if (resolved === 'ephemeral') ephemeral = true;
    else if (typeof resolved === 'object') ephemeral = resolved.ephemeral === true;
    else return null;

    return { ephemeral };
}

/**
 * Delete a public deferred placeholder so an ephemeral reply can stand alone.
 *
 * Best-effort: the token may already have expired, and the original outcome is
 * what matters — a failure to tidy the placeholder must not throw over it.
 */
async function dropDeferredPlaceholder(interaction) {
    if (typeof interaction.deleteReply !== 'function') return;
    await interaction.deleteReply().catch(() => {});
}

/**
 * Send a channel-visible response, whether or not the dispatcher pre-deferred.
 *
 *   - deferred publicly            → `editReply` (fills the placeholder)
 *   - deferred ephemerally         → drop the placeholder, public `followUp`
 *   - already replied              → public `followUp`
 *   - not acknowledged at all      → plain public `reply`
 */
async function sendPublicResponse(interaction, payload) {
    if (interaction.deferred && !interaction.replied) {
        if (deferVisibility(interaction) === 'ephemeral') {
            await dropDeferredPlaceholder(interaction);
            return interaction.followUp(payload);
        }
        return interaction.editReply(payload);
    }
    if (interaction.replied || interaction.deferred) {
        return interaction.followUp(payload);
    }
    return interaction.reply(payload);
}

/**
 * Send a caller-only (ephemeral) response, whether or not the dispatcher
 * pre-deferred.
 *
 *   - deferred ephemerally         → `editReply` (visibility is already fixed)
 *   - deferred publicly            → drop the public placeholder, ephemeral `followUp`
 *   - already replied              → ephemeral `followUp`
 *   - not acknowledged at all      → plain ephemeral `reply`
 *
 * Never a second initial `reply`, which is what Discord rejects once an
 * interaction has been acknowledged.
 */
async function sendEphemeralResponse(interaction, payload) {
    const ephemeralPayload = { ...payload, flags: MessageFlags.Ephemeral };
    if (interaction.deferred && !interaction.replied) {
        if (deferVisibility(interaction) === 'ephemeral') {
            // editReply keeps the ephemeral visibility the defer committed to;
            // the flag would be ignored here, so it is left off.
            return interaction.editReply(payload);
        }
        await dropDeferredPlaceholder(interaction);
        return interaction.followUp(ephemeralPayload);
    }
    if (interaction.replied || interaction.deferred) {
        return interaction.followUp(ephemeralPayload);
    }
    return interaction.reply(ephemeralPayload);
}

module.exports = {
    resolveDeferral,
    markDeferred,
    deferVisibility,
    sendPublicResponse,
    sendEphemeralResponse,
};
