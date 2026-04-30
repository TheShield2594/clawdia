const { Schema, model } = require('mongoose');

const conversationSchema = new Schema({
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    messages: [{
        role: { type: String, enum: ['user', 'assistant'], required: true },
        content: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
    }],
    updatedAt: { type: Date, default: Date.now }
});

conversationSchema.index({ guildId: 1, channelId: 1, userId: 1 }, { unique: true });

conversationSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('Conversation', conversationSchema);
