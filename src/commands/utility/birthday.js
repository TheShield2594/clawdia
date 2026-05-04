const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const User = require('../../models/User');

function isValidDate(month, day, year) {
    const d = new Date(Date.UTC(year || 2000, month - 1, day));
    return d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
}

function formatBirthday(birthday) {
    if (!birthday?.month || !birthday?.day) return 'Not set';
    return `${birthday.month}/${birthday.day}${birthday.year ? `/${birthday.year}` : ''}`;
}

function daysUntilBirthday(month, day, now) {
    const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let next = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day));
    if (next < current) next = new Date(Date.UTC(now.getUTCFullYear() + 1, month - 1, day));
    return Math.round((next - current) / 86400000);
}

async function upsertBirthday(guildId, userId, month, day, year) {
    let user = await User.findOne({ guildId, userId });
    if (!user) user = await User.create({ guildId, userId });
    user.birthday = {
        ...(user.birthday || {}),
        month,
        day,
        year: year || null,
        lastCelebratedYear: null
    };
    await user.save();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('birthday')
        .setDescription('Manage birthdays')
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add your birthday')
            .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
            .addIntegerOption(o => o.setName('day').setDescription('Day').setRequired(true).setMinValue(1).setMaxValue(31))
            .addIntegerOption(o => o.setName('year').setDescription('Birth year (optional)').setMinValue(1900).setMaxValue(2100)))
        .addSubcommand(sub => sub
            .setName('set')
            .setDescription('Set another member birthday')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
            .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
            .addIntegerOption(o => o.setName('day').setDescription('Day').setRequired(true).setMinValue(1).setMaxValue(31))
            .addIntegerOption(o => o.setName('year').setDescription('Birth year (optional)').setMinValue(1900).setMaxValue(2100)))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove your birthday'))
        .addSubcommand(sub => sub
            .setName('removeuser')
            .setDescription('Remove another member birthday')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('show')
            .setDescription('Show birthday for yourself or another member')
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(false)))
        .addSubcommand(sub => sub
            .setName('next')
            .setDescription('Show next 5 upcoming birthdays')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add' || sub === 'set') {
            const target = sub === 'set' ? interaction.options.getUser('user', true) : interaction.user;
            if (sub === 'set' && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'You need Manage Server to set another member birthday.', ephemeral: true });
            }

            const month = interaction.options.getInteger('month', true);
            const day = interaction.options.getInteger('day', true);
            const year = interaction.options.getInteger('year');
            if (!isValidDate(month, day, year || 2000)) {
                return interaction.reply({ content: 'Invalid date provided.', ephemeral: true });
            }

            await upsertBirthday(interaction.guild.id, target.id, month, day, year);
            return interaction.reply({ content: `✅ Birthday saved for ${target}: ${month}/${day}${year ? `/${year}` : ''}`, ephemeral: true });
        }

        if (sub === 'remove' || sub === 'removeuser') {
            const target = sub === 'removeuser' ? interaction.options.getUser('user', true) : interaction.user;
            if (sub === 'removeuser' && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'You need Manage Server to remove another member birthday.', ephemeral: true });
            }

            const user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
            if (!user) return interaction.reply({ content: `No birthday found for ${target}.`, ephemeral: true });
            user.birthday = { month: null, day: null, year: null, lastCelebratedYear: null };
            await user.save();
            return interaction.reply({ content: `✅ Birthday removed for ${target}.`, ephemeral: true });
        }

        if (sub === 'show') {
            const target = interaction.options.getUser('user') || interaction.user;
            const user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
            if (!user?.birthday?.month || !user?.birthday?.day) {
                return interaction.reply({ content: `No birthday is set for ${target}.`, ephemeral: true });
            }
            return interaction.reply({ content: `🎂 ${target}'s birthday: ${formatBirthday(user.birthday)}`, ephemeral: true });
        }

        const all = await User.find({ guildId: interaction.guild.id, 'birthday.month': { $ne: null }, 'birthday.day': { $ne: null } });
        if (!all.length) return interaction.reply({ content: 'No birthdays have been set yet.', ephemeral: true });

        const now = new Date();
        const ranked = all
            .map(u => ({ ...u.toObject(), daysLeft: daysUntilBirthday(u.birthday.month, u.birthday.day, now) }))
            .sort((a, b) => a.daysLeft - b.daysLeft)
            .slice(0, 5);

        const lines = ranked.map((u, i) => `${i + 1}. <@${u.userId}> — ${formatBirthday(u.birthday)} (${u.daysLeft} day${u.daysLeft === 1 ? '' : 's'})`);
        return interaction.reply({ content: `🎉 **Next 5 Birthdays**\n${lines.join('\n')}`, ephemeral: true });
    }
};
