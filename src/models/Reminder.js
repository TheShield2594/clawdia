const { Schema, model } = require('mongoose');

const reminderSchema = new Schema({
    userId: { type: String, required: true },
    guildId: { type: String, default: null },
    channelId: { type: String, required: true },
    message: { type: String, required: true },
    remindAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
    completed: { type: Boolean, default: false }
});

module.exports = model('Reminder', reminderSchema);