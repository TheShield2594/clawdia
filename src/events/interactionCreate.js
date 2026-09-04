const { MessageFlags } = require('discord.js');
const Guild = require('../models/Guild');
const User = require('../models/User');
const { handlePollVote } = require('../services/pollService');
const { handleHeistButton } = require('../services/heistService');
const { handleSyndicateButton } = require('../commands/economy/syndicate');
const { handleDmButton } = require('../services/dmService');
const {
    isEightBallButton,
    isEightBallModal,
    handleEightBallButton,
    handleEightBallModal,
} = require('../commands/fun/8ball');
const {
    ensureQuests, onCommandUse, questEventCanProgress, questAssignmentNeeded,
    notifyQuestComplete, notifyQuestNearComplete,
} = require('../services/questService');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const {
    commandIsFreezeGated, isEconomyFrozen, NOT_FROZEN, FROZEN_NOTICE, FREEZE_UNKNOWN_NOTICE,
} = require('../utils/economyFreeze');
const { saveWithBalanceDelta } = require('../utils/balanceDelta');
const cooldownStore = require('../utils/commandCooldowns');
const { recordCommandMetric } = require('../utils/commandMetricsBuffer');
// Giveaway entry/withdrawal.
//
// Entrants are toggled directly in the Guild document with $addToSet/$pull
// rather than being accumulated on interaction.message. Two reasons: the
// in-memory copy is lost on every restart (giveaways that outlive a deploy
// would draw from an empty pool), and a burst of simultaneous clicks on a
// read-modify-write array loses entries.
async function handleGiveawayEntry(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: 'Giveaways can only be entered inside a server.', flags: MessageFlags.Ephemeral });
    }

    const guildId = interaction.guild.id;
    const messageId = interaction.message.id;
    const userId = interaction.user.id;

    const alreadyEntered = await Guild.exists({
        guildId,
        giveaways: { $elemMatch: { messageId, entrantIds: userId } }
    });

    if (alreadyEntered) {
        await Guild.updateOne(
            { guildId, giveaways: { $elemMatch: { messageId } } },
            { $pull: { 'giveaways.$.entrantIds': userId } }
        );
        return interaction.reply({ content: 'You have left the giveaway.', flags: MessageFlags.Ephemeral });
    }

    const result = await Guild.updateOne(
        { guildId, giveaways: { $elemMatch: { messageId, ended: false } } },
        { $addToSet: { 'giveaways.$.entrantIds': userId } }
    );

    if (!result.matchedCount) {
        return interaction.reply({ content: 'This giveaway is no longer accepting entries.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        content: `${interaction.user}, you have entered the giveaway! Good luck!`,
        flags: MessageFlags.Ephemeral
    });
}

// Buffered, not written (#895). This used to be an awaited `$push` with
// `$slice: -3000` per command, which MongoDB serves by rewriting the capped
// region of the array — a write proportional to the cap rather than to the one
// entry — and it sat in front of the user's reply. Nothing here is on anyone's
// critical path, so it is neither awaited nor written per command now: the
// buffer batches an interval's worth into one push per guild. See
// utils/commandMetricsBuffer.js for what that costs on a crash.
function logCommandMetric(interaction, success, reason = null) {
    recordCommandMetric(interaction.guild.id, {
        command: interaction.commandName,
        channelId: interaction.channelId || null,
        hour: new Date().getUTCHours(),
        success,
        reason
    });
}

