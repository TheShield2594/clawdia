const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('season')
        .setDescription('View season pass progress or manage the current season')
        .addSubcommand(sub =>
            sub.setName('progress')
                .setDescription('View your season pass progress')
                .addUserOption(o =>
                    o.setName('user').setDescription('User to check (default: yourself)').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('View the current season details'))
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Set up a new season (Admin only)')
                .addStringOption(o => o.setName('name').setDescription('Season name').setRequired(true))
                .addStringOption(o => o.setName('end_date').setDescription('End date (YYYY-MM-DD)').setRequired(true))
                .addIntegerOption(o => o.setName('xp_per_tier').setDescription('Season XP per tier (default 100)').setMinValue(10).setRequired(false))
                .addIntegerOption(o => o.setName('max_tiers').setDescription('Max tiers (default 50)').setMinValue(5).setMaxValue(200).setRequired(false))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (sub === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
            }
            const name = interaction.options.getString('name');
            const endDateStr = interaction.options.getString('end_date');
            const xpPerTier = interaction.options.getInteger('xp_per_tier') ?? 100;
            const maxTiers = interaction.options.getInteger('max_tiers') ?? 50;

            if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
                return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', ephemeral: true });
            }
            const [year, month, day] = endDateStr.split('-').map(Number);
            const endDate = new Date(Date.UTC(year, month - 1, day));
            if (
                endDate.getUTCFullYear() !== year ||
                endDate.getUTCMonth() + 1 !== month ||
                endDate.getUTCDate() !== day
            ) {
                return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', ephemeral: true });
            }

            const seasonId = `season_${Date.now()}`;
            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id },
                {
                    $set: {
                        'season.enabled': true,
                        'season.seasonId': seasonId,
                        'season.name': name,
                        'season.startDate': new Date(),
                        'season.endDate': endDate,
                        'season.xpPerTier': xpPerTier,
                        'season.maxTiers': maxTiers
                    },
                    $setOnInsert: { guildId: interaction.guild.id, name: interaction.guild.name }
                },
                { upsert: true, new: true }
            );

            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('Season Created!')
                    .addFields(
                        { name: 'Name', value: name, inline: true },
                        { name: 'Ends', value: `<t:${Math.floor(endDate / 1000)}:D>`, inline: true },
                        { name: 'XP Per Tier', value: xpPerTier.toString(), inline: true },
                        { name: 'Max Tiers', value: maxTiers.toString(), inline: true }
                    )]
            });
        }

        if (sub === 'info') {
            const s = guildSettings?.season;
            if (!s?.enabled || !s.seasonId) {
                return interaction.reply({ content: 'No active season on this server.', ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`Season: ${s.name}`)
                .addFields(
                    { name: 'Started', value: `<t:${Math.floor(s.startDate / 1000)}:D>`, inline: true },
                    { name: 'Ends', value: `<t:${Math.floor(s.endDate / 1000)}:R>`, inline: true },
                    { name: 'XP Per Tier', value: (s.xpPerTier ?? 100).toString(), inline: true },
                    { name: 'Max Tiers', value: (s.maxTiers ?? 50).toString(), inline: true }
                )
                .setTimestamp();

            if (s.tierRewards?.length) {
                const rewardText = s.tierRewards.slice(0, 5)
                    .map(r => `Tier ${r.tier}: ${r.label || ''}${r.coins ? ` ${r.coins} coins` : ''}${r.roleId ? ` <@&${r.roleId}>` : ''}`)
                    .join('\n');
                embed.addFields({ name: 'Notable Rewards', value: rewardText });
            }

            return interaction.reply({ embeds: [embed] });
        }

        // progress subcommand
        const target = interaction.options.getUser('user') ?? interaction.user;
        const s = guildSettings?.season;

        if (!s?.enabled || !s.seasonId) {
            return interaction.reply({ content: 'No active season on this server.', ephemeral: true });
        }

        const user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
        const seasonData = user?.season?.seasonId === s.seasonId
            ? user.season
            : { xp: 0, tier: 0 };

        const xpPerTier = s.xpPerTier ?? 100;
        const maxTiers = s.maxTiers ?? 50;
        const currentTier = seasonData.tier ?? 0;
        const currentXp = seasonData.xp ?? 0;
        const xpIntoTier = currentXp % xpPerTier;
        const progressPct = Math.round((xpIntoTier / xpPerTier) * 100);
        const bar = buildBar(xpIntoTier, xpPerTier);

        const embed = new EmbedBuilder()
            .setColor('#ffd700')
            .setTitle(`${target.displayName}'s Season Pass — ${s.name}`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: 'Current Tier', value: `**${currentTier}** / ${maxTiers}`, inline: true },
                { name: 'Total Season XP', value: currentXp.toLocaleString(), inline: true },
                { name: 'Tier Progress', value: `${bar} ${progressPct}%` },
                { name: 'Season Ends', value: `<t:${Math.floor(s.endDate / 1000)}:R>`, inline: true }
            )
            .setTimestamp();

        if (currentTier < maxTiers) {
            embed.addFields({
                name: 'To Next Tier',
                value: `${xpPerTier - xpIntoTier} XP needed`,
                inline: true
            });
        }

        await interaction.reply({ embeds: [embed], ephemeral: target.id !== interaction.user.id });
    }
};

function buildBar(current, target, length = 12) {
    const filled = Math.round((current / target) * length);
    return '[' + '█'.repeat(Math.min(filled, length)) + '░'.repeat(Math.max(length - filled, 0)) + ']';
}
