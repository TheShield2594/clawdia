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

    // #899. The loop's own failure handling was `|| echo "[backup] FAILED"`
    // into a log stream nobody tails, after which it slept until the next day.
    // Nothing else noticed: no healthcheck, so the container stayed Up and
    // every dashboard showed green while the archives went stale. These four
    // are the pieces that make a stale backup visible.
    describe('backup failures are visible (#899)', () => {
        // Comments are stripped throughout: this file and the YAML both discuss
        // the thing being asserted in prose that would otherwise match.
        const entrypoint = String(doc.services.backup.entrypoint)
            .split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

        it('health-checks the artifact rather than the process', () => {
            const check = doc.services.backup.healthcheck;
            expect([name, check]).not.toEqual([name, undefined]);
            const test = String(check.test);
            // A liveness probe here would always pass — the loop is a `sleep`,
            // and it survives every failure it can have. The freshness of a
            // written archive is the only thing worth asserting.
            expect(test).toContain('.backup-ok');
            // 26h: a day's schedule plus room for the dump itself to run long.
            expect(test).toMatch(/-mmin\s+-1560\b/);
            // Long enough for the boot catch-up below to finish a first dump,
            // so a cold start does not report unhealthy on its way up.
            expect([name, check.start_period]).toEqual([name, '1h']);
        });

        it('only marks healthy for a run that produced a usable archive', () => {
            // The marker the healthcheck reads must be written after the
            // verification, not after mongodump — a dump that exits 0 having
            // written a truncated file is the failure this is guarding.
            const ok = entrypoint.indexOf('touch "$$OK_MARKER"');
            const verified = entrypoint.indexOf('--dryRun');
            expect([name, ok]).not.toEqual([name, -1]);
            expect([name, verified]).not.toEqual([name, -1]);
            expect([name, verified < ok]).toEqual([name, true]);
            // And an archive that fails it is moved out of the way, so neither
            // the catch-up below nor `verify-backup.sh --latest` picks it up as
            // the day's backup.
            expect(entrypoint).toContain('mv "$$ARCHIVE" "$$ARCHIVE.unverified"');
            // Still pruned, or a quarantined archive would live forever.
            expect(entrypoint).toContain('-name "clawdia-*.gz.unverified"');
        });

        it('reports a failure somewhere a human is', () => {
            expect(entrypoint).toContain('ERROR_WEBHOOK_URL');
            // Both failure paths, not just the dump: an archive that will not
            // parse back is the one that stays invisible until the restore.
            const notifies = entrypoint.match(/notify "/g) || [];
            expect([name, notifies.length]).toEqual([name, 2]);
            // Never fatal and never slow — the next run matters more than the
            // post landing, and this runs in a container with no supervisor.
            expect(entrypoint).toMatch(/curl -fsS --max-time 10/);
        });

        it('catches up on boot instead of skipping the day', () => {
            // A container that was not running at 03:00 used to wait a full day
            // and say nothing; with the healthcheck above, that gap would read
            // as a fault. Closed rather than reported.
            const beforeLoop = entrypoint.slice(0, entrypoint.indexOf('while true'));
            expect(beforeLoop).toMatch(/-mmin\s+-1440\b/);
            expect(beforeLoop).toContain('run_backup');
        });
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

    it('wires MongoDB authentication the same way in both (#648)', () => {
        // Opt-in, not forced: the `:-` empty default is what lets an existing
        // deployment keep starting with auth off until it migrates. Dropping
        // it — or renaming a variable in one file only — would either break
        // every running deploy or split the two deploy paths.
        for (const [name, doc] of stacks) {
            const env = doc.services.mongodb.environment;
            expect([name, env.MONGO_INITDB_ROOT_USERNAME]).toEqual([name, '${MONGODB_ROOT_USERNAME:-}']);
            expect([name, env.MONGO_INITDB_ROOT_PASSWORD]).toEqual([name, '${MONGODB_ROOT_PASSWORD:-}']);
            // Read by scripts/mongo-init.js to create the low-privilege user
            // the bot connects as.
            expect([name, env.MONGODB_APP_USERNAME]).toEqual([name, '${MONGODB_APP_USERNAME:-}']);
            expect([name, env.MONGODB_APP_PASSWORD]).toEqual([name, '${MONGODB_APP_PASSWORD:-}']);
        }
        // Only compose can mount the init script from the checkout; the
        // Portainer stack documents a host-path mount instead (no checkout).
        const composeMounts = compose.services.mongodb.volumes.map(String);
        expect(composeMounts).toContain('./scripts/mongo-init.js:/docker-entrypoint-initdb.d/mongo-init.js:ro');
    });

    // #901. The compose backup service carried `env_file: .env` on top of the
    // two variables it needs, so a stock mongo container that dumps a database
    // also held the Discord bot token, the session secret and every AI provider
    // key — readable from `docker inspect` and from inside the container. The
    // Portainer stack had always passed just the two, which made this a parity
    // gap as well as an exposure, and parity is the thing that keeps it closed.
    it('gives the backup service only the variables it needs, in both', () => {
        const names = env => (Array.isArray(env)
            ? env.map(e => String(e).split('=')[0])
            : Object.keys(env || {}));

        for (const [name, doc] of stacks) {
            const backup = doc.services.backup;
            // No wholesale .env. The `${...}` defaults in `environment:` still
            // read it — Compose interpolates the .env beside the file whatever
            // a service declares — so this costs the deploy nothing.
            expect([name, backup.env_file]).toEqual([name, undefined]);
            // And what it does name is the dump's two inputs, plus the sink
            // its failures go to (#899), and nothing else. The rule is "no
            // variable this container has no use for" — not a count — so a
            // fourth name here needs a reason of the same kind, not a bump.
            expect([name, names(backup.environment).sort()])
                .toEqual([name, ['BACKUP_RETENTION_DAYS', 'ERROR_WEBHOOK_URL', 'MONGODB_URI']]);
        }

        // The bot is the service that legitimately wants the whole file, and
        // the contrast is the point: this is not an argument against env_file,
        // it is an argument against giving it to a container with no use for it.
        expect(compose.services.bot.env_file).toEqual(['.env']);
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