async function trackQuestCommandUse(interaction) {
    // Cached: this ran a second full guild document read after every command,
    // on top of the one in execute(). Quest tracking only reads from it.
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (!guildSettings?.quests?.enabled) return;

    const filter = { userId: interaction.user.id, guildId: interaction.guild.id };

    // Cheap read first (#898). This runs after *every* successful command, on
    // top of whatever the command handler itself already loaded and saved for
    // the same user — so it was a second full document hydrate and a second
    // full save each time, for a counter that usually has nothing to move.
    // Most members hold no live command quest at any given moment: the five ids
    // are a handful of dailies and weeklies, finished early and then dormant
    // until they roll over.
    //
    // The projection is the quest list and the freeze flag, which is everything
    // the two questions below need. When they both answer no, the command costs
    // this one small read and nothing else. When either answers yes, the full
    // document is fetched as before — one extra tiny read on the rare path, in
    // exchange for dropping a hydrate and a save from the common one.
    const snapshot = await User.findOne(filter, { quests: 1, economyFrozen: 1 }).lean();
    if (snapshot) {
        if (snapshot.economyFrozen) return;
        if (!questEventCanProgress(snapshot.quests, 'command')
            && !questAssignmentNeeded(snapshot.quests, guildSettings)) return;
    }

    let user = await User.findOne(filter);
    if (!user) {
        user = await User.create(filter);
    }

    // A frozen member earns nothing, and a completed quest pays coins (#870).
    // This runs after *every* successful command — the read-only ones the gate
    // exempts and every non-economy command too — so without this a frozen
    // member finishes "use 5 commands" on `/help` and is paid for it, which is
    // the whole of what the freeze is supposed to stop.
    //
    // Progress is withheld along with the coins, since a quest that ticks while
    // frozen just pays out the moment the freeze lifts.
    if (user.economyFrozen) return;

    // A quest completing here pays coins, and this runs after every command —
    // so the reward goes out as an `$inc` rather than riding the save as an
    // absolute `$set` that would erase whatever the command itself just paid.
    const balanceAtLoad = user.balance ?? 0;

    await ensureQuests(user, guildSettings);
    const { completed, nearComplete } = await onCommandUse(user, guildSettings);
    await saveWithBalanceDelta(User, user, balanceAtLoad, {
        service: 'interactionCreate',
        jobName: 'commandQuestReward',
        guildId: interaction.guild.id,
        // The check above is a read, and by here it is a few round trips old: an
        // admin freezing the member in between would still be paid out. The
        // guard rides in the credit's own filter so that window closes, which is
        // the same reason every debit carries it rather than checking beside it.
        //
        // This credit is unkeyed, so a filter that matches nothing refuses the
        // coins outright rather than filing them as owed. What it cannot undo is
        // the `save()` above, so a freeze landing inside that window still
        // persists the quest progress and still shows the completion notice —
        // both cosmetic, and neither pays anything.
        guard: NOT_FROZEN,
    });

    await notifyQuestComplete(guildSettings, interaction.member, completed, interaction.channel, user);
    await notifyQuestNearComplete(guildSettings, interaction.member, nearComplete, interaction.channel);
}

function memberHasAnyRole(member, roleIds = []) {
    if (!member || !Array.isArray(roleIds) || roleIds.length === 0) return false;
    return roleIds.some(roleId => member.roles?.cache?.has(roleId));
}

function isWithinRuleWindow(rule, now) {
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(day)) {
        return false;
    }
    if (rule.startHourUtc == null || rule.endHourUtc == null) return true;
    if (rule.startHourUtc <= rule.endHourUtc) {
        return hour >= rule.startHourUtc && hour <= rule.endHourUtc;
    }
    return hour >= rule.startHourUtc || hour <= rule.endHourUtc;
}

// `setDefaultMemberPermissions` on a command builder is a *default*, not a rule.
// A guild admin can reassign any command to @everyone under Server Settings →
// Integrations, and Discord will then deliver it as an ordinary interaction with
// nothing to say the gate was moved. Fifteen moderation commands took Discord's
// word for it and re-checked nothing, so the only thing standing between a
// reassigned /ban and an ordinary member was a setting an attacker's own admin
// could change.
//
// Commands opt in by declaring `requiredPermissions`, and the check lands here
// once rather than in fifteen handlers where the sixteenth is the one that
// forgets. Administrators and the guild owner satisfy any bit — Discord already
// folds that into the permissions it sends, and PermissionsBitField#missing
// honours it.
function missingRequiredPermissions(interaction, command) {
    const required = command.requiredPermissions;
    if (!required || (Array.isArray(required) && required.length === 0)) return null;

    // A guild chat-input interaction always carries this. Absent means we cannot
    // establish what the caller holds, and "cannot establish" is not "allowed".
    if (!interaction.memberPermissions) return ['Unknown'];

    const missing = interaction.memberPermissions.missing(required);
    return missing.length ? missing : null;
}

function getPolicyDecision(interaction, guildSettings) {
    const policies = guildSettings?.commandPolicies;
    if (!policies?.enabled) return { allowed: true };
    if (policies.exceptions?.userIds?.includes(interaction.user.id)) return { allowed: true };
    if (memberHasAnyRole(interaction.member, policies.exceptions?.roleIds)) return { allowed: true };

    const cmd = interaction.commandName;
    const now = new Date();
    const applicableRules = (policies.rules || []).filter(rule => {
        if (rule.command !== cmd && rule.command !== '*') return false;
        if (Array.isArray(rule.roleIds) && rule.roleIds.length > 0 && !memberHasAnyRole(interaction.member, rule.roleIds)) return false;
        if (Array.isArray(rule.channelIds) && rule.channelIds.length > 0 && !rule.channelIds.includes(interaction.channelId)) return false;
        return isWithinRuleWindow(rule, now);
    });
    const denied = applicableRules.find(rule => rule.effect === 'deny');
    if (denied) return { allowed: false, reason: 'This command is blocked by server policy for your context.' };
    return { allowed: true };
}

