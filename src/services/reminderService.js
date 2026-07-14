const Reminder = require('../models/Reminder');

const REPEAT_INTERVAL_MS = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000
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

                const intervalMs = REPEAT_INTERVAL_MS[reminder.repeatInterval];
                if (intervalMs) {
                    reminder.remindAt = new Date(reminder.remindAt.getTime() + intervalMs);
                } else {
                    reminder.completed = true;
                }
                await reminder.save();
            } catch (error) {
                console.error('Error processing reminder:', error);
                reminder.completed = true;
                await reminder.save();
            }
        }
    } catch (error) {
        console.error('Error checking reminders:', error);
    }
}

module.exports = { checkReminders };
