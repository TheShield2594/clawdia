'use strict';

const { WEATHER_LIST, WEATHER_TYPES } = require('../data/fishData');

// ─── GLOBAL WEATHER STATE ─────────────────────────────────────────────────────
// Shared across all guilds; rotates on a timer.

let currentWeatherId  = 'clear';
let weatherExpiresAt  = 0;

function getCurrentWeather() {
    if (Date.now() >= weatherExpiresAt) {
        _rotateWeather();
    }
    return WEATHER_TYPES[currentWeatherId] ?? WEATHER_TYPES.clear;
}

function _rotateWeather() {
    const total = Object.values(WEATHER_TYPES).reduce((s, w) => s + (w.spawnWeight ?? 10), 0);
    let r = Math.random() * total;
    for (const [id, entry] of Object.entries(WEATHER_TYPES)) {
        r -= (entry.spawnWeight ?? 10);
        if (r <= 0) {
            currentWeatherId = id;
            break;
        }
    }
    const weather    = WEATHER_TYPES[currentWeatherId];
    weatherExpiresAt = Date.now() + (weather?.durationMs ?? 2 * 3_600_000);
}

function msUntilWeatherChange() {
    return Math.max(0, weatherExpiresAt - Date.now());
}

// Initialize on load
_rotateWeather();

module.exports = { getCurrentWeather, msUntilWeatherChange };
