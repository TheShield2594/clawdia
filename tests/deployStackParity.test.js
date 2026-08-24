/**
 * #641. The backup service and its volume existed only in docker-compose.yml,
 * and were gated behind `profiles: [backup]` even there — so the production
 * Portainer deploy, which is what portainer-stack.yml describes, had no
 * automated backups at all. Migrations here are destructive and forward-only,
 * which makes that the difference between a bad migration costing an hour and
 * costing the database.
 *
 * The two files cannot be identical: one builds from a checkout and reads a
 * .env, the other pulls a published image and takes explicit environment
 * mappings. This asserts the parts that must not diverge, and nothing else.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const load = name => yaml.load(fs.readFileSync(path.join(ROOT, name), 'utf8'));

const compose = load('docker-compose.yml');
const stack = load('portainer-stack.yml');
const stacks = [['docker-compose.yml', compose], ['portainer-stack.yml', stack]];

describe.each(stacks)('%s', (name, doc) => {
    it('runs a backup service', () => {
        expect(Object.keys(doc.services)).toContain('backup');
    });

    it('runs it by default, not behind a profile', () => {
        // A profiled service is absent from a plain `up -d`, which is how the
        // production deploy came to have no backups.
        expect([name, doc.services.backup.profiles]).toEqual([name, undefined]);
        expect(doc.services.backup.restart).toBe('unless-stopped');
    });

    it('waits for a healthy database before dumping it', () => {
        expect(doc.services.backup.depends_on.mongodb.condition).toBe('service_healthy');
    });

    it('writes archives somewhere that survives the container', () => {
        const mounts = doc.services.backup.volumes.map(String);
        expect(mounts.some(m => m.endsWith(':/backups'))).toBe(true);
    });

    it('keeps the bot pre-migration dump on that same durable storage', () => {
        // src/migrations/runner.js writes /app/backups before an irreversible
        // migration. With no mount there, the next image pull destroys it.
        const mounts = (doc.services.bot.volumes || []).map(String);
        const backupMount = mounts.find(m => m.endsWith(':/app/backups'));
        expect([name, backupMount]).not.toEqual([name, undefined]);

        const source = backupMount.split(':')[0];
        const target = doc.services.backup.volumes.map(String)
            .find(m => m.endsWith(':/backups')).split(':')[0];
        // Same source on both sides, so the nightly prune ages out the
        // pre-migration archives too instead of letting them accumulate.
        expect([name, source]).toEqual([name, target]);
    });

    it('declares any named volume it mounts', () => {
        const declared = Object.keys(doc.volumes || {});
        const named = Object.values(doc.services)
            .flatMap(svc => (svc.volumes || []).map(String))
            .map(m => m.split(':')[0])
            // Bind mounts start with . or /; anything else is a named volume.
            .filter(src => !src.startsWith('.') && !src.startsWith('/'));
        expect(named.filter(v => !declared.includes(v))).toEqual([]);
    });

    it('prunes on a retention window it does not hardcode', () => {
        const entrypoint = String(doc.services.backup.entrypoint);
        expect(entrypoint).toMatch(/BACKUP_RETENTION_DAYS/);
        expect(entrypoint).toMatch(/-mtime \+\$+RETAIN/);
        // The bot's own dumps use a third prefix and were ageing out nowhere.
        for (const prefix of ['clawdia-', 'ultrabot-', 'pre-migration-']) {
            expect([prefix, entrypoint.includes(`${prefix}*.gz`)]).toEqual([prefix, true]);
        }
    });

    it('re-aims at 03:00 each night rather than sleeping a fixed day', () => {
        // Comments stripped: this file explains the bug in prose that would
        // otherwise match the pattern the assertion is looking for.
        const entrypoint = String(doc.services.backup.entrypoint)
            .split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
        // `sleep 86400` after the dump starts every run later than the last by
        // however long the dump took, walking the schedule into working hours.
        expect([name, /sleep\s+86400/.test(entrypoint)]).toEqual([name, false]);
        // The next-boundary arithmetic has to sit inside the loop for the
        // schedule to be re-aimed at all.
        const loop = entrypoint.slice(entrypoint.indexOf('while true'));
        expect([name, loop.includes('10800')]).toEqual([name, true]);
        expect([name, /sleep\s+\$+SLEEP/.test(loop)]).toEqual([name, true]);
    });

    it('serves the dashboard on the port the image exposes', () => {
        const env = doc.services.bot.environment;
        const asMap = Array.isArray(env)
            ? Object.fromEntries(env.map(e => {
                const i = String(e).indexOf('=');
                return [String(e).slice(0, i), String(e).slice(i + 1)];
            }))
            : (env || {});
        // docker-compose.yml takes DASHBOARD_PORT from .env, so it may be
        // absent there; when it is set it must resolve to the image's port.
        if (asMap.DASHBOARD_PORT !== undefined) {
            expect([name, asMap.DASHBOARD_PORT]).toEqual([name, '${DASHBOARD_PORT:-3000}']);
        }
        // The container side of the published mapping is what has to match.
        const published = doc.services.bot.ports.map(String);
        expect(published.every(p => p.endsWith(':${DASHBOARD_PORT:-3000}'))).toBe(true);
    });

    it('health-checks the port it is actually listening on', () => {
        const test = String(doc.services.bot.healthcheck.test);
        expect(test).toContain('DASHBOARD_PORT');
        expect(test).not.toMatch(/127\.0\.0\.1:\d+\//);
    });
});

describe('the two files agree where they must', () => {
    it('backs up on the same schedule and to the same archive names', () => {
        const strip = e => String(e)
            .split('\n')
            // Comments describe each file's own storage ("directory" for the
            // bind mount, "volume" for the named one) and are allowed to differ.
            .filter(line => !line.trim().startsWith('#'))
            .join(' ')
            .replace(/\s+/g, ' ')
            // The path is the other intended difference: a Portainer stack has
            // no checkout to bind-mount, so it uses a named volume.
            .replace(/\/backups/g, 'BACKUPS');
        expect(strip(stack.services.backup.entrypoint))
            .toBe(strip(compose.services.backup.entrypoint));
    });

    it('runs the same mongo and bot images', () => {
        expect(stack.services.mongodb.image).toBe(compose.services.mongodb.image);
        // compose builds the image; tagging it with the name the stack pulls is
        // what makes `docker compose build && push` feed the production deploy.
        expect(stack.services.bot.image).toBe(compose.services.bot.image);
        expect(compose.services.bot.build).toBeDefined();
    });

    it('keeps MongoDB on an internal network in both', () => {
        for (const [name, doc] of stacks) {
            expect([name, doc.networks['db-network'].internal]).toEqual([name, true]);
            expect([name, doc.services.mongodb.ports]).toEqual([name, undefined]);
        }
    });

    it('gives the two services the same MONGODB_URI default', () => {
        const defaultOf = text => /\$\{MONGODB_URI:-([^}]+)\}/.exec(String(text))?.[1];
        const botDefault = defaultOf(JSON.stringify(stack.services.bot.environment));
        expect(botDefault).toBe('mongodb://mongodb:27017/ultrabot');
        for (const [name, doc] of stacks) {
            const backupDefault = defaultOf(JSON.stringify(doc.services.backup.environment));
            expect([name, backupDefault]).toEqual([name, botDefault]);
        }
    });
});

describe('Dockerfile', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

    it('health-checks whatever port DASHBOARD_PORT names', () => {
        const line = dockerfile.split('\n').find(l => /^\s*CMD\s+node\s+-e/.test(l));
        // Anchored on content rather than indentation: a reformat used to make
        // this `undefined` and Jest reported a null-receiver error instead of
        // the port regression the test exists to catch.
        expect(line).toBeDefined();
        expect(line).toContain('process.env.DASHBOARD_PORT');
        // Hardcoded, it reported unhealthy forever on any deploy that moved the
        // port — which is exactly what portainer-stack.yml had done.
        expect(line).not.toMatch(/127\.0\.0\.1:\d+\//);
    });
});