// Node's setTimeout treats delays > 2^31-1 ms as 1 ms, which would wipe the
// cooldown timestamp almost immediately and let the next call slip past the
// gate. Clamp cooldown seconds so seconds * 1000 stays within timer bounds.
const MAX_TIMER_MS = 2_147_483_647;
const MAX_COOLDOWN_SECONDS = Math.floor(MAX_TIMER_MS / 1000);

function coerceCooldown(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(Math.min(n, MAX_COOLDOWN_SECONDS));
}

function getCooldownSeconds(command, interaction, guildSettings) {
    const rawBase = typeof command.cooldownAmount === 'function'
        ? command.cooldownAmount(interaction)
        : (command.cooldown ?? 3);
    const baseCooldown = coerceCooldown(rawBase, 3);
    const overrides = guildSettings?.commandPolicies?.cooldownOverrides || [];
    const matches = overrides.filter(entry =>
        entry.command === command.data.name &&
        Number.isFinite(Number(entry.cooldownSeconds)) &&
        Number(entry.cooldownSeconds) >= 0 &&
        interaction.member?.roles?.cache?.has(entry.roleId));
    if (!matches.length) return baseCooldown;
    return coerceCooldown(Math.min(...matches.map(match => Number(match.cooldownSeconds))), baseCooldown);
}

