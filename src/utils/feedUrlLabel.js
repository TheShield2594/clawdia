'use strict';

const crypto = require('crypto');

/**
 * How a feed URL is named in a log line (#1157).
 *
 * Private feeds often carry an access token in the query string (GitHub's
 * private Atom feeds, podcast hosts, some news providers), and a URL logged
 * whole puts that token wherever the logs ship. The label keeps the part an
 * operator needs to recognise the feed, origin plus path, and drops the query,
 * fragment and any userinfo. When something was dropped, a short hash of the
 * full URL is appended so two subscriptions that differ only in their query
 * can still be told apart in the logs.
 */
function feedUrlLabel(raw) {
    const text = String(raw ?? '');
    const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
    let url;
    try {
        url = new URL(text);
    } catch {
        return `[unparseable feed URL #${hash}]`;
    }
    const base = `${url.origin}${url.pathname}`;
    const stripped = url.search || url.hash || url.username || url.password;
    return stripped ? `${base} #${hash}` : base;
}

module.exports = { feedUrlLabel };
