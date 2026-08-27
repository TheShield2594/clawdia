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
    // What the turns that fell out of `messages` said (#833). Everything past
    // the retention window used to be dropped on the floor: a conversation
    // twenty messages long began each reply as though it had just started.
    // Rewritten on each trim from the previous summary plus the turns being
    // dropped, so it stays one paragraph however long the conversation runs.
    summary: { type: String, default: null },
    summarizedThrough: { type: Date, default: null },
    updatedAt: { type: Date, default: Date.now }
});

conversationSchema.index({ guildId: 1, channelId: 1, userId: 1 }, { unique: true });

conversationSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('Conversation', conversationSchema);
