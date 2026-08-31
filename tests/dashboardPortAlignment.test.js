'use strict';

/**
 * #650. The image's HEALTHCHECK and EXPOSE both hardcoded 3000 while the
 * production stack was read as running on 7001, so the check probed a port
 * nothing was listening on. Nothing broke, because portainer-stack.yml declares
 * a healthcheck of its own that overrode the image's — which is the worst
 * version of this: the mismatch was real, silent, and one deleted override away
 * from a container that reported unhealthy forever.
 *
 * The healthcheck was fixed under #641 and now reads DASHBOARD_PORT. What was
 * left was that nothing held the arrangement together, and it is spread across
 * four files that no one edits at the same time: the Dockerfile's EXPOSE, the
 * container side of each stack's port mapping, and the DASHBOARD_PORT default
 * each stack passes in.
 *
 * The distinction the whole thing turns on: DASHBOARD_HOST_PORT is a free
 * choice per deployment (compose 3000, Portainer 7001, and a reverse proxy
 * points at whichever), while DASHBOARD_PORT — the container's own side — is a
 * constant, because EXPOSE is image metadata that cannot follow a runtime
 * value. This asserts the constant, and asserts the healthchecks still read the
 * variable rather than reintroducing the literal.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

const dockerfile = read('Dockerfile');
const stacks = [
    ['docker-compose.yml', yaml.load(read('docker-compose.yml'))],
    ['portainer-stack.yml', yaml.load(read('portainer-stack.yml'))],
];

/** The `EXPOSE <port>` the runtime stage declares. */
const exposed = (() => {
    const line = dockerfile.split('\n').find(l => /^EXPOSE\s/.test(l));
    if (!line) throw new Error('the Dockerfile declares no EXPOSE');
    return Number(line.trim().split(/\s+/)[1]);
})();

/** `"127.0.0.1:${HOST:-x}:${CONTAINER:-y}"` -> the container half, verbatim. */
function containerSideOf(mapping) {
    // Splitting on ':' would cut the `${VAR:-default}` substitutions in half,
    // so take the last mapping segment by matching the substitution instead.
    const parts = String(mapping).match(/\$\{[^}]+\}/g) || [];
    return parts[parts.length - 1];
}

/** The default in a `${NAME:-default}` substitution. */
function defaultOf(substitution) {
    const m = /^\$\{[A-Z_]+:-([^}]*)\}$/.exec(substitution || '');
    return m ? m[1] : null;
}

describe('Dockerfile', () => {
    test('EXPOSEs the container-side port', () => {
        expect(exposed).toBe(3000);
    });

    test('its healthcheck reads DASHBOARD_PORT rather than the literal', () => {
        // The literal is still there as the fallback, which is correct — it is
        // the same constant EXPOSE declares. What must not come back is the
        // literal *alone*, with no way for a deployment that moves the port to
        // be probed on the one it moved to.
        const healthcheck = dockerfile.slice(dockerfile.indexOf('HEALTHCHECK'));
        expect(healthcheck).toContain('process.env.DASHBOARD_PORT');
        expect(healthcheck).toContain(`|| ${exposed}`);
    });
});

describe.each(stacks)('%s', (name, doc) => {
    const mapping = (doc.services.bot.ports || [])[0];

    test('maps a host port onto the port the image EXPOSEs', () => {
        const containerSide = containerSideOf(mapping);
        expect([name, defaultOf(containerSide)]).toEqual([name, String(exposed)]);
    });

    test('leaves the host side free to differ', () => {
        // Not cosmetic: compose binds 3000 and the production stack binds 7001,
        // and reading that difference as "production runs on 7001" is what #650
        // was. Both are the *host* side; the container is on 3000 in both.
        expect(String(mapping)).toMatch(/DASHBOARD_HOST_PORT:-\d+/);
    });

    test('its healthcheck probes DASHBOARD_PORT, defaulting to the same port', () => {
        const test_ = doc.services.bot.healthcheck.test.join(' ');
        expect([name, test_.includes('process.env.DASHBOARD_PORT')]).toEqual([name, true]);
        expect([name, test_.includes(`|| ${exposed}`)]).toEqual([name, true]);
    });
});

describe('portainer-stack.yml', () => {
    const doc = yaml.load(read('portainer-stack.yml'));

    test('passes DASHBOARD_PORT with the same default the image assumes', () => {
        // This stack lists environment as `KEY=value` strings rather than a
        // map, because Portainer's stack editor writes them that way.
        const env = doc.services.bot.environment;
        const entry = (Array.isArray(env) ? env : Object.entries(env).map(([k, v]) => `${k}=${v}`))
            .find(e => e.startsWith('DASHBOARD_PORT='));

        expect(entry).toBeDefined();
        expect(defaultOf(entry.split('=').slice(1).join('='))).toBe(String(exposed));
    });
});
