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
    // Pick a random weather type (weighted toward clear/rain for realism)
    const weights = { clear: 30, rain: 20, fog: 15, storm: 10, heatwave: 15, aurora: 10 };
    const total   = Object.values(weights).reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (const [id, w] of Object.entries(weights)) {
        r -= w;
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
