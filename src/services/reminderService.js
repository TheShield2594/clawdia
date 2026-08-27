const Reminder = require('../models/Reminder');
const { addCalendarDays } = require('../utils/timezones');

const REPEAT_INTERVAL_DAYS = {
    daily: 1,
    weekly: 7
};

// How many failed deliveries a reminder survives before it is given up on.
// The scheduler ticks every minute, so this is about five minutes of retrying
// a channel and DM that both refuse the message — long enough to ride out a
// Discord hiccup, short enough that a permanently dead destination does not
// keep a reminder due forever.
const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * The next occurrence strictly after `now`.
 *
 * After downtime a repeating reminder can be several intervals behind, and
 * advancing one interval per delivery replays every missed occurrence — a
 * daily reminder that missed three days fires three times in three consecutive
 * ticks (#817). The missed occurrences are skipped instead: one delivery, then
 * straight to the next future one.
 */
function nextOccurrence(from, intervalDays, timezone, now) {
    let next = addCalendarDays(from, intervalDays, timezone);
    while (next.getTime() <= now.getTime()) {
        next = addCalendarDays(next, intervalDays, timezone);
    }
    return next;
}

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
                const delivered = await deliver(client, reminder);

                if (!delivered) {
                    // Both the channel and the DM refused it. Leave the
                    // reminder due so the next tick retries, but count the
                    // attempt: a destination that is dead rather than
                    // hiccuping is given up on below, not retried forever.
                    reminder.deliveryAttempts = (reminder.deliveryAttempts || 0) + 1;
                    if (reminder.deliveryAttempts < MAX_DELIVERY_ATTEMPTS) {
                        await reminder.save();
                        continue;
                    }
                    console.error(`Giving up on reminder ${reminder._id} after ${MAX_DELIVERY_ATTEMPTS} failed delivery attempts`);
                }

                reminder.deliveryAttempts = 0;
                const intervalDays = REPEAT_INTERVAL_DAYS[reminder.repeatInterval];
                if (intervalDays) {
                    reminder.remindAt = nextOccurrence(reminder.remindAt, intervalDays, reminder.timezone || 'Etc/UTC', now);
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
