const Reminder = require('../models/Reminder');
const { addCalendarDays } = require('../utils/timezones');

const REPEAT_INTERVAL_DAYS = {
    daily: 1,
    weekly: 7
};

async function getChannel(client, channelId) {
    const cached = client.channels.cache.get(channelId);
    if (cached) return cached;
    try {
        return await client.channels.fetch(channelId);
    } catch {
        return null;
    }
}

async function deliver(client, reminder) {
    const text = `🔔 <@${reminder.userId}> Reminder: ${reminder.message}`;

    const channel = await getChannel(client, reminder.channelId);
    if (channel) {
        try {
            await channel.send(text);
            return true;
        } catch (error) {
            console.error(`Error sending reminder to channel ${reminder.channelId}, falling back to DM:`, error.message);
        }
    }

    try {
        const user = await client.users.fetch(reminder.userId);
        await user.send(`🔔 Reminder (from a channel I could no longer post in): ${reminder.message}`);
        return true;
    } catch (error) {
        console.error(`Error DMing reminder to user ${reminder.userId}:`, error.message);
        return false;
    }
}

async function checkReminders(client) {
    try {
        const now = new Date();
        const dueReminders = await Reminder.find({
            remindAt: { $lte: now },
            completed: false
        });

        for (const reminder of dueReminders) {
            try {
                await deliver(client, reminder);

                const intervalDays = REPEAT_INTERVAL_DAYS[reminder.repeatInterval];
                if (intervalDays) {
                    reminder.remindAt = addCalendarDays(reminder.remindAt, intervalDays, reminder.timezone || 'Etc/UTC');
                } else {
                    reminder.completed = true;
                }
                await reminder.save();
            } catch (error) {
                // Don't retry the save here — a persistent failure (not just this one
                // reminder's) would throw again and abort the whole loop, silently
                // dropping every reminder after it. Leaving this one unmarked means
                // it's picked up again next tick instead of being lost.
                console.error('Error processing reminder:', error);
            }
        }
    } catch (error) {
        console.error('Error checking reminders:', error);
    }
}

module.exports = { checkReminders };
