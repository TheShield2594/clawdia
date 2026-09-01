/**
 * #872. Three things had to be true together for the pre-migration backup to
 * work, and only two of them were.
 *
 * The runner shells out to `mongodump` before an irreversible migration, and
 * both stack files present the archive it writes as *the* way back from a bad
 * one — migrations here are forward-only, so it is the only way back there is.
 * But the runtime image installed cairo, pango and friends and no
 * mongodb-tools, so mongodump was not in it; and MIGRATION_BACKUP was unset
 * everywhere, which is the mode where a failed dump is a warning and the
 * destructive migration runs anyway. The dump could not be taken and nothing
 * stopped on its absence: operators had a recovery path that consisted of one
 * line in a startup log.
 *
 * This holds the three together. Any one of them going back to how it was is a
 * silent regression in the others.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const load = name => yaml.load(read(name));

// The runtime stage is the last one in the file: it is what ships, and the
// packages the earlier stages install are left behind with them.
function runtimeStage() {
    const dockerfile = read('Dockerfile');
    const stages = dockerfile.split(/^FROM /m);
    return stages[stages.length - 1];
}

// The commands the runner spawns for the dump. Read out of the source so that
// swapping mongodump for something else fails here rather than at the boot
// that needed it.
function spawnedBinaries() {
    const runner = read('src/migrations/runner.js');
    return [...runner.matchAll(/spawnSync\(\s*'([^']+)'/g)].map(m => m[1]);
}

describe('pre-migration backup', () => {
    it('is taken with mongodump', () => {
        expect(spawnedBinaries()).toContain('mongodump');
    });

    it('has that binary in the image it runs in', () => {
        // mongodb-tools is the apk that carries mongodump (and mongorestore,
        // which is what scripts/restore.sh needs to read the archive back).
        expect(runtimeStage()).toMatch(/\bmongodb-tools\b/);
    });

    it.each([['docker-compose.yml'], ['portainer-stack.yml']])(
        '%s defaults MIGRATION_BACKUP to require',
        name => {
            const env = load(name).services.bot.environment;

            // compose takes a mapping, the Portainer stack a NAME=value list.
            const value = Array.isArray(env)
                ? env.map(String).find(entry => entry.startsWith('MIGRATION_BACKUP='))?.slice('MIGRATION_BACKUP='.length)
                : env?.MIGRATION_BACKUP;

            // `${MIGRATION_BACKUP:-require}` rather than a bare `require`, so an
            // operator who wants the old warn-and-continue can still say so
            // without editing the stack file.
            expect([name, value]).toEqual([name, '${MIGRATION_BACKUP:-require}']);
        },
    );
});
