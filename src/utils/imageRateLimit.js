const cooldowns = new Map();
const MAX_USES = 10;
const WINDOW_MS = 60_000;

// Evict entries whose timestamps have all expired to prevent unbounded growth
setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [userId, stamps] of cooldowns) {
        if (stamps.every(t => t < cutoff)) cooldowns.delete(userId);
    }
}, 5 * 60_000).unref();

function checkImageRateLimit(userId) {
    const now    = Date.now();
    const stamps = (cooldowns.get(userId) || []).filter(t => now - t < WINDOW_MS);
    if (stamps.length >= MAX_USES) {
        cooldowns.set(userId, stamps);
        const wait = Math.ceil((WINDOW_MS - (now - stamps[0])) / 1000);
        return { limited: true, message: `⏱️ You're using image commands too fast! Please wait **${wait}s** before trying again.` };
    }
    stamps.push(now);
    cooldowns.set(userId, stamps);
    return { limited: false };
}

module.exports = { checkImageRateLimit };
