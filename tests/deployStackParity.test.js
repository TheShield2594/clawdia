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
            // Every failure path, not just the dump: an archive that will not
            // parse back is the one that stays invisible until the restore, and
            // #886 added two more ways for a run to end without an archive.
            // Asserted as "every giving-up point reports" rather than as a count,
            // because a count is satisfied by two reports on one path and says
            // nothing about a third path that was added silently.
            const body = entrypoint.slice(entrypoint.indexOf('run_backup() {'), entrypoint.indexOf('touch "$$OK_MARKER"'));
            const gaveUp = body.split('return 1;');
            // Four ways to end without an archive — the dump, the seal, the
            // decrypt-back and the parse-back — so five segments around them.
            expect([name, gaveUp.length]).toEqual([name, 5]);
            for (const segment of gaveUp.slice(0, -1)) {
                expect([name, /notify "[^"]+";\s*$/.test(segment.trim())]).toEqual([name, true]);
            }
            // Never fatal and never slow — the next run matters more than the
            // post landing, and this runs in a container with no supervisor.
            expect(entrypoint).toMatch(/curl -fsS --max-time 10/);
        });

        it('vets the sink the way the bot vets the same variable', () => {
            // src/utils/errorReporter.js allows https anywhere and http only to
            // loopback, and refuses anything else rather than downgrading it.
            // The report names a database host and an archive path; a sink the
            // bot refuses must not be honoured here because the poster happens
            // to be curl in a shell.
            expect(entrypoint).toContain('sink_allowed');
            expect(entrypoint).toMatch(/https:\/\/\*\)/);
            for (const loopback of ['localhost', '127.0.0.1', '::1']) {
                expect([name, loopback, entrypoint.includes(loopback)]).toEqual([name, loopback, true]);
            }
            // The refusal is said out loud; a silently dropped report is the
            // failure mode this whole section exists to remove.
            expect(entrypoint).toMatch(/Ignoring ERROR_WEBHOOK_URL/);
        });

        it('quarantines what a failed dump left behind', () => {
            // mongodump has no rollback: killed part-way it leaves whatever it
            // wrote under the real name. Left there, that partial file is what
            // the boot catch-up counts as the day's backup and what
            // `verify-backup.sh --latest` picks up — a failure that reads as a
            // success. It goes under the same suffix a failed verification uses,
            // so it stays off both globs and inside the prune.
            const dumpFailure = entrypoint.slice(
                entrypoint.indexOf('if ! mongodump'),
                entrypoint.indexOf('--dryRun'));
            expect(dumpFailure).toContain('mv "$$ARCHIVE" "$$ARCHIVE.unverified"');
            // Guarded: a dump that failed before creating the file at all must
            // not turn the failure into a `mv` error on top of it.
            expect(dumpFailure).toContain('if [ -e "$$ARCHIVE" ]');
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

    // #886. `mongodump --gzip` is compression, not encryption: every archive in
    // the backup directory was a readable copy of the whole database, and thirty
    // days of them were kept beside the database itself.
    describe('archives can be encrypted (#886)', () => {
        const entrypoint = String(doc.services.backup.entrypoint)
            .split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

        it('takes the passphrase from a variable or a file, like the URI', () => {
            expect(entrypoint).toContain('BACKUP_ENCRYPTION_PASSPHRASE_FILE');
            expect(entrypoint).toMatch(/BACKUP_ENCRYPTION_PASSPHRASE=\$+\(tr -d/);
        });

        it('refuses to start rather than writing plaintext it was asked to seal', () => {
            // Downgrading silently is worse than never offering the feature: an
            // operator who believes the archives are encrypted stops thinking
            // about who can read the directory.
            const guard = entrypoint.slice(entrypoint.indexOf('command -v openssl'));
            expect(guard).toMatch(/exit 1/);
        });

        it('keeps the plaintext dump out of the archive directory entirely', () => {
            // Not even for the seconds between the dump and the seal: that
            // directory being readable is the whole premise of the feature.
            const run = entrypoint.slice(entrypoint.indexOf('run_backup() {'));
            expect(run).toMatch(/WORK=\/tmp\/clawdia-/);
            expect(run).toMatch(/mongodump [^;]*--archive="\$+WORK"/);
        });

        it('verifies the archive it kept, not the one it threw away', () => {
            // The sealed file is what a restore will be handed, so an archive
            // that will not decrypt is as lost as one that will not parse.
            const run = entrypoint.slice(entrypoint.indexOf('run_backup() {'));
            const sealed = run.indexOf('openssl enc -aes-256-cbc');
            const opened = run.indexOf('openssl enc -d');
            const parsed = run.indexOf('--dryRun');
            expect([name, sealed]).not.toEqual([name, -1]);
            expect([name, sealed < opened && opened < parsed]).toEqual([name, true]);
            // argv is readable from the host with no access to the container.
            expect(run).not.toMatch(/-pass pass:/);
            expect(run).toContain('-pass env:BACKUP_ENCRYPTION_PASSPHRASE');
        });

        it('ages the sealed archives out on the same retention window', () => {
            // `-name "clawdia-*.gz"` does not match `clawdia-*.gz.enc`, so an
            // encrypted install would have kept every archive it ever wrote.
            const prune = entrypoint.slice(entrypoint.indexOf('prune() {'), entrypoint.indexOf('run_backup() {'));
            for (const glob of ['clawdia-*.gz.enc', 'clawdia-*.gz.enc.unverified']) {
                expect([name, glob, prune.includes(glob)]).toEqual([name, glob, true]);
            }
            // And the boot catch-up counts them as the day's backup, or an
            // encrypted install would re-dump on every restart.
            const beforeLoop = entrypoint.slice(0, entrypoint.indexOf('while true'));
            const catchUp = beforeLoop.slice(beforeLoop.lastIndexOf('if [ -z'));
            expect([name, catchUp.includes('clawdia-*.gz.enc')]).toEqual([name, true]);
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
            // BACKUP_ENCRYPTION_PASSPHRASE is the fourth, and it earns its place
            // by the same rule rather than by relaxing it: this container is the
            // only thing that writes the archives, so it is the only thing that
            // can seal them (#886). It is a variable this container uses.
            expect([name, names(backup.environment).sort()])
                .toEqual([name, [
                    'BACKUP_ENCRYPTION_PASSPHRASE', 'BACKUP_RETENTION_DAYS',
                    'ERROR_WEBHOOK_URL', 'MONGODB_URI',
                ]]);
        }

        // The bot is the service that legitimately wants the whole file, and
        // the contrast is the point: this is not an argument against env_file,
        // it is an argument against giving it to a container with no use for it.
        expect(compose.services.bot.env_file).toEqual(['.env']);
    });

    // #891. The replica set is what makes MongoDB's multi-document transactions
    // available at all, and it is three things that only work together: the flag
    // on mongod, the one-time initiation, and a healthcheck that does not go
    // green before the initiation has happened. Two of the three in one file and
    // three in the other would be a deploy that starts the bot against a node
    // that refuses every write.
    it('can be made a replica set, the same way, in both', () => {
        for (const [name, doc] of stacks) {
            // A single opt-in variable that defaults to nothing: unset, this is
            // the image's own `mongod` and every existing deployment is
            // untouched. `--replSet` and, when auth is on, `--keyFile` both go
            // in it, because MongoDB requires internal authentication for an
            // authenticated replica set and refuses to start without the file.
            expect([name, doc.services.mongodb.command])
                .toEqual([name, 'mongod ${MONGODB_REPLICA_SET_ARGS:-} ${MONGODB_TLS_ARGS:-}']);
        }
    });

    it('initiates the set with a one-shot container, identically in both', () => {
        const [a, b] = stacks.map(([, doc]) => doc.services['mongo-replset-init']);
        expect(a).toBeDefined();
        // Byte-identical rather than "both have one". The whole of the logic is
        // an inline shell script, and a fix applied to one copy and not the
        // other is the failure mode this file exists for.
        expect(b).toEqual(a);

        // Started with mongod, not gated on it being healthy: mongod is not
        // healthy until this has run, so a `service_healthy` condition here
        // would be a deadlock rather than an ordering.
        expect(a.depends_on).toEqual(['mongodb']);
        expect(a.restart).toBe('no');
        expect(a.networks).toEqual(['db-network']);
    });

    it('holds mongod unhealthy until it will accept a write', () => {
        for (const [name, doc] of stacks) {
            const probe = doc.services.mongodb.healthcheck.test.join(' ');
            // `ping` answers for a replica-set member that has no config yet, so
            // it would report a node healthy that refuses every read and write —
            // and the bot runs its migrations at boot. `hello` is answered
            // without authentication just as `ping` was, so this still works on
            // an authenticated deployment, and a standalone mongod reports
            // itself writable as soon as it is up.
            expect([name, probe]).toEqual([name, expect.stringContaining('isWritablePrimary')]);
            expect([name, probe]).not.toEqual([name, expect.stringContaining("adminCommand('ping')")]);
        }
    });

    // #975. Nothing on db-network used TLS, so with authentication on a process
    // that had joined that network could still read every balance, every audit
    // entry and every administrative command off the wire — including the root
    // session mongo-replset-init uses to initiate the set. Turning it on is
    // opt-in, and the property that has to hold is that it is opt-in for *all
    // five* clients at once: mongod plus one client still speaking cleartext is
    // not a weaker deployment, it is a deployment that cannot reach its own
    // database. That is what this asserts, because it is the only place it can
    // be asserted — the alternative is finding out on the redeploy.
    describe('TLS on db-network is all of it or none of it (#975)', () => {
        const CERT_MOUNT = /mongo-tls:\/etc\/mongo-tls:ro/g;

        it('lets mongod be given TLS flags, the same way, in both', () => {
            for (const [name, doc] of stacks) {
                // Beside the replica-set flags rather than merged into them:
                // one deployment may want a replica set and no TLS, another the
                // reverse, and a single variable holding both makes turning one
                // off mean retyping the other.
                expect([name, String(doc.services.mongodb.command)])
                    .toEqual([name, expect.stringContaining('${MONGODB_TLS_ARGS:-}')]);
            }
        });

        it('tells both mongosh probes to speak it', () => {
            for (const [name, doc] of stacks) {
                // These two reach mongod by host and port, so unlike every other
                // client here they have no connection string to carry the
                // options and must be told separately.
                const probe = doc.services.mongodb.healthcheck.test;
                // CMD-SHELL, because unset the variable has to expand to no
                // arguments at all and an exec-form list would pass mongosh a
                // single empty string instead.
                expect([name, probe[0]]).toEqual([name, 'CMD-SHELL']);
                expect([name, probe.join(' ')])
                    .toEqual([name, expect.stringContaining('${MONGODB_CLIENT_TLS_ARGS:-}')]);

                const init = doc.services['mongo-replset-init'];
                expect([name, Object.keys(init.environment)])
                    .toEqual([name, expect.arrayContaining(['MONGODB_CLIENT_TLS_ARGS'])]);
                // Every mongosh in that script, not merely one of them: the
                // wait loop, the writable probe and the authenticated call are
                // three separate connections and a mongod in requireTLS mode
                // refuses whichever one was missed.
                // `mongosh --host` and not `mongosh`: the script also calls its
                // own authed_mongosh wrapper, whose name ends in the same word.
                const invocations = String(init.entrypoint).match(/mongosh --host[^;]*/g) || [];
                expect([name, invocations.length]).toEqual([name, 4]);
                for (const call of invocations) {
                    expect([name, call]).toEqual([name, expect.stringContaining('$$MONGODB_CLIENT_TLS_ARGS')]);
                }
            }
        });

        it('leaves the URI clients to the URI, and passes them no flags', () => {
            for (const [name, doc] of stacks) {
                // The bot, mongodump and mongorestore all take a connection
                // string, so `tls=true&tlsCAFile=...` on MONGODB_URI configures
                // all three in one edit and there is no second setting to
                // disagree with it. Passing the tools CLI flags *as well* is the
                // way to get "cannot specify different ssl configuration in the
                // connection URI and as a command line option" at 03:00.
                expect([name, String(doc.services.backup.entrypoint)])
                    .not.toEqual([name, expect.stringContaining('MONGODB_CLIENT_TLS_ARGS')]);
            }
        });

        it('offers the certificate to every container that needs it', () => {
            for (const [name] of stacks) {
                // Commented out, like the key-file mount beside it, so this
                // reads the file rather than the parsed YAML. Four: mongod
                // serves the certificate, and mongo-replset-init, bot and backup
                // each validate against the CA in it.
                const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
                expect([name, (text.match(CERT_MOUNT) || []).length]).toEqual([name, 4]);
            }
        });

        it('is issued by a script that names the same three settings', () => {
            // The script prints the settings to apply once it has written the
            // certificate. Three copies of these names exist — here, the stack
            // comments, and SETUP_GUIDE — and the one an operator pastes from is
            // the script.
            const script = fs.readFileSync(path.join(ROOT, 'scripts/mongo-tls-cert.sh'), 'utf8');
            for (const setting of ['MONGODB_CLIENT_TLS_ARGS', 'MONGODB_URI', 'MONGODB_TLS_ARGS']) {
                expect([setting, script.includes(setting)]).toEqual([setting, true]);
            }
            // Naming a CA file makes mongod demand a client certificate from
            // everything that connects, and nothing here has one — this is
            // server authentication, not mutual TLS. Without this flag the CA
            // file turns every client away, which is a deployment that starts
            // and then refuses the bot.
            expect(script).toContain('--tlsAllowConnectionsWithoutCertificates');
        });
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
