const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const { isValidTimezone, formatLocalTime } = require('../../utils/timezones');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timezone')
        .setDescription('Set your timezone so reminders and times are computed correctly for you')
        .addSubcommand(sub => sub
            .setName('set')
            .setDescription('Set your IANA timezone (e.g. America/New_York, Europe/London)')
            .addStringOption(o => o.setName('timezone')
                .setDescription('IANA timezone name')
                .setRequired(true)))
        .addSubcommand(sub => sub
            .setName('show')
            .setDescription('Show your currently set timezone'))
        .addSubcommand(sub => sub
            .setName('clear')
            .setDescription('Clear your timezone')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            const tz = interaction.options.getString('timezone', true).trim();
            if (!isValidTimezone(tz)) {
                return interaction.reply({
                    content: `"${tz}" isn't a valid IANA timezone. Examples: \`America/New_York\`, \`Europe/London\`, \`Asia/Tokyo\`.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            if (!user) user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
            user.timezone = tz;
            await user.save();

            const localTime = formatLocalTime(new Date(), tz);
            return interaction.reply({
                content: `✅ Timezone set to \`${tz}\`. Your local time is currently **${localTime}**.`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (sub === 'clear') {
            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $set: { timezone: null } }
            );
            return interaction.reply({ content: '✅ Timezone cleared.', flags: MessageFlags.Ephemeral });
        }

        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user?.timezone) {
            return interaction.reply({
                content: 'You haven\'t set a timezone yet. Use `/timezone set` — this helps reminders fire at the right time for you.',
                flags: MessageFlags.Ephemeral
            });
        }
        return interaction.reply({
            content: `Your timezone is \`${user.timezone}\` (local time: **${formatLocalTime(new Date(), user.timezone)}**).`,
            flags: MessageFlags.Ephemeral
        });
    }
};
