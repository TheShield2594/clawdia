'use strict';

const BANDS = [
    { start: 5,  end: 12, emoji: '🌅', label: 'Morning' },
    { start: 12, end: 17, emoji: '☀️', label: 'Noon'    },
    { start: 17, end: 21, emoji: '🌆', label: 'Dusk'    },
    { start: 21, end: 24, emoji: '🌙', label: 'Night'   },
    { start: 0,  end: 5,  emoji: '🌙', label: 'Night'   },
];

function getTimeBand() {
    const hour = new Date().getUTCHours();
    return BANDS.find(b => hour >= b.start && hour < b.end) ?? BANDS[3];
}

module.exports = { getTimeBand };
