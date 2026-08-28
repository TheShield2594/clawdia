'use strict';

/**
 * Everything a poll does once it exists: persistence, vote handling, and closing
 * it when its timer runs out.
 *
 * Split out of `commands/utility/poll.js` (#614). The scheduler and the
 * interaction dispatcher both needed this, and the only copy was inside the
 * command — so `services/scheduler` imported a command to pick up unclosed polls
 * at startup, which is the layer inversion the boundary rule now refuses. The
 * command keeps what is actually a command: the slash-command definition and the
 * reply that opens the poll.
 */

const Poll = require('../models/Poll');
const { runJob } = require('../utils/jobRunner');
const { tallyVotes, buildPollEmbed, buildPollRows } = require('../views/pollView');
const { MessageFlags } = require('discord.js');

function parseDuration(str) {
    const match = str.match(/^(\d+)(s|m|h|d)$/i);
    if (!match) return null;
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return parseInt(match[1]) * multipliers[match[2].toLowerCase()];
}

// Discord API error codes meaning the poll message can never be edited again:
// Unknown Message, Unknown Channel, Missing Access.
const MESSAGE_UNREACHABLE = new Set([10008, 10003, 50001]);

// setTimeout stores its delay in a 32-bit signed integer. Anything larger does
// not fail — Node warns and substitutes 1, so the callback runs on the next
// tick. `/poll ... duration 30d` is 2.59e9 ms, so it closed the poll roughly
// immediately instead of in a month. Longer waits are served in hops of this
// size until the real deadline is in reach.
const MAX_TIMEOUT_MS = 2_147_483_647;

function scheduleExpiry(msg, question, options, endsAt, createdBy) {
    // Overdue polls close now rather than being dropped. A poll only reaches
    // this already past its end when it is being picked up at startup — the bot
    // was down when it expired, or a transient edit failure left it open — and
    // returning early there is what made "still open" permanent.
    const delay = Math.max(0, endsAt.getTime() - Date.now());

    if (delay > MAX_TIMEOUT_MS) {
        return setTimeout(() => scheduleExpiry(msg, question, options, endsAt, createdBy), MAX_TIMEOUT_MS);
    }

    // Through runJob like every other scheduled callback (#611): a poll that
    // fails to close is a poll that stays open forever, and a swallowed
    // console.error was the only trace of it. `scope` is the message id
    // because this fires once for one poll and no later tick retries it — two
    // polls expiring in the same second must both run, not one be dropped as
    // an overlap of the other.
    return setTimeout(() => runJob('poll', 'closeExpiredPoll', async () => {
        const poll = await Poll.findOne({ messageId: msg.id });
        if (!poll || poll.closed) return;

        const counts = tallyVotes(poll.votes, options.length);
        const closedEmbed = buildPollEmbed(question, options, counts, endsAt, createdBy, true);
        try {
            await msg.edit({ embeds: [closedEmbed], components: [] });
        } catch (err) {
            // A message that is not there any more is the one failure that
            // still ends the poll: there is nothing left to edit and nothing a
            // retry would reach, so mark it closed and stop taking votes.
            // Anything else — a rate limit, an outage — leaves the poll open
            // with live buttons, which is the truth, and propagates so runJob
            // records it instead of the poll being marked closed against a
            // message still showing it as running.
            if (!MESSAGE_UNREACHABLE.has(err?.code)) throw err;
        }

        poll.closed = true;
        await poll.save();
    }, { guildId: msg.guildId, scope: msg.id, payload: { messageId: msg.id } }), delay);
}

/**
 * Persists a freshly posted poll and arms its expiry timer.
 */
async function createPoll({ msg, guildId, channelId, question, options, endsAt, createdBy }) {
    await Poll.create({
        messageId: msg.id,
        guildId,
        channelId,
        question,
        options,
        votes: new Map(),
        endsAt,
        createdBy,
    });

    if (endsAt) scheduleExpiry(msg, question, options, endsAt, createdBy);
}

async function handlePollVote(interaction) {
    const optionIndex = parseInt(interaction.customId.split('_')[1]);
    const messageId = interaction.message.id;

    const poll = await Poll.findOne({ messageId });
    if (!poll) {
        return interaction.reply({ content: 'This poll is no longer active.', flags: MessageFlags.Ephemeral });
    }
    if (poll.closed) {
        return interaction.reply({ content: 'This poll is closed.', flags: MessageFlags.Ephemeral });
    }

    const existing = poll.votes.get(interaction.user.id);
    if (existing === optionIndex) {
        poll.votes.delete(interaction.user.id);
        await interaction.reply({ content: 'Your vote has been removed.', flags: MessageFlags.Ephemeral });
    } else {
        poll.votes.set(interaction.user.id, optionIndex);
        await interaction.reply({ content: `You voted for option **${optionIndex + 1}**.`, flags: MessageFlags.Ephemeral });
    }
    poll.markModified('votes');
    await poll.save();

    const counts = tallyVotes(poll.votes, poll.options.length);
    const newEmbed = buildPollEmbed(poll.question, poll.options, counts, poll.endsAt, poll.createdBy);
    const rows = buildPollRows(poll.options);
    await interaction.message.edit({ embeds: [newEmbed], components: rows }).catch(() => {});
}

async function scheduleActivePollExpirations(client) {
    try {
        // No lower bound on endsAt: a poll that expired while the process was
        // down has no timer left anywhere, so excluding it here is what left it
        // open forever. scheduleExpiry closes an overdue one immediately.
        //
        // `endsAt: null` is excluded, though, because it is not an overdue poll
        // — it is `/poll` without a duration, which is stored open on purpose
        // and has no timer to restore. Those were being handed to
        // scheduleExpiry, where `endsAt.getTime()` threw once per such poll on
        // every boot, and they were counted in the pickup line below as if
        // something had been rescheduled.
        const active = await Poll.find({ closed: false, endsAt: { $ne: null } });
        for (const poll of active) {
            try {
                const guild = client.guilds.cache.get(poll.guildId);
                if (!guild) continue;
                const channel = guild.channels.cache.get(poll.channelId);
                if (!channel) continue;
                const msg = await channel.messages.fetch(poll.messageId).catch(() => null);
                if (!msg) continue;
                scheduleExpiry(msg, poll.question, poll.options, poll.endsAt, poll.createdBy);
            } catch (err) {
                console.error('[poll] failed to reschedule poll', poll.messageId, err);
            }
        }
        if (active.length) console.log(`[POLL] Picked up ${active.length} unclosed poll(s).`);
    } catch (err) {
        console.error('[poll] scheduleActivePollExpirations error:', err);
    }
}

module.exports = {
    parseDuration,
    createPoll,
    scheduleExpiry,
    handlePollVote,
    scheduleActivePollExpirations,
};
