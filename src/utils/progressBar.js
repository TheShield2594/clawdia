/**
 * Generates a Unicode block progress bar.
 * @param {number} current - Current value
 * @param {number} max - Maximum value
 * @param {number} length - Bar length in characters (default 20)
 * @returns {string} e.g. "████████████░░░░░░░░"
 */
function progressBar(current, max, length = 20) {
    if (max <= 0) return '█'.repeat(length);
    const clamped = Math.min(current, max);
    const filled = Math.round((clamped / max) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}

module.exports = { progressBar };
