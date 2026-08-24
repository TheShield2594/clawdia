const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Guild = require('../../models/Guild');
// Drawing, ending and entrant handling live in the service — `/giveaway end`
// and the scheduled sweep are two callers of one operation (#614).
const { endGiveaway, parseDuration, pickWinners, getEntrants } = require('../../services/giveawayService');
const COLORS = require('../../utils/embedColors');

const GIVEAWAY_EMOJI = '🎉';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Manage giveaways')
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Start a giveaway')
                .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
                .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 30m, 2d').setRequired(true))
                .addIntegerOption(o => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20)))
        .addSubcommand(sub =>
            sub.setName('end')
                .setDescription('End a giveaway early')
                .addStringOption(o => o.setName('message_id').setDescription('Message ID of the giveaway').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('reroll')
                .setDescription('Reroll winners for an ended giveaway')
                .addStringOption(o => o.setName('message_id').setDescription('Message ID of the giveaway').setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.ManageGuild],
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'start') {
            const prize = interaction.options.getString('prize');
            const durationStr = interaction.options.getString('duration');
            const winnersCount = interaction.options.getInteger('winners') ?? 1;

            const durationMs = parseDuration(durationStr);
            if (!durationMs) {
                return interaction.reply({ content: 'Invalid duration. Use formats like `30m`, `2h`, `1d`.', flags: MessageFlags.Ephemeral });
            }

            const endsAt = new Date(Date.now() + durationMs);

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle(`${GIVEAWAY_EMOJI} GIVEAWAY ${GIVEAWAY_EMOJI}`)
                .setDescription(`**Prize:** ${prize}\n\nClick the button below to enter!`)
                .addFields(
                    { name: 'Winners', value: winnersCount.toString(), inline: true },
                    { name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true },
                    { name: 'Hosted by', value: interaction.user.toString(), inline: true }
                )
                .setTimestamp(endsAt)
                .setFooter({ text: 'Ends at' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('giveaway_enter')
                    .setLabel('Enter Giveaway')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji(GIVEAWAY_EMOJI)
            );

            await interaction.reply({ content: 'Giveaway started!', flags: MessageFlags.Ephemeral });
            const msg = await interaction.channel.send({ embeds: [embed], components: [row] });

            guildSettings.giveaways.push({
                messageId: msg.id,
                channelId: interaction.channel.id,
                prize,
                winners: winnersCount,
                endsAt,
                hostId: interaction.user.id,
                ended: false,
                winnerIds: []
            });
            await guildSettings.save();

        } else if (sub === 'end') {
            const messageId = interaction.options.getString('message_id');
            const ga = guildSettings.giveaways.find(g => g.messageId === messageId);

            if (!ga) return interaction.reply({ content: 'Giveaway not found.', flags: MessageFlags.Ephemeral });
            if (ga.ended) return interaction.reply({ content: 'That giveaway has already ended.', flags: MessageFlags.Ephemeral });

            await endGiveaway(interaction.client, guildSettings, ga);
            await guildSettings.save();
            await interaction.reply({ content: 'Giveaway ended.', flags: MessageFlags.Ephemeral });

        } else if (sub === 'reroll') {
            const messageId = interaction.options.getString('message_id');
            const ga = guildSettings.giveaways.find(g => g.messageId === messageId && g.ended);

            if (!ga) return interaction.reply({ content: 'Ended giveaway not found.', flags: MessageFlags.Ephemeral });

            const entrants = getEntrants(ga);
            if (!entrants.length) return interaction.reply({ content: 'No valid entrants to reroll from.', flags: MessageFlags.Ephemeral });

            const newWinners = pickWinners(entrants, ga.winners);
            ga.winnerIds = newWinners;
            await guildSettings.save();

            await interaction.reply({
                content: `🎉 New winner${newWinners.length > 1 ? 's' : ''}: ${newWinners.map(id => `<@${id}>`).join(', ')}!`
            });
        }
    }
};
