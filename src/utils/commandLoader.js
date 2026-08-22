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

/**
 * A module is a usable command only if it can be both registered and run —
 * so the properties have to be callable, not merely present. Startup makes a
 * failure here fatal and the deploy publishes exactly the collection startup
 * builds, so a module that has an `execute` key holding a string is caught
 * here rather than at the moment someone runs the command.
 */
function isCommandModule(command) {
    return !!command
        && typeof command.execute === 'function'
        && typeof command.data?.toJSON === 'function';
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
            failures.push(`${entry.rel} (needs a callable execute and a data with toJSON)`);
            continue;
        }

        // The folder a command lives in is its category, and it is the only
        // record of that: `client.commands` is keyed by name, so by the time
        // /help reads the collection the directory walk is long gone. Stamping
        // it here keeps the category derived from disk rather than from a
        // hand-maintained list that drifts (#665). Modules are singletons in
        // the require cache, so this is idempotent across repeat loads.
        command.category = entry.dir;

        commands.push({ entry, command });
    }

    return { commands, failures };
}

module.exports = { listCommandFiles, loadCommandModules, isCommandModule, COMMANDS_ROOT };
