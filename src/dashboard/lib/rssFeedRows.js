'use strict';

/**
 * A guild's RSS subscriptions in the shape the dashboard's feed list renders.
 *
 * Two consumers, as with reactionRolePanels: the rss panel template renders
 * the list on page load, and the RSS routes answer every add and remove with
 * this same array so the browser redraws the list in place (#689). Both go
 * through here so a row after a mutation is identical to the row a reload
 * shows — including the status line, which is worded on the server so the
 * browser has no date formatting of its own to drift.
 *
 * The status line is how an admin finds out a feed has stopped working. The
 * poller records a failing feed's error and when it started failing on the
 * subscription itself; before that, a dead feed was only ever a line in the
 * bot's console.
 *
 * Dates are absolute and UTC ("3 Sep 2026") rather than relative: a page left
 * open does not re-render, and "2 hours ago" would go on saying so.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * @param {{ lastError?: ?string, failingSince?: ?Date, lastPostedAt?: ?Date }} feed
 * @returns {{ tone: 'error' | 'ok' | 'idle', text: string }}
 */
function feedStatus(feed) {
    if (feed.lastError) {
        const since = formatDay(feed.failingSince);
        return { tone: 'error', text: `${since ? `Failing since ${since}` : 'Failing'} — ${feed.lastError}` };
    }
    const lastPost = formatDay(feed.lastPostedAt);
    if (lastPost) return { tone: 'ok', text: `Last post ${lastPost}` };
    return { tone: 'idle', text: 'Waiting for the first new post' };
}

const keywords = value => (Array.isArray(value) ? value.filter(k => typeof k === 'string' && k) : []);

/**
 * The subscription's delivery options, for the row's editor to start from.
 *
 * @returns {{ includeKeywords: string[], excludeKeywords: string[], mentionRoleId: ?string, messageTemplate: string }}
 */
function feedOptions(feed) {
    return {
        includeKeywords: keywords(feed.includeKeywords),
        excludeKeywords: keywords(feed.excludeKeywords),
        mentionRoleId: feed.mentionRoleId || null,
        messageTemplate: feed.messageTemplate || '',
    };
}

// One line saying which options are set, or '' when none are. The role ping
// is not in it: that needs the role's name, which each renderer looks up from
// its own role list, as it does for the channel.
function optionsSummary(options) {
    const parts = [];
    if (options.includeKeywords.length) parts.push(`Only: ${options.includeKeywords.join(', ')}`);
    if (options.excludeKeywords.length) parts.push(`Skips: ${options.excludeKeywords.join(', ')}`);
    if (options.messageTemplate) parts.push('Custom message');
    return parts.join(' · ');
}

/**
 * @param {Array<object>} [rssFeeds] the guild's `rssFeeds`
 * @returns {Array<{ url: string, channelId: string, title?: string,
 *   status: { tone: string, text: string }, options: object, summary: string }>}
 */
function rssFeedRows(rssFeeds) {
    return (rssFeeds || []).map(feed => {
        const row = { url: feed.url, channelId: feed.channelId };
        if (feed.title) row.title = feed.title;
        row.status = feedStatus(feed);
        row.options = feedOptions(feed);
        row.summary = optionsSummary(row.options);
        return row;
    });
}

module.exports = { rssFeedRows, feedStatus };
