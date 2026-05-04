const Guild = require('../models/Guild');
const User = require('../models/User');

function calculateAge(year, now) {
    if (!year) return null;
    const age = now.getUTCFullYear() - year;
    return age > 0 ? age : null;
}

async function checkBirthdays(client) {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const hour = now.getUTCHours();

    const guilds = await Guild.find({
        'birthdays.enabled': true,
        'birthdays.channelId': { $ne: null },
        'birthdays.wishingHourUtc': hour
    });

    for (const settings of guilds) {
        const guild = client.guilds.cache.get(settings.guildId);
        if (!guild) continue;

        const channel = guild.channels.cache.get(settings.birthdays.channelId);
        if (!channel || !channel.isTextBased()) continue;

        const users = await User.find({
            guildId: settings.guildId,
            'birthday.month': month,
            'birthday.day': day,
            $or: [
                { 'birthday.lastCelebratedYear': { $ne: now.getUTCFullYear() } },
                { 'birthday.lastCelebratedYear': { $exists: false } }
            ]
        });

        for (const u of users) {
            const member = await guild.members.fetch(u.userId).catch(() => null);
            if (!member) continue;

            const age = calculateAge(u.birthday?.year, now);
            const template = settings.birthdays.message || "It's the birthday of {user} ({age}) ! 🎂";
            const content = template
                .replace(/{user}/g, `<@${u.userId}>`)
                .replace(/{age}/g, age ? String(age) : '?');

            await channel.send({ content }).catch(() => null);

            if (settings.birthdays.roleId && member.roles.cache.has(settings.birthdays.roleId) === false) {
                await member.roles.add(settings.birthdays.roleId).catch(() => null);
            }

            u.birthday.lastCelebratedYear = now.getUTCFullYear();
            await u.save();
        }
    }
}

module.exports = { checkBirthdays };
