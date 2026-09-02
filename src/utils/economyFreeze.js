'use strict';

/**
 * The freeze the dashboard sets, enforced (#870).
 *
 * `economyFrozen` existed on the User schema and was written by
 * `POST /api/v1/guild/:guildId/economy/adjust` with `action: freeze`. Nothing
 * read it. The endpoint answered `success: true`, the audit log recorded the
 * sanction, docs/API_REFERENCE.md said the member's balance was frozen, and the
 * member kept earning, gambling, gifting and transferring exactly as before —
 * so a moderator believed a sanction was in force that had never existed.
 *
 * It is enforced in two places, and it needs both.
 *
 *   1. **In the filter of every shared debit.** `placeWager`, `chargeExact`,
 *      `debitUpTo`, the escrow debits and both sides of a coin transfer put
 *      `NOT_FROZEN` in the update's own filter, so a frozen member's coins
 *      cannot move even from a path with no command behind it — a button, a
 *      collector, a service — and cannot move because of a freeze that landed
 *      mid-flight. This is the guarantee: it inherits the atomicity the debits
 *      already have rather than adding a read-then-act check that a concurrent
 *      write can slip through.
 *
 *   2. **At the command gate**, in events/interactionCreate.js. The filters
 *      stop coins *leaving*; they cannot stop a frozen member *earning*,
 *      because a credit refused in its filter is indistinguishable from a
 *      credit that failed, and the economy's answer to a failed credit is to
 *      write it down as owed and pay it on the next replay. Refusing the
 *      command before the reward is computed is the only place that
 *      distinction can be made. It is also what turns "you don't have enough
 *      coins" — which is what a filter miss reads as to the player — into a
 *      sentence that says what actually happened.
 *
 * The gate is default-deny over the whole `economy` category and the exemptions
 * are listed here, rather than each command opting in. A new economy command
 * that forgets to opt in is a sanction that silently does not apply, which is
 * the bug this file exists to close; a new read-only command that forgets to
 * opt out is a view a frozen member cannot open until someone adds a line.
 */

/**
 * The clause that makes a frozen member match nothing.
 *
 * `$ne: true` and not `false`: `economyFrozen` defaults to false on the schema
 * but documents written before the field existed do not carry it at all, and
 * `{ economyFrozen: false }` would exclude every one of them.
 */
const NOT_FROZEN = Object.freeze({ economyFrozen: { $ne: true } });

/** `filter` with the freeze guard folded in. */
function unfrozen(filter) {
    return { ...filter, ...NOT_FROZEN };
}

/** What a frozen member is told, wherever they are told it. */
const FROZEN_NOTICE =
    'Your economy access is frozen in this server, so this command cannot run. '
    + 'A server admin can lift it from the dashboard.';

/** What the *other* party is told when they are the frozen one. */
function frozenTargetNotice(mention) {
    return `${mention}'s economy access is frozen in this server, so they cannot send or receive coins.`;
}

/**
 * Commands under `src/commands/economy/` the gate lets a frozen member run.
 *
 * The rule for the list is narrow on purpose: a command belongs here only if it
 * cannot move coins, items or economy progress on any of its branches. Looking
 * at a balance, an inventory, a job board or a showcase is not a sanction worth
 * imposing, and a frozen member who cannot see their own balance cannot see
 * that the freeze is what is stopping them.
 *
 * `/balance` and `/synergies` create the member's document if they have none;
 * that is an empty row, not a payment, and the same upsert any read of theirs
 * would do. Everything else here writes nothing at all.
 *
 * tests/economyFreezeGate.test.js holds the list to that rule by scanning the
 * command sources, so an entry that grows a write fails the suite rather than
 * quietly re-opening the hole.
 */
const FREEZE_EXEMPT_COMMANDS = new Set([
    'balance',
    'featured',
    'inventory',
    'jobs',
    'robstatus',
    'showcase',
    'synergies',
]);

/** Whether the gate applies to this command at all. */
function commandIsFreezeGated(command) {
    return command?.category === 'economy' && !FREEZE_EXEMPT_COMMANDS.has(command?.data?.name);
}

/**
 * Whether this member's economy is frozen.
 *
 * Projected to the one field, on the unique `{ userId, guildId }` index, so the
 * gate costs a keyed lookup and not a document. A member with no row is not
 * frozen — there is nothing to freeze — which is also what keeps the gate from
 * standing between a first-time player and their first command.
 */
async function isEconomyFrozen(filter, Model = null) {
    // Required here rather than at the top of the file: `NOT_FROZEN` is a plain
    // object and the debit helpers that spread it into their filters have no
    // other reason to pull a Mongoose model — and the model pulls in the whole
    // schema — so the import belongs on the one path that needs it.
    const User = Model ?? require('../models/User');
    const doc = await User.findOne(filter, { economyFrozen: 1 }).lean();
    return doc?.economyFrozen === true;
}

module.exports = {
    NOT_FROZEN, unfrozen, isEconomyFrozen,
    FROZEN_NOTICE, frozenTargetNotice,
    FREEZE_EXEMPT_COMMANDS, commandIsFreezeGated,
};
