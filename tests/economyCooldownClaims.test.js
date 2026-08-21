'use strict';

// `client.cooldowns` is a process-local Map. That is fine for what it is — a
// cheap "you're on cooldown" pre-check that avoids a database round trip on
// every interaction — but it is empty after a restart and shared by nothing, so
// it cannot be what stops a player collecting an income command twice. Every
// command that pays coins has to claim its own window atomically in Mongo, with
// the previous timestamp in the update's filter, so the claim either wins or
// returns null.
//
// /quiz did not: it paid coins on a 300s cooldown that existed only in that Map,
// so a restart handed the player their whole daily question allowance at once.
// This test is what keeps the next income command from shipping the same way.

const fs   = require('fs');
const path = require('path');

const COMMANDS = path.join(__dirname, '..', 'src', 'commands', 'economy');
const read = file => fs.readFileSync(path.join(COMMANDS, file), 'utf8');

/**
 * Income commands and the field each one claims. Listing them by hand is the
 * point — adding a payout command means deciding, here, what bounds its rate.
 *
 * Two claim shapes are both correct, and both appear in the codebase:
 *
 *   'floor' — the filter carries `field: { $lte: cooldownFloor }`, so an
 *             attempt inside the window matches nothing and returns null.
 *   'cas'   — the filter carries the exact timestamp that was just read, so a
 *             parallel attempt that already moved it loses the swap. The window
 *             itself is checked against the value read from the database, which
 *             is what makes it survive a restart.
 */
const CLAIMS = [
    { file: 'work.js',         field: 'lastWork',         shape: 'floor' },
    { file: 'daily.js',        field: 'lastDaily',        shape: 'floor' },
    { file: 'crime.js',        field: 'lastCrime',        shape: 'floor' },
    { file: 'quiz.js',         field: 'lastQuiz',         shape: 'floor' },
    { file: 'snowball.js',     field: 'lastSnowball',     shape: 'floor' },
    { file: 'sandcastle.js',   field: 'lastSandcastle',   shape: 'floor' },
    { file: 'trickortreat.js', field: 'lastTrickOrTreat', shape: 'floor' },
    { file: 'trackhunt.js',    field: 'lastTrackHunt',    shape: 'floor' },
    { file: 'rob.js',          field: 'lastRob',          shape: 'cas' },
];

// The four grind systems keep their cooldown on GrindProfile rather than User.
// Fishing's claim lives in its service layer (#613 — the command parses and
// renders, fishService.claimCastCooldown owns the transaction); the rest still
// claim inline in the command and should follow the same path when extracted.
const GRIND_CLAIMS = [
    { file: '../../services/fishService.js', field: 'data.lastCast', shape: 'floor' },
    { file: 'hunt.js',    field: 'data.lastHunt',    shape: 'floor' },
    { file: 'mine.js',    field: 'data.lastMine',    shape: 'floor' },
    { file: 'explore.js', field: 'data.lastExplore', shape: 'floor' },
];

const ALL = [...CLAIMS, ...GRIND_CLAIMS];
const escaped = field => field.replace('.', '\\.');

describe('every income command claims its cooldown in the database', () => {
    test.each(ALL.filter(c => c.shape === 'floor'))('$file bounds $field in a filter', ({ file, field }) => {
        // The timestamp has to appear as a bound in a filter — `$lt`/`$lte`
        // against the cooldown floor — not merely be written afterwards. A
        // command that only `$set`s the field has no claim, just a record.
        expect(read(file)).toMatch(new RegExp(`'?${escaped(field)}'?:\\s*\\{\\s*\\$lte?:`));
    });

    test.each(ALL.filter(c => c.shape === 'cas'))('$file swaps $field against the value it read', ({ file, field }) => {
        // `{ ..., lastRob: <the timestamp just read> }` in the filter: a parallel
        // attempt that already moved it finds nothing to update.
        expect(read(file)).toMatch(new RegExp(`${escaped(field)}:\\s*\\w+(Snapshot)?\\.${escaped(field)}`));
        // …and the window itself is measured against the stored value.
        expect(read(file)).toMatch(new RegExp(`new Date\\(\\w+\\.${escaped(field)}\\)`));
    });

    // Only the floor shape: a CAS claim writes the timestamp its caller staged
    // rather than minting one inline, and both halves of that claim are already
    // covered by the swap assertions above.
    test.each(ALL.filter(c => c.shape === 'floor'))('$file writes $field when it wins the claim', ({ file, field }) => {
        expect(read(file)).toMatch(new RegExp(`'?${escaped(field)}'?:\\s*([\\w.]*[Nn]ow|new Date|crimeTime)`));
    });
});

describe('the in-memory cooldown map is documented as a pre-check, not the gate', () => {
    test('src/index.js says where the authority actually lives', () => {
        const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
        const declaration = index.slice(0, index.indexOf('client.cooldowns = new Collection();'));
        expect(declaration).toMatch(/atomically in Mongo/);
    });
});
