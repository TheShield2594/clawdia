'use strict';

const crypto = require('crypto');

/**
 * How a feed URL is named in a log line (#1157).
 *
 * Private feeds often carry an access token in the query string (GitHub's
 * private Atom feeds, podcast hosts, some news providers), and a URL logged
 * whole puts that token wherever the logs ship. Some put it in the path
 * instead (podcast hosts' private feed URLs), so the label is the origin only,
 * which is what an operator needs to recognise the source, plus a short hash of
 * the full URL so two feeds on one host can still be told apart in the logs.
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
    return `${url.origin} #${hash}`;
}

module.exports = { feedUrlLabel };
