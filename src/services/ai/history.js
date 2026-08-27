const Conversation = require('../../models/Conversation');

// Per-user, per-channel conversation history for the AI chat loop.

async function loadHistory(guildId, channelId, userId, max) {
    if (!max || max <= 0) return { doc: null, messages: [] };
    const doc = await Conversation.findOne({ guildId, channelId, userId });
    if (!doc) return { doc: null, messages: [] };
    const msgs = doc.messages.slice(-max).map(m => ({ role: m.role, content: m.content }));
    return { doc, messages: msgs };
}

async function appendHistory(guildId, channelId, userId, userText, assistantText, max) {
    if (!max || max <= 0) return;
    let doc = await Conversation.findOne({ guildId, channelId, userId });
    if (!doc) {
        doc = new Conversation({ guildId, channelId, userId, messages: [] });
    }
    doc.messages.push({ role: 'user', content: userText });
    doc.messages.push({ role: 'assistant', content: assistantText });
    // Retain exactly what loadHistory reads: `max` messages. Keeping more
    // would persist turns no request ever loads (#823).
    if (doc.messages.length > max) {
        doc.messages = doc.messages.slice(-max);
    }
    await doc.save();
}

async function clearHistory(guildId, channelId, userId) {
    await Conversation.deleteOne({ guildId, channelId, userId });
}

module.exports = { loadHistory, appendHistory, clearHistory };
