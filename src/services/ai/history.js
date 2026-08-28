const Conversation = require('../../models/Conversation');

// Per-user, per-channel conversation history for the AI chat loop, and the
// rolling summary of everything that has fallen out of it (#833).
//
// The retention window is the guild's `maxHistory`, and what it drops used to be
// dropped outright: a conversation past twenty messages started every reply as
// though the earlier half had never happened. Now the turns being trimmed are
// handed to a summarizer the caller supplies, and what comes back is stored on
// the conversation and injected ahead of the messages next time.
//
// The summarizer is a callback rather than a provider call made here, for two
// reasons: this module is storage, with no idea which provider or which guild's
// limits apply, and a caller that has no cheap model to spend — a test, a
// command — should be able to trim without one.

// A summary is injected into every subsequent request in this conversation, so
// its size is a per-message cost for as long as the conversation lives.
const MAX_SUMMARY_CHARS = 1200;

async function loadHistory(guildId, channelId, userId, max) {
    if (!max || max <= 0) return { doc: null, messages: [], summary: null };
    const doc = await Conversation.findOne({ guildId, channelId, userId });
    if (!doc) return { doc: null, messages: [], summary: null };
    const msgs = doc.messages.slice(-max).map(m => ({ role: m.role, content: m.content }));
    return { doc, messages: msgs, summary: doc.summary || null };
}

/**
 * Store this turn, trim to the retention window, and summarise what fell out.
 *
 * `summarize({ summary, dropped })` is given the previous summary and the turns
 * about to be lost, and returns the replacement — one paragraph covering both,
 * so the summary stays a fixed cost however long the conversation runs. It is
 * best-effort in every direction: it is called after the reply has already been
 * sent, and a summary is worth less than the turn it would fail.
 *
 * @param {Function} [summarize] async ({summary, dropped}) => string|null
 */
async function appendHistory(guildId, channelId, userId, userText, assistantText, max, summarize) {
    if (!max || max <= 0) return;
    let doc = await Conversation.findOne({ guildId, channelId, userId });
    if (!doc) {
        doc = new Conversation({ guildId, channelId, userId, messages: [] });
    }
    doc.messages.push({ role: 'user', content: userText });
    doc.messages.push({ role: 'assistant', content: assistantText });

    // Retain exactly what loadHistory reads: `max` messages. Keeping more
    // would persist turns no request ever loads (#823).
    let dropped = [];
    if (doc.messages.length > max) {
        dropped = doc.messages.slice(0, doc.messages.length - max)
            .map(m => ({ role: m.role, content: m.content }));
        doc.messages = doc.messages.slice(-max);
    }

    if (dropped.length && typeof summarize === 'function') {
        try {
            const next = await summarize({ summary: doc.summary || null, dropped });
            if (typeof next === 'string' && next.trim()) {
                doc.summary = next.trim().slice(0, MAX_SUMMARY_CHARS);
                doc.summarizedThrough = new Date();
            }
        } catch (err) {
            // The reply is already in the channel. A conversation that keeps
            // its last `max` turns and loses the older ones is what happened
            // before this existed, so failing back to it costs nothing.
            console.warn(`[AI history] summarization failed: ${err.message}`);
        }
    }

    await doc.save();
}

async function clearHistory(guildId, channelId, userId) {
    await Conversation.deleteOne({ guildId, channelId, userId });
}

module.exports = { loadHistory, appendHistory, clearHistory, MAX_SUMMARY_CHARS };
