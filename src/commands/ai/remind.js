const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const Reminder = require('../../models/Reminder');
const User = require('../../models/User');
const { parseAtOption } = require('../../utils/timezones');
const { MAX_REMINDER_MINUTES: MAX_MINUTES, MAX_OPEN_REMINDERS, MAX_REMINDER_MESSAGE_LENGTH } = require('../../utils/reminderLimits');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Set a reminder — posted in this channel when it fires. Combine minutes, hours, and/or days.')
        .addStringOption(option =>
            option.setName('message')
                .setDescription(`What to remind you about. Max ${MAX_REMINDER_MESSAGE_LENGTH} characters.`)
                .setMaxLength(MAX_REMINDER_MESSAGE_LENGTH)
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('minutes')
                .setDescription('Minutes from now (min: 1). Combine with hours/days for longer durations.')
                .setRequired(false)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('hours')
                .setDescription('Hours from now (min: 1). Combine with minutes/days.')
                .setRequired(false)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('days')
                .setDescription('Days from now (min: 1). Combine with hours/minutes.')
                .setRequired(false)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('at')
                .setDescription('Absolute time instead of minutes/hours/days, e.g. "17:00", "5pm", "2026-07-20 09:00"')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('every')
                .setDescription('Repeat this reminder on a cadence')
                .setRequired(false)
                .addChoices(
                    { name: 'Daily', value: 'daily' },
                    { name: 'Weekly', value: 'weekly' }
                )),
    async execute(interaction) {
        const message = interaction.options.getString('message');
        const minutes = interaction.options.getInteger('minutes') || 0;
        const hours = interaction.options.getInteger('hours') || 0;
        const days = interaction.options.getInteger('days') || 0;
        const at = interaction.options.getString('at');
        const every = interaction.options.getString('every');

        if (message.length > MAX_REMINDER_MESSAGE_LENGTH) {
            return interaction.reply({
                content: `Reminder message must be ${MAX_REMINDER_MESSAGE_LENGTH} characters or fewer.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const hasRelative = minutes !== 0 || hours !== 0 || days !== 0;
        if (hasRelative && at) {
            return interaction.reply({ content: 'Use either `at` or minutes/hours/days, not both.', flags: MessageFlags.Ephemeral });
        }
        if (!hasRelative && !at) {
            return interaction.reply({ content: 'Please specify at least one time unit, or use `at` for an absolute time!', flags: MessageFlags.Ephemeral });
        }

        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild?.id });
        const timezone = user?.timezone || 'Etc/UTC';

        let remindAt;
        if (at) {
            remindAt = parseAtOption(at, timezone);
            if (!remindAt) {
                return interaction.reply({
                    content: `Couldn't parse "${at}". Try a format like \`17:00\`, \`5pm\`, or \`2026-07-20 09:00\`.`,
                    flags: MessageFlags.Ephemeral
                });
            }
            if (remindAt.getTime() <= Date.now()) {
                return interaction.reply({ content: 'That time is in the past — please pick a future time.', flags: MessageFlags.Ephemeral });
            }
        } else {
            const totalMinutes = minutes + (hours * 60) + (days * 1440);
            if (totalMinutes > MAX_MINUTES) {
                return interaction.reply({ content: 'Reminders can be set at most 1 year out.', flags: MessageFlags.Ephemeral });
            }
            remindAt = new Date(Date.now() + totalMinutes * 60000);
        }

        if (remindAt.getTime() - Date.now() > MAX_MINUTES * 60000) {
            return interaction.reply({ content: 'Reminders can be set at most 1 year out.', flags: MessageFlags.Ephemeral });
        }

        const openCount = await Reminder.countDocuments({ userId: interaction.user.id, completed: false });
        if (openCount >= MAX_OPEN_REMINDERS) {
            return interaction.reply({
                content: `You already have ${MAX_OPEN_REMINDERS} open reminders — cancel one with \`/reminders cancel\` before adding more.`,
                flags: MessageFlags.Ephemeral
            });
        }

        try {
            await Reminder.create({
                userId: interaction.user.id,
                guildId: interaction.guild?.id,
                channelId: interaction.channel.id,
                message: message,
                remindAt: remindAt,
                repeatInterval: every || null,
                timezone
            });

            const epoch = Math.floor(remindAt.getTime() / 1000);
            const cadence = every ? ` (repeating **${every}**)` : '';
            const tzNote = !user?.timezone && at ? '\n_Tip: set `/timezone set` so absolute times use your local time instead of UTC._' : '';
            await interaction.reply(`✅ I'll remind you about "${message}"${cadence} on <t:${epoch}:F> (<t:${epoch}:R>)${tzNote}`);
        } catch (error) {
            console.error('Reminder error:', error);
            await interaction.reply({ content: 'Failed to create reminder.', flags: MessageFlags.Ephemeral });
        }
    }
};
