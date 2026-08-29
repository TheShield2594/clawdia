'use strict';

const { randomInt } = require('crypto');

/**
 * Dice for the AI Dungeon Master (#837).
 *
 * A skill check used to be a mood. The model wrote "you deftly pick the lock"
 * or "the lock defeats you" from nothing but its own sampling, and there was no
 * record of a roll because there was no roll — which means a player who felt
 * hard done by had nothing to point at, and a model in a generous mood could
 * hand out a whole dungeon.
 *
 * So the dice leave the model's head and come back as a tool call. The model
 * asks for `1d20+3`, this rolls it, and the number it then has to narrate
 * around was generated here and is printed under the scene. That is the whole
 * point: not that the randomness is better (the model's sampling is random
 * enough), but that it is *visible*. An outcome the party can check is an
 * outcome they can argue with.
 *
 * Every bound below exists because the notation arrives from a model:
 * `999999d100` is a plausible thing for a confused one to ask for and a silly
 * thing to compute, and a modifier of ten thousand is not a skill check.
 */

// A roll is `NdS`, optionally `+M` or `-M`. Whitespace is tolerated because
// models write "2d6 + 3" about as often as "2d6+3".
const NOTATION = /^\s*(\d{1,3})\s*d\s*(\d{1,3})\s*(?:([+-])\s*(\d{1,4})\s*)?$/i;

// Twenty dice is more than any check needs and few enough to print.
const MAX_DICE = 20;
// d100 is the largest die anybody rolls; d1 is not a die.
const MIN_SIDES = 2;
const MAX_SIDES = 100;
// A modifier larger than the die it modifies stops being a modifier.
const MAX_MODIFIER = 100;

// How many rolls one turn may ask for. A model that has decided every sentence
// needs a check would otherwise spend a tool round on each of them.
const MAX_ROLLS_PER_TURN = 6;

/**
 * Parse `2d6+3` into its parts, or return null.
 *
 * Null rather than a throw: the caller is a tool executor, and every failure
 * here is something the model should be told about in words so it can ask
 * again, not an exception that ends somebody's turn.
 */
function parseNotation(notation) {
    const match = NOTATION.exec(String(notation ?? ''));
    if (!match) return null;

    const count = Number(match[1]);
    const sides = Number(match[2]);
    const magnitude = match[4] === undefined ? 0 : Number(match[4]);
    const modifier = match[3] === '-' ? -magnitude : magnitude;

    if (count < 1 || count > MAX_DICE) return null;
    if (sides < MIN_SIDES || sides > MAX_SIDES) return null;
    if (Math.abs(modifier) > MAX_MODIFIER) return null;

    return { count, sides, modifier };
}

/**
 * Roll one notation. Returns the individual dice as well as the total, because
 * "17 (14 + 3)" is what makes the result checkable and "17" is not.
 *
 * `randomInt` rather than `Math.random()`: this is the only randomness in the
 * campaign whose result a player is invited to dispute, and a uniform integer
 * from the platform CSPRNG costs nothing here.
 */
function roll(notation) {
    const parsed = parseNotation(notation);
    if (!parsed) return null;

    const { count, sides, modifier } = parsed;
    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(randomInt(1, sides + 1));

    const sum = rolls.reduce((total, value) => total + value, 0);
    return {
        notation: `${count}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : ''}`,
        rolls,
        modifier,
        total: sum + modifier,
        // A natural 20 on a lone d20 is the one result worth naming, and the
        // model cannot be trusted to notice it from the number alone.
        critical: count === 1 && sides === 20 && rolls[0] === 20,
        fumble: count === 1 && sides === 20 && rolls[0] === 1
    };
}

/** How a roll reads under the scene, and in the tool's answer. */
function describe(result, reason) {
    const detail = result.rolls.length > 1 || result.modifier
        ? ` (${result.rolls.join(' + ')}${result.modifier > 0 ? ` + ${result.modifier}` : result.modifier < 0 ? ` − ${Math.abs(result.modifier)}` : ''})`
        : '';
    const flag = result.critical ? ' — **critical!**' : result.fumble ? ' — **fumble!**' : '';
    return `🎲 ${reason ? `${reason}: ` : ''}\`${result.notation}\` → **${result.total}**${detail}${flag}`;
}

/**
 * The `dice_roll` tool, in the shape `prepareMcpToolkit` takes for a tool the
 * bot owns rather than a server (see services/ai/botTools.js).
 *
 * One per turn, holding that turn's rolls: the executor pushes each result into
 * `rolls`, and the caller reads them back afterwards to print under the scene.
 * A closure rather than a module-level list because two channels can be mid-turn
 * at the same moment, and their rolls are not each other's.
 *
 * @param {object[]} rolls the turn's roll log, appended to as the model calls
 * @returns {object} a bot-tool definition with a `run(args)` executor
 */
function diceTool(rolls) {
    return {
        name: 'dice_roll',
        serverName: 'clawdia',
        toolName: 'dice_roll',
        description:
            'Roll dice for a skill check, attack, saving throw or damage roll. Call this before narrating '
            + 'whether an uncertain action succeeds — do not decide the outcome yourself. The result is shown '
            + 'to the party, so narrate what the number you get back actually means.',
        inputSchema: {
            type: 'object',
            properties: {
                notation: {
                    type: 'string',
                    description: `Standard dice notation, e.g. "1d20", "2d6+3", "1d8-1". At most ${MAX_DICE} dice of at most d${MAX_SIDES}.`
                },
                reason: {
                    type: 'string',
                    description: 'What is being rolled for, in a few words — "Aric picks the lock", "goblin\'s club".'
                }
            },
            required: ['notation']
        },
        // Nothing is written and nobody needs to approve a die.
        annotations: { readOnlyHint: true, destructiveHint: false },
        confirm: false,
        run: args => {
            if (rolls.length >= MAX_ROLLS_PER_TURN) {
                return `No roll was made: this turn has already used its ${MAX_ROLLS_PER_TURN} rolls. `
                    + 'Narrate the outcome from the rolls you already have.';
            }

            const result = roll(args?.notation);
            if (!result) {
                return `"${String(args?.notation ?? '').slice(0, 40)}" is not a roll I can make. `
                    + `Use NdS with an optional modifier — at most ${MAX_DICE} dice, d${MIN_SIDES} to d${MAX_SIDES}, `
                    + `modifier within ±${MAX_MODIFIER}.`;
            }

            const reason = typeof args?.reason === 'string' ? args.reason.trim().slice(0, 80) : '';
            rolls.push({ ...result, reason });
            return `${describe(result, reason)}. This number is shown to the party — narrate what it means.`;
        }
    };
}

module.exports = {
    roll,
    parseNotation,
    describe,
    diceTool,
    MAX_DICE,
    MAX_SIDES,
    MAX_MODIFIER,
    MAX_ROLLS_PER_TURN
};
