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
 * Every key a command module may export that something reads. `data` and
 * `execute` are the two isCommandModule enforces; the rest are the optional
 * hooks events/interactionCreate.js looks up by exact name, plus `category`,
 * which the loader stamps on below.
 *
 * docs/EXTENDING.md has the table, and tests/commandContractDocs.test.js holds
 * this list and that table to each other.
 */
const CONTRACT_KEYS = [
    'data',
    'execute',
    'cooldown',
    'cooldownAmount',
    'cooldownKey',
    'autocomplete',
    'requiredPermissions',
    'category',
];

// Distance in single-character edits between two strings. Small and iterative
// rather than recursive, because it runs over every exported key of every
// command file at startup.
function editDistance(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = a[i - 1] === b[j - 1]
                ? previous[j - 1]
                : 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
        }
        previous = current;
    }

    return previous[b.length];
}

/**
 * The optional hooks are read by exact key name and validated by nothing, so a
 * one-character slip is not an error — it is a key nobody reads. The command
 * loads, deploys and runs, and the hook never fires. On `requiredPermissions`
 * that is a security bug rather than an annoyance (#874): the gate silently
 * stops existing, and `setDefaultMemberPermissions` on the builder is only a
 * default a guild admin is free to reassign. Nothing surfaces it until someone
 * notices the command working for a member who should not have it.
 *
 * A command may still export whatever else it likes — several export helpers
 * their own button and modal handlers import — so an unknown key is only a
 * problem when it is a *near miss* of a contract key. Anything under a leading
 * underscore is left alone entirely, which is the escape hatch for a deliberate
 * field that happens to read like one.
 *
 * @returns {string[]} one message per suspected typo, empty when there is none
 */
function contractKeyTypos(command) {
    const contract = new Set(CONTRACT_KEYS);
    const problems = [];

    for (const key of Object.keys(command)) {
        if (contract.has(key) || key.startsWith('_')) continue;

        for (const valid of CONTRACT_KEYS) {
            // Two edits on the longer names, one on the short ones: `execute`
            // and up are long enough that a transposition (two edits, in this
            // metric) is a likelier explanation than a deliberate export, while
            // on `data` that budget would start flagging ordinary words.
            const budget = valid.length >= 7 ? 2 : 1;
            if (editDistance(key.toLowerCase(), valid.toLowerCase()) > budget) continue;

            problems.push(`exports \`${key}\`, which nothing reads — did you mean \`${valid}\`? `
                + '(rename it, or prefix it with _ if it is deliberate)');
            break;
        }
    }

    return problems;
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

        // A failure rather than a warning, for the same reason the check above
        // is one: a permission gate that is not spelled the way the handler
        // reads it does not exist, and a line in the startup log is not what
        // stands between a reassigned /ban and an ordinary member. Startup
        // refuses to come up, which is a deploy that never happens rather than
        // a command that quietly runs ungated.
        const typos = contractKeyTypos(command);
        if (typos.length) {
            for (const typo of typos) failures.push(`${entry.rel} ${typo}`);
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

module.exports = {
    listCommandFiles,
    loadCommandModules,
    isCommandModule,
    contractKeyTypos,
    CONTRACT_KEYS,
    COMMANDS_ROOT,
};
