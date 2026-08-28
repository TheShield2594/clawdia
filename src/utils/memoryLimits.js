// Shared caps for long-term AI memories, whoever writes them: the 📌 reaction
// (src/events/messageReactionAdd.js), `/ai memories`, and the model's own
// save_memory tool (src/services/ai/botTools.js).
module.exports = {
    // Every memory is injected into the system prompt of every AI reply, so the
    // cap is a token budget as much as a storage one.
    MEMORY_CAP: 10,
    MAX_MEMORY_LENGTH: 500
};
