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
//
// The walk is recursive because the split went one level deeper (#917): each
// shop group is now `<name>/shop/` — index.js and a file per verb. A
// non-recursive readdir here would have dropped 800-odd lines of shop code out
// of every guard that reads this, silently and while staying green, which is
// the exact failure the paragraph above is about.

const COMMANDS_DIR = path.join(__dirname, '..', '..', 'src', 'commands', 'economy');

/** Every .js file under a directory, at any depth, sorted by relative path. */
function walk(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...walk(full));
        else if (entry.name.endsWith('.js')) found.push(full);
    }
    return found.sort();
}

/** Every source file belonging to a grind command, in a stable order. */
function grindCommandFiles(name) {
    const single = path.join(COMMANDS_DIR, `${name}.js`);
    if (fs.existsSync(single)) return [single];

    const dir = path.join(COMMANDS_DIR, name);
    if (!fs.existsSync(dir)) throw new Error(`no command named ${name} under commands/economy`);

    const files = walk(dir);
    // The command's own index.js first: it is the command, the rest are its
    // parts. A nested index.js (shop/index.js) is a part like any other.
    const top = path.join(dir, 'index.js');
    return files.sort((a, b) => (a === top ? -1 : b === top ? 1 : a.localeCompare(b)));
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
