const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// messageId -> Map<userId, optionIndex>
const pollVotes = new Map();

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

        const rows = buildPollRows(options, new Map());

        await interaction.reply({ embeds: [embed], components: rows });
        const msg = await interaction.fetchReply();

        pollVotes.set(msg.id, new Map());

        if (endsAt) {
            const delay = endsAt.getTime() - Date.now();
            setTimeout(async () => {
                const votes = pollVotes.get(msg.id) ?? new Map();
                const finalCounts = tallyVotes(votes, options.length);
                const closedEmbed = buildPollEmbed(question, options, finalCounts, endsAt, interaction.user, true);
                await msg.edit({ embeds: [closedEmbed], components: [] }).catch(console.error);
                pollVotes.delete(msg.id);
            }, delay);
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

    const embed = new EmbedBuilder()
        .setColor(closed ? '#ff0000' : '#5865F2')
        .setTitle(`${closed ? '🔒 ' : '📊 '}${question}`)
        .setDescription(lines.join('\n\n'))
        .addFields({ name: 'Total votes', value: total.toString(), inline: true })
        .setFooter({ text: `Created by ${author.tag}${closed ? ' • Poll closed' : ''}` });

    if (endsAt && !closed) {
        embed.addFields({ name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true });
    }

    return embed;
}

function buildPollRows(options, voteMap) {
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

async function handlePollVote(interaction) {
    const optionIndex = parseInt(interaction.customId.split('_')[1]);
    const messageId = interaction.message.id;

    if (!pollVotes.has(messageId)) {
        return interaction.reply({ content: 'This poll is no longer active.', ephemeral: true });
    }

    const votes = pollVotes.get(messageId);
    const existing = votes.get(interaction.user.id);

    if (existing === optionIndex) {
        votes.delete(interaction.user.id);
        await interaction.reply({ content: 'Your vote has been removed.', ephemeral: true });
    } else {
        votes.set(interaction.user.id, optionIndex);
        await interaction.reply({ content: `You voted for option **${optionIndex + 1}**.`, ephemeral: true });
    }

    const embed = interaction.message.embeds[0];
    if (!embed) return;

    const question = embed.title.replace(/^[🔒📊] /, '');
    const options = embed.description.split('\n\n').map(block => {
        const match = block.match(/^\*\*\d+\. (.+)\*\*/);
        return match ? match[1] : '';
    }).filter(Boolean);

    const counts = tallyVotes(votes, options.length);
    const author = { tag: embed.footer.text.replace('Created by ', '').replace(/ • Poll closed$/, '') };
    const endsAtField = interaction.message.embeds[0].fields.find(f => f.name === 'Ends');
    const endsAt = endsAtField ? new Date(parseInt(endsAtField.value.match(/\d+/)[0]) * 1000) : null;

    const newEmbed = buildPollEmbed(question, options, counts, endsAt, author);
    const rows = buildPollRows(options, votes);

    await interaction.message.edit({ embeds: [newEmbed], components: rows }).catch(console.error);
}

module.exports.handlePollVote = handlePollVote;
module.exports.pollVotes = pollVotes;
module.exports.buildPollEmbed = buildPollEmbed;
module.exports.buildPollRows = buildPollRows;
module.exports.tallyVotes = tallyVotes;
