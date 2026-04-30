const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

const TRACK_INFO = {
    none: {
        label: 'No Track',
        description: 'No specialization. Default XP rates.',
        emoji: '⚪'
    },
    creator: {
        label: 'Creator',
        description: 'Earn bonus XP when posting messages with attachments (images, files).',
        emoji: '🎨'
    },
    helper: {
        label: 'Helper',
        description: 'Earn bonus XP when active in designated help channels.',
        emoji: '🤝'
    },
    raider: {
        label: 'Raider',
        description: 'Earn bonus XP on your first 10 messages each day (active participation).',
        emoji: '⚔️'
    }
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('track')
        .setDescription('View or set your progression track')
        .addStringOption(o =>
            o.setName('choose')
                .setDescription('Pick a track to specialize in')
                .setRequired(false)
                .addChoices(
                    { name: '⚪ None — no specialization', value: 'none' },
                    { name: '🎨 Creator — bonus XP for posting attachments', value: 'creator' },
                    { name: '🤝 Helper — bonus XP in help channels', value: 'helper' },
                    { name: '⚔️ Raider — bonus XP for first 10 daily messages', value: 'raider' }
                )),

    async execute(interaction) {
        const chosen = interaction.options.getString('choose');
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!guildSettings?.progressionTracks?.enabled) {
            return interaction.reply({ content: 'Progression tracks are not enabled on this server.', ephemeral: true });
        }

        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) {
            user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
        }

        if (chosen) {
            user.track = chosen;
            await user.save();

            const info = TRACK_INFO[chosen];
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle(`Track Set: ${info.emoji} ${info.label}`)
                    .setDescription(info.description)
                    .setFooter({ text: 'Your XP bonuses will apply from your next message.' })],
                ephemeral: true
            });
        }

        // Show current track and all options
        const current = user.track ?? 'none';
        const pt = guildSettings.progressionTracks;

        const trackLines = Object.entries(TRACK_INFO).map(([key, info]) => {
            const bonus = key === 'creator' ? pt.creatorBonus
                : key === 'helper' ? pt.helperBonus
                : key === 'raider' ? pt.raiderBonus : 0;
            const active = key === current ? ' **(current)**' : '';
            return `${info.emoji} **${info.label}**${active}${bonus ? ` — +${bonus}% XP` : ''}\n${info.description}`;
        });

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Progression Tracks')
            .setDescription(trackLines.join('\n\n'))
            .setFooter({ text: 'Use /track choose:<track> to switch your track' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
