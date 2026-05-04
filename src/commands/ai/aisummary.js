const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const SummaryJob = require('../../models/SummaryJob');
const { runSummaryJob } = require('../../services/summaryService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('aisummary')
        .setDescription('Schedule daily AI summaries of channel activity')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a new daily summary job')
            .addChannelOption(o => o.setName('source').setDescription('Channel to summarize').setRequired(true))
            .addChannelOption(o => o.setName('target').setDescription('Channel to post the summary in').setRequired(true))
            .addIntegerOption(o => o.setName('hour').setDescription('UTC hour to post (0–23, default 9)').setMinValue(0).setMaxValue(23))
            .addIntegerOption(o => o.setName('minute').setDescription('UTC minute to post (0–59, default 0)').setMinValue(0).setMaxValue(59))
            .addStringOption(o => o.setName('label').setDescription('Summary title (default: "Daily Summary of #channel")')))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a summary job')
            .addStringOption(o => o.setName('id').setDescription('Job ID (from /aisummary list)').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List all summary jobs for this server'))
        .addSubcommand(sub => sub
            .setName('run')
            .setDescription('Run a summary job right now')
            .addStringOption(o => o.setName('id').setDescription('Job ID').setRequired(true))),

    cooldown: 30,
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const source = interaction.options.getChannel('source');
            const target = interaction.options.getChannel('target');
            const hour   = interaction.options.getInteger('hour')   ?? 9;
            const minute = interaction.options.getInteger('minute') ?? 0;
            const label  = interaction.options.getString('label')   || `Daily Summary of #${source.name}`;

            const botMember = interaction.guild.members.me;
            if (!source.isTextBased() || source.isThreadOnly()) {
                return interaction.reply({ content: 'The source channel must be a text-based channel.', ephemeral: true });
            }
            if (!target.isTextBased() || target.isThreadOnly()) {
                return interaction.reply({ content: 'The target channel must be a text-based channel.', ephemeral: true });
            }
            if (!source.permissionsFor(botMember)?.has('ViewChannel')) {
                return interaction.reply({ content: `I don't have permission to view <#${source.id}>.`, ephemeral: true });
            }
            if (!target.permissionsFor(botMember)?.has('SendMessages')) {
                return interaction.reply({ content: `I don't have permission to send messages in <#${target.id}>.`, ephemeral: true });
            }

            const job = await SummaryJob.create({
                guildId: interaction.guild.id,
                sourceChannelId: source.id,
                targetChannelId: target.id,
                hour,
                minute,
                label
            });

            const hh = String(hour).padStart(2, '0');
            const mm = String(minute).padStart(2, '0');

            await interaction.reply({
                content: [
                    `Summary job created — ID: \`${job._id}\``,
                    `**Source:** <#${source.id}>  →  **Target:** <#${target.id}>`,
                    `**Schedule:** Daily at **${hh}:${mm} UTC**`,
                    `**Label:** ${label}`,
                    '',
                    `Make sure AI is enabled for this server. Run \`/aisummary run\` to test it now.`
                ].join('\n'),
                ephemeral: true
            });

        } else if (sub === 'remove') {
            const id = interaction.options.getString('id');
            let job;
            try {
                job = await SummaryJob.findOneAndDelete({ _id: id, guildId: interaction.guild.id });
            } catch {
                return interaction.reply({ content: 'Invalid ID.', ephemeral: true });
            }
            if (!job) return interaction.reply({ content: 'Job not found.', ephemeral: true });
            await interaction.reply({ content: `Removed summary job: **${job.label}**`, ephemeral: true });

        } else if (sub === 'list') {
            const jobs = await SummaryJob.find({ guildId: interaction.guild.id });
            if (!jobs.length) return interaction.reply({ content: 'No summary jobs configured.', ephemeral: true });

            const lines = jobs.map(j => {
                const hh = String(j.hour).padStart(2, '0');
                const mm = String(j.minute).padStart(2, '0');
                const status = j.enabled ? '✅' : '❌';
                const lastRun = j.lastRun ? `<t:${Math.floor(j.lastRun.getTime() / 1000)}:R>` : 'never';
                return `${status} \`${j._id}\` **${j.label}**\n<#${j.sourceChannelId}> → <#${j.targetChannelId}> • ${hh}:${mm} UTC • last ran ${lastRun}`;
            });

            const embed = new EmbedBuilder()
                .setTitle('AI Summary Jobs')
                .setColor(0x5865F2)
                .setDescription(lines.join('\n\n').slice(0, 4000))
                .setFooter({ text: `${jobs.length} job${jobs.length !== 1 ? 's' : ''}` });

            await interaction.reply({ embeds: [embed], ephemeral: true });

        } else if (sub === 'run') {
            const id = interaction.options.getString('id');
            let job;
            try {
                job = await SummaryJob.findOne({ _id: id, guildId: interaction.guild.id });
            } catch {
                return interaction.reply({ content: 'Invalid ID.', ephemeral: true });
            }
            if (!job) return interaction.reply({ content: 'Job not found.', ephemeral: true });

            await interaction.deferReply({ ephemeral: true });
            try {
                const posted = await runSummaryJob(job, interaction.client);
                if (posted) {
                    await interaction.editReply(`Summary posted successfully to <#${job.targetChannelId}>.`);
                } else {
                    await interaction.editReply('No summary posted — no new content to summarize or AI is not configured.');
                }
            } catch (err) {
                console.error('[aisummary run]', err);
                await interaction.editReply(`Error running summary: ${err.message}`);
            }
        }
    }
};
