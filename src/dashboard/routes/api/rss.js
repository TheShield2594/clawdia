const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const Parser = require('rss-parser');
const { safeFetchFeed } = require('../../../utils/safeFeedFetch');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId } = require('../../lib/apiHelpers');

/**
 * The guild's feeds in the shape the dashboard's list renders from.
 *
 * Both mutations answer with the whole list rather than just the row that
 * changed (#689). The page patches its list in place instead of reloading, and
 * the feeds are addressed by *position* — so a client holding only its own idea
 * of the order is a client whose next delete removes the wrong feed. Handing
 * back the array the server just saved keeps the two in step for the cost of a
 * few hundred bytes on a request that was already round-tripping.
 */
function feedList(guildSettings) {
    return (guildSettings.rssFeeds || []).map(feed => ({ url: feed.url, channelId: feed.channelId }));
}


// Checks that a URL is a fetchable RSS or Atom feed before it is subscribed to.
// The one write on the router that had no rate limit, and the one that reaches
// out to a caller-supplied URL — an admin looping it turns the bot into an
// outbound fetcher on someone else's behalf.
router.post('/guild/:guildId/validate-feed', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ valid: false, error: 'No URL provided.' });
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return res.json({ valid: false, error: 'Invalid URL format.' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.json({ valid: false, error: 'URL must use http or https.' });
    }

    try {
        const body = await safeFetchFeed(url);
        const feedParser = new Parser();
        const feed = await feedParser.parseString(body);
        return res.json({ valid: true, title: feed.title || '', itemCount: feed.items?.length ?? 0 });
    } catch (err) {
        return res.json({ valid: false, error: err.message || 'Could not fetch or parse feed. Check the URL and ensure it is a valid RSS/Atom feed.' });
    }
});

// Subscribes a channel to an RSS or Atom feed.
router.post('/guild/:guildId/rss/add', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { url, channelId } = req.body;

    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
    if (!channelId || !isValidDiscordId(channelId)) return res.status(400).json({ error: 'channelId must be a valid Discord snowflake' });

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return res.status(400).json({ error: 'url must be a valid URL' });
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: 'url must use http or https' });
    }

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        guildSettings.rssFeeds.push({ url: url.trim(), channelId });
        await guildSettings.save();

        res.json({ success: true, feeds: feedList(guildSettings) });
    } catch (error) {
        console.error('RSS add error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const dailyNewsInFlight = new Set();
// Sends the configured daily news digest now, refusing while one is already in flight.
router.post('/guild/:guildId/dailynews/trigger', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    if (dailyNewsInFlight.has(guildId)) {
        return res.status(409).json({ error: 'A digest is already being sent for this guild. Please wait for it to finish.' });
    }
    dailyNewsInFlight.add(guildId);
    try {
        await req.bot.sendDailyNews(guildId);
        res.json({ success: true });
    } catch (error) {
        console.error('Daily news manual trigger error:', error);
        res.status(500).json({ error: 'Failed to send daily news. Check that the digest is configured.' });
    } finally {
        dailyNewsInFlight.delete(guildId);
    }
});

// Unsubscribes from the feed at a position in the guild's feed list.
router.delete('/guild/:guildId/rss/:index', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, index } = req.params;

    // `splice(NaN, 1)` removes element 0, so an unparseable index used to
    // delete the *first* feed rather than none of them — and a request for a
    // position past the end used to answer 200 having changed nothing, which
    // the page then took as its cue to drop a row that is still subscribed.
    // Both are checked now that the list is patched in place rather than
    // re-rendered from the database on the next load (#689).
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0) {
        return res.status(400).json({ error: 'index must be a non-negative integer' });
    }

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });
        if (position >= (guildSettings.rssFeeds || []).length) {
            return res.status(404).json({ error: 'No feed at that position. Reload the page and try again.' });
        }

        guildSettings.rssFeeds.splice(position, 1);
        await guildSettings.save();

        res.json({ success: true, feeds: feedList(guildSettings) });
    } catch (error) {
        console.error('RSS delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
