// Shared caps for long-term AI memories, whoever writes them: the 📌 reaction
// (src/events/messageReactionAdd.js), `/ai memories`, and the model's own
// save_memory tool (src/services/ai/botTools.js).
const MEMORY_CAP = 10;

// The most a guild may raise its cap to (`ai.memory.cap`). Every memory is
// injected into every reply, so fifty of them at the length limit below is
// about six thousand tokens of standing context — already a lot to put in front
// of a small model on every message.
const MAX_MEMORY_CAP = 50;

/**
 * The per-member memory cap a guild has chosen, or the default.
 *
 * Clamped here as well as by the schema, because the settings reach callers as
 * plain objects from a cache that does not run validators.
 *
 * @param {object} [aiSettings] a guild's `ai` settings
 * @returns {number}
 */
function memoryCapFor(aiSettings) {
    const raw = Number(aiSettings?.memory?.cap);
    if (!Number.isInteger(raw) || raw < 1) return MEMORY_CAP;
    return Math.min(raw, MAX_MEMORY_CAP);
}

module.exports = {
    // Every memory is injected into the system prompt of every AI reply, so the
    // cap is a token budget as much as a storage one.
    MEMORY_CAP,
    MAX_MEMORY_CAP,
    MAX_MEMORY_LENGTH: 500,
    memoryCapFor
};
