'use strict';

const { isValidTimezone, nowInTimezone } = require('./timezones');

const BANDS = [
    { start: 5,  end: 12, emoji: '🌅', label: 'Morning' },
    { start: 12, end: 17, emoji: '☀️', label: 'Noon'    },
    { start: 17, end: 21, emoji: '🌆', label: 'Dusk'    },
    { start: 21, end: 24, emoji: '🌙', label: 'Night'   },
    { start: 0,  end: 5,  emoji: '🌙', label: 'Night'   },
];

/**
 * The band the hour falls in. With a player's timezone (the one /timezone
 * stores) it is *their* morning or night, and `local` says so; without one,
 * or with one that no longer resolves, it is the shared UTC band every
 * command used before.
 */
function getTimeBand(timeZone = null, now = new Date()) {
    const local = isValidTimezone(timeZone);
    const hour = local ? nowInTimezone(timeZone, now).hour : now.getUTCHours();
    const band = BANDS.find(b => hour >= b.start && hour < b.end) ?? BANDS[3];
    return { ...band, local };
}

module.exports = { getTimeBand };
