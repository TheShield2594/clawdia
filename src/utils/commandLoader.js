const fs = require('fs');
const path = require('path');

// The one walk of src/commands, shared by startup (src/index.js), the deploy
// (src/utils/commandDeployer.js) and the cap guard (tests/commandCap.test.js).
// It used to be three copies: startup required every file, the deployer walked
// the same tree and required it all a second time, and the test kept its own
// glob. A guard that scans a different set than the deploy does is not a guard,
// and a second require of 98 files is 800 ms of startup nobody was buying
// anything with (#607).

const COMMANDS_ROOT = path.join(__dirname, '../commands');

/**
 * Every top-level command, as one entry each. Two layouts count as a command:
 *
 *   commands/<category>/<name>.js          — a single-file command
 *   commands/<category>/<name>/index.js    — a command split across a folder
 *
 * The folder form is what lets a command that has outgrown one file (fish,
 * hunt, mine — #721) split into `index.js` + siblings without silently
 * registering its helper files as commands of their own. Only `index.js` is a
 * command; everything beside it is an implementation detail of that command.
 *
 * @param {string} [foldersPath] root to walk; defaults to src/commands
 * @returns {Array<{dir: string, file: string, rel: string, full: string}>}
 */
function listCommandFiles(foldersPath = COMMANDS_ROOT) {
    const files = [];

    for (const category of fs.readdirSync(foldersPath, { withFileTypes: true })) {
        if (!category.isDirectory()) continue;
        const categoryPath = path.join(foldersPath, category.name);

        for (const entry of fs.readdirSync(categoryPath, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.js')) {
                files.push({
                    dir: category.name,
                    file: entry.name,
                    rel: `${category.name}/${entry.name}`,
                    full: path.join(categoryPath, entry.name),
                });
                continue;
            }

            if (!entry.isDirectory()) continue;
            const indexPath = path.join(categoryPath, entry.name, 'index.js');
            if (!fs.existsSync(indexPath)) continue;

            files.push({
                dir: category.name,
                file: `${entry.name}/index.js`,
                rel: `${category.name}/${entry.name}/index.js`,
                full: indexPath,
            });
        }
    }

    return files;
}

/** A module is a usable command only if it can be both registered and run. */
function isCommandModule(command) {
    return !!command && 'data' in command && 'execute' in command;
}

/**
 * Require every command once and hand back both the loaded modules and the
 * files that would not load. Callers decide what a failure means: startup logs
 * and carries on with the rest, the deploy refuses to publish a truncated set.
 *
 * @param {string} [foldersPath]
 * @returns {{commands: Array<{entry: object, command: object}>, failures: string[]}}
 */
function loadCommandModules(foldersPath = COMMANDS_ROOT) {
    const commands = [];
    const failures = [];

    for (const entry of listCommandFiles(foldersPath)) {
        let command;
        try {
            command = require(entry.full);
        } catch (error) {
            failures.push(`${entry.rel} (${error.message})`);
            continue;
        }

        if (!isCommandModule(command)) {
            failures.push(`${entry.rel} (missing data/execute)`);
            continue;
        }

        commands.push({ entry, command });
    }

    return { commands, failures };
}

module.exports = { listCommandFiles, loadCommandModules, isCommandModule, COMMANDS_ROOT };
