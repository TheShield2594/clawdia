'use strict';

/**
 * The hero stat row on the landing page, measured off the running instance.
 *
 * It used to be four hardcoded numbers — "14,200 servers", "2.1M commands /
 * day", "99.98% uptime · 90d" — presented as facts about whatever install a
 * visitor was looking at (#704). On a self-hosted deploy, which is the only
 * kind there is, those describe someone else's instance or no instance at all.
 *
 * Three of the four are now read from this process. The fourth, commands per
 * day, is gone rather than approximated: the only record of command volume is
 * `GuildAnalytics.commandUsage`, capped by its writer at 3000 entries per
 * guild, so for any guild busier than that the window it covers is under a day
 * and the figure silently under-reports. A number that is wrong precisely for
 * the instances that would be proudest of it is not worth a collection-wide
 * scan on an unauthenticated page.
 *
 * `uptime` is this process's, and says so. The replaced claim was a 90-day
 * availability figure, which nothing here measures and no single process could.
 */

const { getStatus } = require('../../health');

/**
 * Seconds as the two largest units that fit: `12d 4h`, `5h 12m`, `8m`, `47s`.
 *
 * Two units rather than one so a fresh deploy does not read as "0d", and rather
 * than three so it stays a stat tile instead of a duration.
 */
function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const units = [
        ['d', 86400],
        ['h', 3600],
        ['m', 60],
        ['s', 1],
    ];

    const parts = [];
    let rest = total;
    for (const [suffix, size] of units) {
        const value = Math.floor(rest / size);
        rest -= value * size;
        if (value > 0 || parts.length) parts.push(`${value}${suffix}`);
        if (parts.length === 2) break;
    }

    return parts.length ? parts.join(' ') : '0s';
}

/** 1234567 → "1,234,567". Locale-pinned so the markup does not move with the host. */
function formatCount(value) {
    return Number(value).toLocaleString('en-US');
}

/**
 * @param {{reach: function}} bot the gateway facade
 * @param {object} [deps]
 * @param {function} [deps.status] injectable for tests; defaults to the real
 *   process health, which is where uptime comes from
 * @returns {{servers: string, members: string, uptime: string}|null} null when
 *   the numbers cannot be had — the client has not been ready, or the facade
 *   threw. The template drops the row entirely for null rather than rendering
 *   zeroes, because "we have not been told yet" and "nobody uses this" are
 *   different claims and only one of them is true at boot.
 */
function instanceStats(bot, { status = () => getStatus({ detailed: false }) } = {}) {
    let reach;
    try {
        reach = bot?.reach?.();
    } catch {
        return null;
    }
    if (!reach) return null;

    let uptimeSeconds;
    try {
        ({ uptime: uptimeSeconds } = status());
    } catch {
        return null;
    }

    return {
        servers: formatCount(reach.guilds),
        members: formatCount(reach.members),
        uptime: formatUptime(uptimeSeconds),
    };
}

module.exports = { instanceStats, formatUptime, formatCount };
