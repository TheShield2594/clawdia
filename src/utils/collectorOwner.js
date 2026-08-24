'use strict';

const { MessageFlags } = require('discord.js');

/**
 * Collector filters that answer the wrong member instead of ignoring them
 * (#666).
 *
 * Forty-odd collectors filtered with `i => i.user.id === interaction.user.id`.
 * A filter returning false does not decline the interaction — it drops it, and
 * Discord's client, having waited three seconds for a response that was never
 * coming, shows the member a red "This interaction failed". Most of these
 * buttons sit on a public message, so the second person to reach for the
 * Replay button on someone else's slot spin was told the bot was broken.
 *
 * The check stays in the filter rather than moving into `on('collect')`, which
 * is the other way to write this. What the filter returns is also what decides
 * whether a collection counts, so a check moved into the handler would let a
 * passer-by's click spend a `max: 1` collector's one collection, or resolve an
 * `awaitMessageComponent` as though they had answered the prompt — the two
 * places a silent drop was doing something useful. Returning false here keeps
 * that, and the reply is what the drop was missing.
 *
 * Where a collector has no `max` and no await behind it, the equivalent check
 * at the top of `on('collect')` is just as correct; several confirmations are
 * written that way already and are left alone.
 */

const NOT_YOURS = "This isn't yours — run the command yourself for your own.";

/**
 * Tell a member the component they clicked belongs to someone else.
 *
 * Ephemeral, so it is answered without a public message every time somebody
 * reaches for a button in a busy channel. Failures are swallowed: a reply that
 * did not land (the interaction already expired, the bot lost the channel)
 * must not take the collector down with it.
 *
 * @returns {boolean} true when the click was not the owner's and has been
 *                    answered — collector filters return the negation of this.
 */
function rejectOtherUser(componentInteraction, owners, message = NOT_YOURS) {
    const allowed = Array.isArray(owners) ? owners : [owners];
    if (allowed.includes(componentInteraction.user.id)) return false;

    componentInteraction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
}

/**
 * Build a collector filter that accepts only `owners` and says so to everyone
 * else.
 *
 * @param {string|string[]} owners  user id, or ids, the components belong to
 * @param {(i: object) => boolean} [matches]  the customId test this replaces —
 *        run first, so a click on some unrelated component on the same message
 *        is still ignored in silence rather than answered with a refusal that
 *        makes no sense.
 * @param {string} [message]  what to tell everyone else
 */
function ownedBy(owners, matches = () => true, message = NOT_YOURS) {
    return componentInteraction => {
        if (!matches(componentInteraction)) return false;
        return !rejectOtherUser(componentInteraction, owners, message);
    };
}

/**
 * ownedBy for the collectors whose audience is not one user but a set that
 * changes while the collector runs — a crash lobby's players, say. `isMember`
 * is asked at click time rather than a list being captured up front.
 */
function ownedByMembers(isMember, matches = () => true, message = NOT_YOURS) {
    return componentInteraction => {
        if (!matches(componentInteraction)) return false;
        if (isMember(componentInteraction.user.id)) return true;
        componentInteraction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
        return false;
    };
}

module.exports = { NOT_YOURS, rejectOtherUser, ownedBy, ownedByMembers };
