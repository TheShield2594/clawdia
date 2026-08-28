'use strict';

/**
 * #644. `node:24-alpine` and `mongo:7` are floating tags: Docker Hub
 * re-publishes them on every patch of the line, so the same commit built on two
 * days produces two different runtimes — and a rebuild meant to roll a
 * regression back can quietly ship a *newer* base than the image it replaces.
 *
 * Every third-party image reference therefore carries an `@sha256:` digest.
 * These assertions are what notices when one loses it — a Dependabot bump that
 * rewrites the tag only, or a hand-edit during an incident.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const DIGEST = /@sha256:[0-9a-f]{64}$/;

// The bot's own image. `docker compose build` produces it and the Portainer
// stack pulls it, so there is no digest to pin to at the time the file is
// written — the tag is the interface between the two halves of the deploy.
// CLAWDIA_IMAGE_TAG is how a deploy names a specific build.
const OWN_IMAGE = 'ghcr.io/theshield2594/clawdia';

// Reads `image:` values out of a compose file as text rather than through a
// YAML parse, so commented-out services (the Portainer stack ships `autoheal`
// commented out) are checked too: uncommenting one should not be the moment the
// pinning silently lapses.
function imageRefs(file) {
    return [...read(file).matchAll(/^\s*#?\s*image:\s*(\S+)\s*$/gm)].map(m => m[1]);
}

describe('Dockerfile base images', () => {
    const froms = [...read('Dockerfile').matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]);

    it('has at least the build and runtime stages', () => {
        expect(froms.length).toBeGreaterThanOrEqual(2);
    });

    it.each(froms)('%s is pinned by digest', ref => {
        expect(ref).toMatch(DIGEST);
    });

    it('keeps the readable tag beside the digest', () => {
        // A bare `node@sha256:…` builds the same image but leaves nobody able to
        // tell which Node major it is without resolving the digest — and
        // tests/nodeVersionAlignment.test.js reads the major off this line.
        for (const ref of froms) expect(ref).toMatch(/^node:\d+[^@]*@sha256:/);
    });
});

describe.each(['docker-compose.yml', 'portainer-stack.yml'])('%s', file => {
    const refs = imageRefs(file);

    it('references at least the database and the bot', () => {
        expect(refs.length).toBeGreaterThanOrEqual(2);
    });

    it('pins every third-party image by digest', () => {
        const unpinned = refs
            .filter(ref => !ref.startsWith(OWN_IMAGE))
            .filter(ref => !DIGEST.test(ref));
        expect(unpinned).toEqual([]);
    });

    it('leaves the bot image on a tag, since compose is what builds it', () => {
        const own = refs.filter(ref => ref.startsWith(OWN_IMAGE));
        expect(own.length).toBeGreaterThan(0);
        for (const ref of own) expect(ref).toBe(`${OWN_IMAGE}:\${CLAWDIA_IMAGE_TAG:-latest}`);
    });
});

describe('the two stack files agree on the images they share', () => {
    const compose = imageRefs('docker-compose.yml');
    const stack = imageRefs('portainer-stack.yml');
    const byName = refs => {
        const map = new Map();
        for (const ref of refs) map.set(ref.split('@')[0].split(':')[0], ref);
        return map;
    };

    it('pins the same digest for every image present in both', () => {
        const a = byName(compose);
        const b = byName(stack);
        for (const [name, ref] of a) {
            if (!b.has(name)) continue;
            // Two digests for one image means one of the two files was bumped
            // and the other was not, so the production stack and the file it
            // was tested from are running different code.
            expect([name, b.get(name)]).toEqual([name, ref]);
        }
    });
});

describe('Dependabot', () => {
    const dependabot = read('.github/dependabot.yml');

    it('watches the docker ecosystem, so the pins do not rot', () => {
        // A digest that nothing bumps is a security problem of its own: the
        // build stops picking up base-image CVE fixes entirely.
        expect(dependabot).toMatch(/package-ecosystem:\s*docker/);
    });
});
