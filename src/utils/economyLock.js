'use strict';

/**
 * One lock per user, across every command that moves their coins.
 *
 * The lock keys used to be namespaced per subsystem — `grind:fish:…`,
 * `casino:…`, `grind:hunt:…` — which meant they only ever stopped a user
 * running the *same* command twice. `/fish cast` and `/casino blackjack` from
 * one user took different keys and ran side by side, over the same user
 * document, which is exactly the interleaving the remaining read-modify-write
 * sites lose money to.
 *
 * So the key is now the user: `economy:{guildId}:{userId}`. Any two
 * balance-touching commands from the same player in the same guild contend for
 * it, and the second one is turned away rather than queued.
 *
 * This is mitigation, not a fix. It narrows the window the surviving RMW sites
 * are exposed through; it does not make them atomic, and it stops helping the
 * moment a raid, a gift or a rob writes to a *second* user's document, which no
 * per-user lock covers. The durable answer is still guarded updates at each
 * write site.
 *
 * Because one key now covers many commands, the "already in progress" message
 * has to name the activity actually holding the lease — being told you are
 * already fishing when you are mid-blackjack is worse than not being told
 * anything. `tryAcquire` records the activity and `holderActivity` reads it
 * back; if the holder released in between, the wording falls back to generic.
 */

const { MessageFlags } = require('discord.js');
const { tryAcquire, holderActivity, release } = require('./activeGameLock');

/**
 * Grind actions resolve within one command invocation, so two minutes is far
 * more than they need and short enough that a leaked lease is a nuisance rather
 * than an outage. Casino hands run on in button collectors long after
 * `execute` returns and keep the primitive's ten-minute default.
 */
const GRIND_TTL_MS = 120_000;

/**
 * The full turned-away message per activity, rather than a noun slotted into a
 * template: `raid` is held on behalf of *another* player and so cannot be
 * phrased as something you are doing.
 */
const ACTIVITIES = {
    hunt:    '🏹 You already have a hunting action in progress — finish it before starting another.',
    mine:    '⛏️ You already have a mining action in progress — finish it before starting another.',
    fish:    '🎣 You already have a fishing action in progress — finish it before starting another.',
    explore: '🥾 You already have an exploration in progress — finish it before starting another.',
    craft:   '🔨 You already have a craft in progress — finish it before starting another.',
    casino:  '🎰 You already have a casino game in progress — finish it before starting another.',
    raid:    '⚔️ Someone is raiding your mine right now — try again in a moment.',
};

const GENERIC = '⏳ You already have an economy action in progress — finish it before starting another.';

function economyLockKey(guildId, userId) {
    return `economy:${guildId}:${userId}`;
}

/**
 * The message for a user turned away from `key`, worded around whatever is
 * actually holding it.
 */
async function busyMessage(key) {
    return ACTIVITIES[await holderActivity(key)] ?? GENERIC;
}

/**
 * Builds an `only` predicate from an allowlist of subcommands that write nothing.
 *
 * A shared key makes exempting reads matter in a way a per-command key did not.
 * `/hunt profile` has always taken its command's lock, which cost the player
 * nothing when the only thing it could collide with was another `/hunt`. Now
 * that one key covers every money-moving command, the same lock would refuse to
 * show a player their own profile because they have a blackjack hand open — a
 * lease that runs for as long as they take to play it. Reads have no
 * read-modify-write to protect, so they should not be waiting on one.
 *
 * An allowlist rather than a denylist, so the failure mode is a read that locks
 * needlessly rather than a write that races. Every entry here has been checked
 * to persist nothing beyond the idempotent `$setOnInsert` upsert that makes sure
 * the user document exists.
 *
 * Keys are `"sub"` for a bare subcommand and `"group sub"` for one inside a
 * group.
 */
function exceptReadOnly(readOnly) {
    const exempt = new Set(readOnly);
    return (interaction) => {
        const group = interaction.options.getSubcommandGroup?.(false) ?? null;
        const sub   = interaction.options.getSubcommand?.(false) ?? null;
        return !exempt.has(group ? `${group} ${sub}` : sub);
    };
}

/**
 * Wraps a command's `execute` so it holds the shared economy lock for its whole
 * run and releases it on the way out — including when the body throws, where a
 * leaked lease would lock the player out of every economy command for the TTL
 * over a failure that already cost them the action.
 *
 * `only` narrows the wrapper to the subcommands that actually move coins;
 * without it every subcommand is guarded.
 */
function withEconomyLock(execute, { activity, ttlMs = GRIND_TTL_MS, only = null } = {}) {
    return async function wrappedExecute(interaction, ...rest) {
        if (only && !only(interaction)) return execute.call(this, interaction, ...rest);

        const lockKey   = economyLockKey(interaction.guild?.id, interaction.user.id);
        const lockToken = await tryAcquire(lockKey, ttlMs, activity);
        if (!lockToken) {
            return interaction.reply({
                content: await busyMessage(lockKey),
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
        }
        try {
            return await execute.call(this, interaction, ...rest);
        } finally {
            await release(lockKey, lockToken);
        }
    };
}

module.exports = { economyLockKey, busyMessage, withEconomyLock, exceptReadOnly, GRIND_TTL_MS, ACTIVITIES, GENERIC };
