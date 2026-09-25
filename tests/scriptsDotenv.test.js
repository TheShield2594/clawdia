'use strict';

// #1161: the host scripts used to `source .env`, running it as shell. They now
// read it through scripts/lib/dotenv.sh, which only ever assigns — so a value
// holding `$(...)`, or a line that is not an assignment at all, is data.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DOTENV_LIB = path.join(__dirname, '..', 'scripts', 'lib', 'dotenv.sh');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-dotenv-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Loads `contents` as .env and prints the named variables as JSON. */
function load(contents, names, env = {}) {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, contents);
    const run = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        '. "$DOTENV_LIB"',
        'load_dotenv "$ENV_FILE"',
        // Printed from a child process, so only exported values are seen.
        'node -e "console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(n => [n, process.env[n] ?? null]))))" $NAMES',
    ].join('\n')], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, ...env, DOTENV_LIB, ENV_FILE: file, NAMES: names.join(' ') },
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout);
}

test('assigns plain, quoted, exported and commented values the way dotenv does', () => {
    const vars = load([
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED=yes',
        'DOUBLE="with spaces"',
        "SINGLE='also spaces'",
        'INLINE=value # trailing comment',
        'EMPTY=',
        'WIN=crlf\r',
    ].join('\n'), ['PLAIN', 'EXPORTED', 'DOUBLE', 'SINGLE', 'INLINE', 'EMPTY', 'WIN']);

    expect(vars).toEqual({
        PLAIN: 'value', EXPORTED: 'yes', DOUBLE: 'with spaces', SINGLE: 'also spaces',
        INLINE: 'value', EMPTY: '', WIN: 'crlf',
    });
});

test('never executes anything in the file', () => {
    const marker = path.join(dir, 'ran');
    const vars = load([
        `SUBST=$(touch ${marker})`,
        `TICKS=\`touch ${marker}\``,
        `touch ${marker}`,
        `QUOTED="$(touch ${marker})"`,
    ].join('\n'), ['SUBST', 'TICKS', 'QUOTED']);

    expect(fs.existsSync(marker)).toBe(false);
    // Kept literally, as the bot's dotenv would.
    expect(vars.SUBST).toBe(`$(touch ${marker})`);
    expect(vars.QUOTED).toBe(`$(touch ${marker})`);
});

// Values the backup scripts and the bot must read identically — a passphrase
// that differs by a trailing comment opens nothing.
test('inline comments end a value the way the bot reads them', () => {
    const vars = load([
        'HASH=secret#note',
        'QUOTED_COMMENT="secret" # note',
        "SINGLE_COMMENT='secret' # note",
        'QUOTED_HASH="has#hash"',
        'NEWLINE="a\\nb"',
    ].join('\n'), ['HASH', 'QUOTED_COMMENT', 'SINGLE_COMMENT', 'QUOTED_HASH', 'NEWLINE']);

    expect(vars).toEqual({
        HASH: 'secret', QUOTED_COMMENT: 'secret', SINGLE_COMMENT: 'secret', QUOTED_HASH: 'has#hash', NEWLINE: 'a\nb',
    });
    // And the bot's own parser agrees on every one of them.
    const parsed = require('dotenv').parse(fs.readFileSync(path.join(dir, '.env')));
    expect(vars).toEqual(parsed);
});

test('a key assigned twice takes its last value, unless the environment set it', () => {
    const vars = load('MONGODB_URI=first\nMONGODB_URI=second\nKEPT=file-1\nKEPT=file-2\n', ['MONGODB_URI', 'KEPT'], {
        KEPT: 'from-env',
    });
    expect(vars).toEqual({ MONGODB_URI: 'second', KEPT: 'from-env' });
});

test('a variable already in the environment wins', () => {
    const vars = load('MONGODB_URI=from-file\nOTHER=from-file\n', ['MONGODB_URI', 'OTHER'], {
        MONGODB_URI: 'from-env',
    });
    expect(vars).toEqual({ MONGODB_URI: 'from-env', OTHER: 'from-file' });
});

test('skips lines whose key is not a plain name', () => {
    const vars = load('1BAD=x\nBAD-NAME=x\nGOOD=x\n', ['GOOD']);
    expect(vars).toEqual({ GOOD: 'x' });
});

test('no host script sources .env any more', () => {
    const scripts = path.join(__dirname, '..', 'scripts');
    for (const file of fs.readdirSync(scripts).filter(f => f.endsWith('.sh'))) {
        const source = fs.readFileSync(path.join(scripts, file), 'utf8');
        expect([file, /(source|^\s*\.)\s+\S*\.env\b/m.test(source)]).toEqual([file, false]);
    }
});
