'use strict';

// Four sources used to disagree about which environment variables exist:
// `OPENROUTER_REFERER` was read by the OpenRouter provider and named nowhere at
// all, and both README and SETUP_GUIDE carried hand-maintained copies of the
// list that had each dropped a different variable (#707).
//
// `.env.example` is the single source of truth now — it is the only one that was
// accurate, and it is the file an operator actually copies. This is what keeps
// it that way: read a new `process.env.SOMETHING` in src/ and `npm test` goes
// red until the variable is in `.env.example` with a comment saying what it
// does.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

// Read by the bot but deliberately not offered as a setting. Each one needs a
// reason, because "add it to the allowlist" is otherwise the cheapest way past
// this test and would make it worthless.
const NOT_A_SETTING = {
    SHARD_ID: 'injected into each child process by the ShardingManager; setting '
        + 'it by hand on the parent tells every shard it is shard 0',
};

// Some of the file's variables are consumed outside the bot process — by the
// compose stacks, by scripts/mongo-init.js, or as the `<NAME>_FILE` form of a
// secret. Those are listed rather than searched for, so that a variable nobody
// consumes anywhere cannot hide behind a grep that happens to hit a comment.
const CONSUMED_OUTSIDE_SRC = new Set([
    'DASHBOARD_HOST_PORT',
    'BACKUP_RETENTION_DAYS',
    'MONGODB_ROOT_USERNAME',
    'MONGODB_ROOT_PASSWORD',
    'MONGODB_APP_USERNAME',
    'MONGODB_APP_PASSWORD',
    'DISCORD_TOKEN_FILE',
]);

// Where those are allowed to turn up.
const OUTSIDE_CONSUMERS = [
    'docker-compose.yml',
    'portainer-stack.yml',
    'scripts/mongo-init.js',
    'src/config/fileSecrets.js',
];

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// `process.env.NAME` and the literal bracket forms `process.env['NAME']` /
// `process.env["NAME"]`, which are the same read written differently and would
// otherwise slip past this test entirely. A computed key —
// `process.env[match[1]]` in config/mcpServers.js — is not a name and cannot be
// resolved here; that one is by design, resolving `${VAR}` placeholders out of
// the MCP config file.
const ENV_READ = /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;

function readByTheBot() {
    const names = new Map();
    for (const file of walk(path.join(ROOT, 'src'))) {
        const src = fs.readFileSync(file, 'utf8');
        for (const [, dotted, bracketed] of src.matchAll(ENV_READ)) {
            const name = dotted || bracketed;
            if (!names.has(name)) names.set(name, path.relative(ROOT, file));
        }
    }
    return names;
}

/**
 * A key counts as documented when the file both names it — live as
 * `NAME=value`, or commented out as an optional knob, since it uses both on
 * purpose — and says something about it.
 *
 * The second half is the point. A bare `# NEW_KEY=` would satisfy a test that
 * only looked for the name, and would satisfy it while telling an operator
 * nothing, which is the state this whole file exists to prevent. So a key is
 * documented only if there is prose in its block: the run of non-blank lines
 * above it, up to the blank line that separates one group from the next. That
 * is per-group rather than per-line deliberately — the four `MONGODB_*` auth
 * variables share one explanation, and splitting it four ways would be worse.
 */
function documentedInEnvExample() {
    const lines = fs.readFileSync(ENV_EXAMPLE, 'utf8').split('\n');
    const assignment = /^#?\s*([A-Z][A-Z0-9_]*)=/;
    const documented = new Set();

    for (let i = 0; i < lines.length; i++) {
        const named = assignment.exec(lines[i]);
        if (!named) continue;

        for (let j = i - 1; j >= 0 && lines[j].trim() !== ''; j--) {
            const above = lines[j].trim();
            // A commented-out assignment is another knob, not prose about this one.
            if (above.startsWith('#') && !assignment.test(above)) {
                documented.add(named[1]);
                break;
            }
        }
    }
    return documented;
}

describe('.env.example is the source of truth for configuration', () => {
    test('every variable the bot reads is in it', () => {
        const documented = documentedInEnvExample();
        const missing = [...readByTheBot()]
            .filter(([name]) => !documented.has(name) && !(name in NOT_A_SETTING))
            .map(([name, file]) => `${name} (read at ${file})`);

        expect(missing).toEqual([]);
    });

    test('it does not offer variables nothing consumes', () => {
        const read = readByTheBot();
        const stale = [...documentedInEnvExample()]
            .filter(name => !read.has(name) && !CONSUMED_OUTSIDE_SRC.has(name));

        expect(stale).toEqual([]);
    });

    test('a variable held back from the file has a reason recorded', () => {
        for (const [name, why] of Object.entries(NOT_A_SETTING)) {
            expect(typeof why).toBe('string');
            expect(why.length).toBeGreaterThan(20);
            // And it is genuinely still read — an allowlist entry for a variable
            // nobody reads any more is just litter.
            expect(readByTheBot().has(name)).toBe(true);
        }
    });

    // The list above is itself a place drift can hide, so hold it to the files
    // it claims: a variable dropped from the compose stacks should come off this
    // list and out of `.env.example`, not sit here forever.
    test('each variable excused as consumed elsewhere really is', () => {
        const haystack = OUTSIDE_CONSUMERS
            .map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8'))
            .join('\n');
        const orphaned = [...CONSUMED_OUTSIDE_SRC].filter(name => !haystack.includes(name));

        expect(orphaned).toEqual([]);
    });

    // The ones the issue found missing, pinned by name so a regeneration or a
    // careless edit cannot quietly drop them again.
    test.each(['OPENROUTER_REFERER', 'SERVICE_NAME', 'NO_COLOR', 'AUDIT_LOG_RETENTION_DAYS', 'NODE_ENV'])(
        'documents %s',
        name => expect(documentedInEnvExample().has(name)).toBe(true),
    );
});

// README no longer repeats the whole list, but it does still name the handful
// without which the bot will not boot — which is a claim about
// `validateEnv.js`, and therefore a claim that can go stale.
describe('README required-variable table', () => {
    test('names exactly what validateEnv refuses to start without', () => {
        const { REQUIRED_ENV } = require('../src/config/validateEnv');
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

        const heading = 'These five are the ones';
        const start = readme.indexOf(heading);
        expect(start).toBeGreaterThan(-1);

        const table = readme.slice(start, readme.indexOf('\n\n', readme.indexOf('| ---', start)));
        const listed = [...table.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map(m => m[1]);

        expect(listed.sort()).toEqual([...REQUIRED_ENV].sort());
    });
});
