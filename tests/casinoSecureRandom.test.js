'use strict';

// #1161: the casino games drew from Math.random while the rest of the economy's
// payout rolls used crypto (src/utils/secureRandom.js). A wager is a payout
// roll like any other, so every casino draw now comes from secureRandom — which
// also means a test drives them through tests/helpers/secureRandom.js, not a
// Math.random spy.

const fs = require('fs');
const path = require('path');

const CASINO = path.join(__dirname, '..', 'src', 'games', 'casino');

test('no casino game draws from Math.random', () => {
    const offenders = fs.readdirSync(CASINO)
        .filter(f => f.endsWith('.js'))
        .filter(f => /Math\.random\b/.test(fs.readFileSync(path.join(CASINO, f), 'utf8')
            // Comments may still name it.
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    expect(offenders).toEqual([]);
});
