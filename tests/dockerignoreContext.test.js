'use strict';

// `.dockerignore` is the only thing standing between a file on disk and the
// published image: `COPY . .` in the Dockerfile sends whatever the context
// still holds, and .gitignore has no say in it. The list used to be a denylist,
// so ./secrets/ — the directory docker-compose.yml documents for the live
// Discord token, session secret and provider keys — was in the context and
// would have been baked into any locally built image (#871).
//
// It is an allowlist now. This test is what keeps it one: the failure mode is
// not a wrong pattern but a *missing* one, and a missing pattern in an
// allowlist excludes rather than leaks. So the things worth asserting are the
// shape (does it still start by excluding everything?), the exceptions (does
// one of them name something sensitive?) and the Dockerfile's side of the
// contract (is every path it copies from the context still reachable?).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IGNORE = path.join(ROOT, '.dockerignore');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');

// Anything whose whole point is to hold a credential, plus the two directories
// that accumulate copies of the database. None of these belongs in an image.
const SENSITIVE = [
    'secrets',
    '.env',
    '.env.local',
    'config/mcp-servers.json',
    'backups',
    'logs',
];

function patterns() {
    return fs.readFileSync(IGNORE, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
}

function exceptions() {
    return patterns().filter(p => p.startsWith('!')).map(p => p.slice(1));
}

// Every COPY that reads from the build context. `--from=<stage>` copies out of
// an earlier stage instead and the context has no say in those.
function contextCopySources() {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    const sources = [];

    for (const line of dockerfile.split('\n')) {
        const match = /^COPY\s+(.*)$/.exec(line.trim());
        if (!match) continue;

        const args = match[1].split(/\s+/).filter(Boolean);
        if (args.some(arg => arg.startsWith('--from='))) continue;

        // Drop the flags and the destination; what is left is the source list.
        const operands = args.filter(arg => !arg.startsWith('--'));
        sources.push(...operands.slice(0, -1));
    }

    return sources;
}

// `COPY package*.json ./` names two real files, and it is those the allowlist
// has to cover — a glob is only ever as good as what it currently matches.
function expandGlob(source) {
    if (!source.includes('*')) return [source];

    const dir = path.dirname(source);
    const pattern = new RegExp(`^${path.basename(source).split('*').map(part =>
        part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

    return fs.readdirSync(path.join(ROOT, dir))
        .filter(entry => pattern.test(entry))
        .map(entry => (dir === '.' ? entry : `${dir}/${entry}`));
}

describe('.dockerignore', () => {
    test('is an allowlist: the first pattern excludes everything', () => {
        expect(patterns()[0]).toBe('*');
    });

    test('re-includes only paths that exist', () => {
        for (const allowed of exceptions()) {
            expect(fs.existsSync(path.join(ROOT, allowed))).toBe(true);
        }
    });

    test('re-includes nothing sensitive', () => {
        // An exception is a prefix: `!config` would carry config/mcp-servers.json
        // back in with it, so a sensitive path counts as re-included when the
        // exception names it or any directory above it — unless a later pattern
        // excludes it again, which is what the mcp-servers.json line does.
        const laterExclusions = new Set(patterns().filter(p => !p.startsWith('!')));

        for (const secret of SENSITIVE) {
            if (laterExclusions.has(secret)) continue;

            const covering = exceptions().filter(allowed =>
                secret === allowed || secret.startsWith(`${allowed}/`),
            );

            expect({ secret, covering }).toEqual({ secret, covering: [] });
        }
    });

    test('re-includes every path the Dockerfile copies out of the context', () => {
        for (const source of contextCopySources()) {
            // `COPY . .` takes the context as a whole; the allowlist above is
            // exactly what decides what that means.
            if (source === '.') continue;

            for (const file of expandGlob(source)) {
                const covered = exceptions().some(allowed =>
                    file === allowed || file.startsWith(`${allowed}/`),
                );

                expect({ file, covered }).toEqual({ file, covered: true });
            }
        }
    });
});
