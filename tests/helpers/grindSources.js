'use strict';

const fs = require('fs');
const path = require('path');

// /fish, /hunt and /mine are folders rather than single files (#721): each is
// `commands/economy/<name>/index.js` plus the siblings it dispatches to.
// /explore is still one file.
//
// Guards that read a command's source have to keep reading all of it, or the
// split quietly shrinks what they cover — a check that used to scan the cast
// transaction would still pass while scanning only the dispatch. Everything
// that reads grind command source goes through here for that reason.

const COMMANDS_DIR = path.join(__dirname, '..', '..', 'src', 'commands', 'economy');

/** Every source file belonging to a grind command, in a stable order. */
function grindCommandFiles(name) {
    const single = path.join(COMMANDS_DIR, `${name}.js`);
    if (fs.existsSync(single)) return [single];

    const dir = path.join(COMMANDS_DIR, name);
    if (!fs.existsSync(dir)) throw new Error(`no command named ${name} under commands/economy`);

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
    // index.js first: it is the command, the rest are its parts.
    files.sort((a, b) => (a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b)));
    return files.map(f => path.join(dir, f));
}

/** Every source file of a grind command, concatenated. */
function grindCommandSource(name) {
    return grindCommandFiles(name).map(f => fs.readFileSync(f, 'utf8')).join('\n');
}

/** Repo-relative paths, for test names that should say which file failed. */
function grindCommandRelPaths(name) {
    const root = path.join(__dirname, '..', '..');
    return grindCommandFiles(name).map(f => path.relative(root, f).split(path.sep).join('/'));
}

module.exports = { grindCommandFiles, grindCommandSource, grindCommandRelPaths };
