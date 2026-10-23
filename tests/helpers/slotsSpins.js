'use strict';

/**
 * Fixed spins for driving `/casino slots` through a test.
 *
 * The game draws its reels through `spin()` in src/games/casino/slotsReels.js.
 * A suite that wants a particular hand mocks that one function to hand out
 * views from a queue, and builds them here:
 *
 *     let mockSpins = [];
 *     jest.mock('../src/games/casino/slotsReels', () => {
 *         const actual = jest.requireActual('../src/games/casino/slotsReels');
 *         return { ...actual, spin: (...a) => (mockSpins.length ? mockSpins.shift() : actual.spin(...a)) };
 *     });
 *     mockSpins = [view(['Wild', 'Wild', 'Wild'])];
 *
 * The rows above and below the payline default to symbols that never add a
 * Scatter, so a view only awards free spins when a test puts them there.
 */

const { BY_NAME } = jest.requireActual('../../src/games/casino/slotsReels');

const symbols = names => names.map(name => {
    const symbol = BY_NAME.get(name);
    if (!symbol) throw new Error(`slotsSpins: no symbol named ${name}`);
    return symbol;
});

/**
 * A spin whose payline is `line`, as `spin()` returns one.
 *
 * @param {string[]} line               the payline, by symbol name
 * @param {object}   [rows]
 * @param {string[]} [rows.above]       the row above the payline
 * @param {string[]} [rows.below]       the row below it
 */
function view(line, { above = ['Cherry', 'Lemon', 'Grape'], below = ['Grape', 'Cherry', 'Lemon'] } = {}) {
    const window = [symbols(above), symbols(line), symbols(below)];
    return {
        stops: [0, 0, 0],
        window,
        line: window[1],
        scatterCount: window.flat().filter(s => s.type === 'scatter').length,
    };
}

module.exports = { view };
