const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { parseDuration, createPoll } = require('../../services/pollService');
const { buildPollEmbed, buildPollRows } = require('../../views/pollView');

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
            if (!ms) return interaction.reply({ content: 'Invalid duration. Use formats like `10m`, `1h`, `1d`.', flags: MessageFlags.Ephemeral });
            endsAt = new Date(Date.now() + ms);
        }

        const counts = new Array(options.length).fill(0);
        const embed = buildPollEmbed(question, options, counts, endsAt, interaction.user);
        const rows = buildPollRows(options);

        await interaction.reply({ embeds: [embed], components: rows });
        const msg = await interaction.fetchReply();

        await createPoll({
            msg,
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            question,
            options,
            endsAt,
            createdBy: interaction.user.tag,
        });
    }
};
