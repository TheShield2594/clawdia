const Reminder = require('../models/Reminder');

async function checkReminders(client) {
    try {
        const now = new Date();
        const dueReminders = await Reminder.find({
            remindAt: { $lte: now },
            completed: false
        });

        for (const reminder of dueReminders) {
            try {
                const channel = client.channels.cache.get(reminder.channelId);
                
                if (channel) {
                    await channel.send(`🔔 <@${reminder.userId}> Reminder: ${reminder.message}`);
                }

                reminder.completed = true;
                await reminder.save();
            } catch (error) {
                console.error('Error sending reminder:', error);
                reminder.completed = true;
                await reminder.save();
            }
        }
    } catch (error) {
        console.error('Error checking reminders:', error);
    }
}

module.exports = { checkReminders };