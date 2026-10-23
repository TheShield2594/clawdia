const { Schema, model } = require('mongoose');

// Every AI turn a member had, kept so the model can search it later
// (`search_conversations` in services/ai/agentTools.js). `Conversation` keeps
// only the last few turns per channel plus a rolling summary, which is what a
// reply needs as context but not what "what did I decide about the trip last
// month?" needs. Written only for a guild that switched conversation search on
// (`ai.conversationSearch`), and only ever searched by the member it belongs to.
const conversationLogSchema = new Schema({
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    channelId: { type: String, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

conversationLogSchema.index({ guildId: 1, userId: 1, createdAt: -1 });
// Equality prefix first, so a $text search is scoped to one member's turns.
conversationLogSchema.index({ guildId: 1, userId: 1, content: 'text' });
// A year of history is the useful part of it; past that it is a liability.
conversationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = model('ConversationLog', conversationLogSchema);