function getCooldownKey(command, interaction) {
    return typeof command.cooldownKey === 'function'
        ? command.cooldownKey(interaction)
        : command.data.name;
}

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        if (interaction.isButton()) {
            // Heist lobby join and skill check buttons (may come from DMs where guild is null)
            if (interaction.customId.startsWith('heist_join_') || interaction.customId.startsWith('heist_skill_')) {
                await handleHeistButton(interaction, client).catch(err => {
                    console.error('[heist] button handler error:', err);
                });
                return;
            }

            if (interaction.customId.startsWith('syn_join_') || interaction.customId.startsWith('syn_skill_')) {
                await handleSyndicateButton(interaction, client).catch(err => {
                    console.error('[syndicate] button handler error:', err);
                });
                return;
            }

            if (interaction.customId === 'giveaway_enter') {
                await handleGiveawayEntry(interaction).catch(err => {
                    console.error('[giveaway] entry handler error:', err);
                });
                return;
            }

            if (interaction.customId.startsWith('poll_')) {
                await handlePollVote(interaction);
            }

            // The 8-ball's buttons are deliberately not held by a collector:
            // routing them here is what lets an old message still work, and
            // keeps them working across a restart.
            if (isEightBallButton(interaction.customId)) {
                await handleEightBallButton(interaction).catch(err => {
                    console.error('[8ball] button handler error:', err);
                });
                return;
            }

            if (interaction.customId.startsWith('dm_storysofar_')) {
                await handleDmButton(interaction, client).catch(err => {
                    console.error('[dm] button handler error:', err);
                });
                return;
            }

            return;
        }

        if (interaction.isModalSubmit()) {
            if (isEightBallModal(interaction.customId)) {
                await handleEightBallModal(interaction).catch(err => {
                    console.error('[8ball] modal handler error:', err);
                });
            }
            return;
        }

        if (interaction.isAutocomplete()) {
            const command = client.commands.get(interaction.commandName);
            const safeRespondEmpty = async () => {
                if (interaction.responded) return;
                try { await interaction.respond([]); } catch (_) { /* interaction expired */ }
            };
            if (!command?.autocomplete) {
                await safeRespondEmpty();
                return;
            }
            try {
                await command.autocomplete(interaction, client);
            } catch (error) {
                console.error(`Autocomplete error in ${interaction.commandName}:`, error);
                await safeRespondEmpty();
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        // Commands are registered globally, and only a handful opt out of DMs
        // explicitly, so Discord will happily deliver most of them with no guild
        // attached. Everything below (settings lookup, metrics, quests) assumes
        // interaction.guild exists — bail out here rather than dereferencing null.
        // Checked against .guild rather than .inGuild() because guildId can be
        // populated while the guild itself is unavailable.
        if (!interaction.guild) {
            return interaction.reply({
                content: 'This command only works inside a server.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Cached read: fires on every slash command, and nothing below mutates
        // or persists the settings object. See utils/guildSettingsCache.
        const guildSettings = await getGuildSettings(interaction.guild.id);

        const command = client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            logCommandMetric(interaction, false, 'unknown_command');
            return;
        }

        const missingPerms = missingRequiredPermissions(interaction, command);
        if (missingPerms) {
            logCommandMetric(interaction, false, 'missing_permissions');
            return interaction.reply({
                content: `You need the following permission(s) to use \`/${command.data.name}\`: **${missingPerms.join(', ')}**.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const policy = getPolicyDecision(interaction, guildSettings);
        if (!policy.allowed) {
            logCommandMetric(interaction, false, 'policy_denied');
            return interaction.reply({ content: policy.reason, flags: MessageFlags.Ephemeral });
        }

        // The economy freeze a server admin sets from the dashboard (#870).
        //
        // Ahead of the cooldown claim, so a refused command does not spend the
        // window it never ran in. Behind the policy check, because a command the
        // guild has blocked outright should say so rather than reporting a
        // personal sanction.
        //
        // Fails closed. A sanction that stops applying because one read failed
        // is not a sanction, and the cost of the other direction is small: the
        // read is a keyed lookup on the same database the command is about to
        // use anyway, so a failure here almost always means the command would
        // have failed too. What it must not do is tell an innocent member they
        // are frozen — that sends them to an admin over a transient error — so
        // the two answers are worded apart.
        if (commandIsFreezeGated(command)) {
            // Left unassigned: every path out of the catch returns, so an
            // initialiser here would be a value nothing can read.
            let frozen;
            try {
                frozen = await isEconomyFrozen({ userId: interaction.user.id, guildId: interaction.guild.id });
            } catch (error) {
                console.error(`Economy freeze check failed for ${interaction.user.id}:`, error.message);
                logCommandMetric(interaction, false, 'economy_freeze_unknown');
                return interaction.reply({ content: FREEZE_UNKNOWN_NOTICE, flags: MessageFlags.Ephemeral });
            }
            if (frozen) {
                logCommandMetric(interaction, false, 'economy_frozen');
                return interaction.reply({ content: FROZEN_NOTICE, flags: MessageFlags.Ephemeral });
            }
        }

        // Short cooldowns are process-local; anything from 15 minutes up is read
        // from and written to the User document, so a deploy no longer hands
        // every long window back (#621). See utils/commandCooldowns.js.
        const cooldownBucket = getCooldownKey(command, interaction);
        const cooldownAmount = getCooldownSeconds(command, interaction, guildSettings) * 1000;
        const cooldownScope = {
            bucket: cooldownBucket,
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            cooldownMs: cooldownAmount,
        };

        // One operation, not a check followed by a claim: the yield between two
        // awaits was a window in which a user firing the same command twice
        // passed the check twice.
        const expirationTime = await cooldownStore.claimIfAvailable(client, cooldownScope);
        if (expirationTime) {
            const expiredTimestamp = Math.round(expirationTime / 1000);
            const longCooldown = (expirationTime - Date.now()) > 12 * 60 * 60 * 1000;
            const exactTime = longCooldown ? ` (<t:${expiredTimestamp}:F>)` : '';

            return interaction.reply({
                content: `Please wait, you are on cooldown. You can use \`/${command.data.name}\` again <t:${expiredTimestamp}:R>${exactTime}.`,
                flags: MessageFlags.Ephemeral
            });
        }

        try {
            await command.execute(interaction, client);
            logCommandMetric(interaction, true);

            // Quest: track command usage (fire-and-forget)
            trackQuestCommandUse(interaction).catch(console.error);
        } catch (error) {
            console.error(`Error executing ${interaction.commandName}:`, error);
            logCommandMetric(interaction, false, error.name || 'execution_error');
            const errorMessage = { content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral };

            // The apology itself can fail (expired token, already-acked interaction).
            // Swallow that — the original error is already logged, and letting this
            // throw would turn a handled command failure into an unhandled rejection.
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp(errorMessage);
                } else {
                    await interaction.reply(errorMessage);
                }
            } catch (replyError) {
                console.error(`Failed to report command error to user for ${interaction.commandName}:`, replyError.message);
            }
        }
    }
};

// Exposed for the permission-gate tests, which drive the check directly rather
// than booting the whole interaction handler and its model imports.
module.exports.missingRequiredPermissions = missingRequiredPermissions;

// Same reason, for the freeze gate (#870). Quest rewards are paid from here
// after *every* command, which puts them outside the command gate entirely, so
// the refusal is worth driving directly rather than inferring it from the fact
// that the line is present.
module.exports.trackQuestCommandUse = trackQuestCommandUse;
