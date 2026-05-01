const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Poll = require('../../models/Poll');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a button-based poll')
        .addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true))
        .addStringOption(o => o.setName('option1').setDescription('First option').setRequired(true))
        .addStringOption(o => o.setName('option2').setDescription('Second option').setRequired(true))
        .addStringOption(o => o.setName('option3').setDescription('Third option'))
        .addStringOption(o => o.setName('option4').setDescription('Fourth option'))
        .addStringOption(o => o.setName('option5').setDescription('Fifth option'))
        .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 10m, 1h, 1d (default: no expiry)')),

    async execute(interaction) {
        const question = interaction.options.getString('question');
        const options = [1, 2, 3, 4, 5]
            .map(i => interaction.options.getString(`option${i}`))
            .filter(Boolean);

        const durationStr = interaction.options.getString('duration');
        let endsAt = null;
        if (durationStr) {
            const ms = parseDuration(durationStr);
            if (!ms) return interaction.reply({ content: 'Invalid duration. Use formats like `10m`, `1h`, `1d`.', ephemeral: true });
            endsAt = new Date(Date.now() + ms);
        }

        const counts = new Array(options.length).fill(0);
        const embed = buildPollEmbed(question, options, counts, endsAt, interaction.user);
        const rows = buildPollRows(options);

        await interaction.reply({ embeds: [embed], components: rows });
        const msg = await interaction.fetchReply();

        await Poll.create({
            messageId: msg.id,
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            question,
            options,
            votes: new Map(),
            endsAt,
            createdBy: interaction.user.tag
        });

        if (endsAt) {
            scheduleExpiry(msg, question, options, endsAt, interaction.user.tag);
        }
    }
};

function parseDuration(str) {
    const match = str.match(/^(\d+)(s|m|h|d)$/i);
    if (!match) return null;
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return parseInt(match[1]) * multipliers[match[2].toLowerCase()];
}

function tallyVotes(voteMap, optionCount) {
    const counts = new Array(optionCount).fill(0);
    for (const idx of voteMap.values()) counts[idx]++;
    return counts;
}

function buildPollEmbed(question, options, counts, endsAt, author, closed = false) {
    const total = counts.reduce((a, b) => a + b, 0);

    const lines = options.map((opt, i) => {
        const pct = total > 0 ? Math.round((counts[i] / total) * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        return `**${i + 1}. ${opt}**\n${bar} ${pct}% (${counts[i]} vote${counts[i] !== 1 ? 's' : ''})`;
    });

    const authorTag = typeof author === 'string' ? author : author.tag;

    const embed = new EmbedBuilder()
        .setColor(closed ? '#ff0000' : '#5865F2')
        .setTitle(`${closed ? '🔒 ' : '📊 '}${question}`)
        .setDescription(lines.join('\n\n'))
        .addFields({ name: 'Total votes', value: total.toString(), inline: true })
        .setFooter({ text: `Created by ${authorTag}${closed ? ' • Poll closed' : ''}` });

    if (endsAt && !closed) {
        embed.addFields({ name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true });
    }

    return embed;
}

function buildPollRows(options) {
    const rows = [];
    for (let i = 0; i < options.length; i += 5) {
        const row = new ActionRowBuilder();
        options.slice(i, i + 5).forEach((opt, j) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`poll_${i + j}`)
                    .setLabel(`${i + j + 1}. ${opt.substring(0, 77)}`)
                    .setStyle(ButtonStyle.Secondary)
            );
        });
        rows.push(row);
    }
    return rows;
}

function scheduleExpiry(msg, question, options, endsAt, createdBy) {
    const delay = endsAt.getTime() - Date.now();
    if (delay <= 0) return;
    setTimeout(async () => {
        try {
            const poll = await Poll.findOne({ messageId: msg.id });
            if (!poll || poll.closed) return;

            const counts = tallyVotes(poll.votes, options.length);
            const closedEmbed = buildPollEmbed(question, options, counts, endsAt, createdBy, true);
            await msg.edit({ embeds: [closedEmbed], components: [] }).catch(() => {});

            poll.closed = true;
            await poll.save();
        } catch (err) {
            console.error('[poll] expiry error:', err);
        }
    }, delay);
}

async function handlePollVote(interaction) {
    const optionIndex = parseInt(interaction.customId.split('_')[1]);
    const messageId = interaction.message.id;

    const poll = await Poll.findOne({ messageId });
    if (!poll) {
        return interaction.reply({ content: 'This poll is no longer active.', ephemeral: true });
    }
    if (poll.closed) {
        return interaction.reply({ content: 'This poll is closed.', ephemeral: true });
    }

    const existing = poll.votes.get(interaction.user.id);
    if (existing === optionIndex) {
        poll.votes.delete(interaction.user.id);
        await interaction.reply({ content: 'Your vote has been removed.', ephemeral: true });
    } else {
        poll.votes.set(interaction.user.id, optionIndex);
        await interaction.reply({ content: `You voted for option **${optionIndex + 1}**.`, ephemeral: true });
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
        const active = await Poll.find({ closed: false, endsAt: { $gt: new Date() } });
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
        if (active.length) console.log(`[POLL] Rescheduled ${active.length} active poll(s).`);
    } catch (err) {
        console.error('[poll] scheduleActivePollExpirations error:', err);
    }
}

module.exports.handlePollVote = handlePollVote;
module.exports.buildPollEmbed = buildPollEmbed;
module.exports.buildPollRows = buildPollRows;
module.exports.tallyVotes = tallyVotes;
module.exports.scheduleActivePollExpirations = scheduleActivePollExpirations;
