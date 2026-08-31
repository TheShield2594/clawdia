'use strict';

// Command handlers read guild configuration through the settings cache (#877).
//
// 121 handlers opened with a raw, unprojected `Guild.findOne({ guildId })` —
// usually to read one field like `economy.currency` or `economy.enabled`. Two
// costs stacked on every invocation: the whole document was hydrated, inline
// `shop[].imageData` Buffers (up to 35 × 512 KB) and giveaway entrant arrays
// included, to read a boolean; and it duplicated a read `interactionCreate` had
// already done for the same interaction, through the cache, moments earlier.
//
// The rule these tests hold is narrow and checkable: a command may still read
// the Guild model, but never for the whole document. Either it goes through
// `getGuildSettings` (which projects the heavy fields away and collapses the
// duplicate read into a cache hit), or it passes a projection and says why the
// cache cannot serve it.

const fs = require('fs');
const path = require('path');

const COMMANDS = path.join(__dirname, '..', 'src', 'commands');

function commandFiles(dir = COMMANDS, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) commandFiles(full, found);
        else if (entry.name.endsWith('.js')) found.push(full);
    }
    return found;
}

const rel = file => path.relative(path.join(__dirname, '..'), file);

/**
 * Every `Guild.findOne(` in the command tree, with the text of the call — the
 * rest of the line plus the next few, since some are written across lines.
 */
function modelReads() {
    const reads = [];
    for (const file of commandFiles()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const [i, line] of lines.entries()) {
            if (!line.includes('Guild.findOne(')) continue;
            reads.push({
                file: rel(file),
                line: i + 1,
                text: lines.slice(i, i + 5).join('\n'),
            });
        }
    }
    return reads;
}

describe('commands do not hydrate the whole guild document', () => {
    test('every remaining Guild.findOne in a command carries a projection', () => {
        // A projection is the second argument, or a `.select()`. Without one,
        // Mongoose returns every field — which on a guild with an illustrated
        // shop is megabytes, for a handler that wanted one boolean.
        const unprojected = modelReads().filter(read => {
            const call = read.text.slice(read.text.indexOf('Guild.findOne('));
            const projected =
                /\}\s*,\s*(?:'[^']*'|"[^"]*"|\{)/.test(call) ||   // second argument
                /\)\s*\.\s*select\(/.test(call);                  // .select(...)
            return !projected;
        });

        expect(unprojected.map(r => `${r.file}:${r.line}`)).toEqual([]);
    });

    test('the handful of reads that stay on the model are the ones that must', () => {
        // Keyed by file rather than by line, so moving code does not fail this,
        // but adding a read does. Each entry is a decision with a reason: the
        // point is that a new unprojected read cannot arrive without someone
        // writing down why it is not going through the cache.
        const perFile = {};
        for (const read of modelReads()) perFile[read.file] = (perFile[read.file] || 0) + 1;

        expect(perFile).toEqual({
            // Read-modify-write on the same field: the value read decides
            // whether the write happens, so a cached read would put a TTL
            // between the check and the write for a second caller to slip into.
            'src/commands/admin/event.js': 2,      // /event start, /event end — activeEvent
            'src/commands/economy/season.js': 2,   // /season start, /season end — currentSeason

            // Three of the same in war.js (challenge, accept, cancel — activeWar),
            // plus the invite-code lookup, which is not a guildId query at all,
            // plus grantWarPoints resolving the scores a war is settled on plain
            // after its cached read has answered the common "no war here" case.
            'src/commands/economy/war.js': 5,

            // Writes the document back, so it needs a real Mongoose document
            // rather than the cache's shared plain object.
            'src/commands/economy/boost.js': 1,

            // A positional projection over an array, narrower than anything the
            // cache could hand back.
            'src/commands/economy/fish/cast.js': 1,
        });
    });

});

describe('the settings cache is what commands actually call', () => {
    test('most command files now read through getGuildSettings', () => {
        const files = commandFiles();
        const cached = files.filter(f =>
            fs.readFileSync(f, 'utf8').includes('getGuildSettings('));
        // 78 files at the time this landed. The floor is a ratchet, not a
        // target: it exists so a refactor cannot quietly put the reads back.
        expect(cached.length).toBeGreaterThanOrEqual(70);
    });

    test('a command that reads through the cache does not also read the model', () => {
        // /balance is the shape the issue is about: it read the whole document
        // for `economy.currency` on every invocation, in a guild that may have
        // an illustrated shop.
        const src = fs.readFileSync(path.join(COMMANDS, 'economy', 'balance.js'), 'utf8');
        expect(src).toContain('getGuildSettings(');
        expect(src).not.toContain('Guild.findOne(');
        expect(src).not.toMatch(/require\(['"]\.\.\/\.\.\/models\/Guild['"]\)/);
    });
});
