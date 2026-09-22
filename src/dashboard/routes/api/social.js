const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const Parser = require('rss-parser');
const { safeFetchFeed } = require('../../../utils/safeFeedFetch');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId } = require('../../lib/apiHelpers');
const { PLATFORMS, resolveSocialTarget, getBridgeOrigin } = require('../../../services/socialProviders');
const { loadXSource } = require('../../../services/socialService');

/**
 * The guild's social subscriptions in the shape the dashboard list renders from.
 *
 * Both mutations answer with the whole list rather than the one row that
 * changed, for the same reason the RSS routes do (#689): the page patches its
 * position-addressed list in place, and handing back the array the server just
 * saved keeps the two in step so the next delete removes the right row.
 */
function socialList(guildSettings) {
    return (guildSettings.socialFeeds || []).map(f => ({
        platform: f.platform,
        ref: f.ref,
        feedUrl: f.feedUrl,
        channelId: f.channelId,
    }));
}

// resolveSocialTarget reaches out to a caller-supplied URL for some platforms
// (YouTube handle resolution reads the channel page), so validation and add are
// both rate-limited like the RSS validate route — an admin must not be able to
// loop the bot into fetching on someone else's behalf.

// Resolves what the admin pasted to a feed URL and confirms it parses, before
// they commit to it. Returns the normalised ref and a preview of the feed.
router.post('/guild/:guildId/social/validate', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { platform, input } = req.body;
    if (!PLATFORMS.includes(platform)) {
        return res.status(400).json({ valid: false, error: 'Unknown platform.' });
    }

    let target;
    try {
        target = await resolveSocialTarget(platform, input);
    } catch (err) {
        // resolveSocialTarget throws admin-readable messages (bad input, missing
        // bridge) — safe to surface directly.
        return res.json({ valid: false, error: err.message });
    }

    // An X account is read the way the sweep reads it — FxTwitter's timeline,
    // then the bridge — so Test answers for the source that will actually post.
    if (target.platform === 'twitter') {
        try {
            const { parsedFeed, entries } = await loadXSource(target.ref.replace(/^@/, ''), getBridgeOrigin(), [target.feedUrl]);
            return res.json({
                valid: true,
                ref: target.ref,
                feedUrl: target.feedUrl,
                title: parsedFeed.title || '',
                itemCount: entries.length,
            });
        } catch (err) {
            return res.json({
                valid: false,
                ref: target.ref,
                error: err.message || 'Could not read that X account. Check it exists and is public.',
            });
        }
    }

    try {
        // Bridge feeds live on the operator-configured bridge origin, which may be
        // a Docker-network host; permit that one origin through the SSRF guard so
        // Test works for X/Instagram/TikTok, exactly as the poller does.
        const body = await safeFetchFeed(target.feedUrl, { allowPrivateOrigin: getBridgeOrigin() });
        const feedParser = new Parser();
        const feed = await feedParser.parseString(body);
        return res.json({
            valid: true,
            ref: target.ref,
            feedUrl: target.feedUrl,
            title: feed.title || '',
            itemCount: feed.items?.length ?? 0,
        });
    } catch (err) {
        return res.json({
            valid: false,
            ref: target.ref,
            error: err.message || 'Resolved a feed, but could not fetch or parse it. Check the account exists and is public.',
        });
    }
});

// Subscribes a channel to a social account.
router.post('/guild/:guildId/social/add', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { platform, input, channelId } = req.body;

    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
    if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input is required' });
    if (!channelId || !isValidDiscordId(channelId)) {
        return res.status(400).json({ error: 'channelId must be a valid Discord snowflake' });
    }

    // A valid snowflake is not proof the channel belongs to this guild.
    // checkGuildAccess authorises the admin for :guildId, but the channel is
    // caller-supplied, and the poller later fetches it globally and posts to
    // whatever it resolves — so without this an admin of one guild could aim a
    // subscription at a channel in any other guild the bot is in.
    if (!(await req.bot.hasChannel(guildId, channelId))) {
        return res.status(400).json({ error: 'channelId must be a channel in this server' });
    }

    let target;
    try {
        target = await resolveSocialTarget(platform, input);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        // The poller delivers once per stored entry, so a repeated add would
        // double every future post for this account in this channel.
        // Matched on the account too, not just the URL: an X subscription stored
        // before FxTwitter carries a bridge URL where a new one carries the
        // profile URL, and both follow the same account.
        const sameAccount = feed => feed.feedUrl === target.feedUrl
            || (feed.platform === target.platform && typeof feed.ref === 'string'
                && feed.ref.toLowerCase() === target.ref.toLowerCase());
        const duplicate = (guildSettings.socialFeeds || []).some(
            feed => sameAccount(feed) && feed.channelId === channelId
        );
        if (duplicate) {
            return res.status(409).json({ error: 'This account already posts to that channel.' });
        }

        guildSettings.socialFeeds.push({
            platform: target.platform,
            ref: target.ref,
            feedUrl: target.feedUrl,
            channelId,
        });
        await guildSettings.save();

        res.json({ success: true, feeds: socialList(guildSettings) });
    } catch (error) {
        console.error('Social add error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Unsubscribes from the account at a position in the guild's social list. The
// list is addressed by position and patched in place from this response, so an
// unparseable or out-of-range index is refused rather than silently taking the
// first row (see the RSS delete route for the full reasoning).
router.delete('/guild/:guildId/social/:index', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, index } = req.params;

    const position = Number(index);
    if (!Number.isInteger(position) || position < 0) {
        return res.status(400).json({ error: 'index must be a non-negative integer' });
    }

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });
        if (position >= (guildSettings.socialFeeds || []).length) {
            return res.status(404).json({ error: 'No subscription at that position. Reload the page and try again.' });
        }

        guildSettings.socialFeeds.splice(position, 1);
        await guildSettings.save();

        res.json({ success: true, feeds: socialList(guildSettings) });
    } catch (error) {
        console.error('Social delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
