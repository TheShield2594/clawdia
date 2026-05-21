const cooldowns = new Map();
const MAX_USES = 10;
const WINDOW_MS = 60_000;

function checkImageRateLimit(userId) {
    const now = Date.now();
    const stamps = (cooldowns.get(userId) || []).filter(t => now - t < WINDOW_MS);
    if (stamps.length >= MAX_USES) {
        const wait = Math.ceil((WINDOW_MS - (now - stamps[0])) / 1000);
        return { limited: true, wait };
    }
    stamps.push(now);
    cooldowns.set(userId, stamps);
    return { limited: false };
}

module.exports = { checkImageRateLimit };
