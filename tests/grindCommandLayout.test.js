'use strict';

const fs = require('fs');
const path = require('path');

const { listCommandFiles } = require('../src/utils/commandLoader');
const { grindCommandFiles, grindCommandRelPaths } = require('./helpers/grindSources');

// #721: fish.js (3,178 lines), hunt.js (3,476) and mine.js (2,806) were the
// three largest files in the repo, each holding forty-odd top-level functions —
// dispatch, embeds, shop, craft, quests, repairs, locations — beside a service
// layer that already existed for exactly that logic. Each is now a folder.
//
// #917 took it one level further. The split had stopped at the verb group, and
// the groups kept growing: the three shops were 822, 828 and 635 lines, the
// largest files in the repo after it. Each shop is a folder of its own now —
// index.js and a file per verb — so a grind command is a folder that contains
// folders.
//
// Three things have to keep holding for any of it to be worth anything: the
// folders register as one command each rather than one per file, no single
// file grows back into what was just split, and the guards that read this
// source keep reading all of it rather than only the top level.

const GRINDS = ['fish', 'hunt', 'mine'];
const ECONOMY = path.join(__dirname, '..', 'src', 'commands', 'economy');

describe('the split grind commands', () => {
    test.each(GRINDS)('/%s is a folder with an index, not a single file', name => {
        expect(fs.existsSync(path.join(ECONOMY, `${name}.js`))).toBe(false);
        expect(fs.existsSync(path.join(ECONOMY, name, 'index.js'))).toBe(true);
        expect(grindCommandFiles(name).length).toBeGreaterThan(3);
    });

    // The failure this guards is the loud one: if the loader counted each file
    // in the folder, /fish would register ten commands and the deploy would
    // blow through Discord's hard limit of 100, which rejects the entire
    // payload rather than truncating it.
    test.each(GRINDS)('/%s registers as exactly one command', name => {
        const registered = listCommandFiles().filter(f => f.rel.startsWith(`economy/${name}/`));

        expect(registered).toHaveLength(1);
        expect(registered[0].rel).toBe(`economy/${name}/index.js`);
    });

    test.each(GRINDS)('/%s still exports a runnable command', name => {
        const command = require(path.join(ECONOMY, name));

        expect(command.data.name).toBe(name);
        expect(typeof command.execute).toBe('function');
    });

    // index.js is the command definition and the dispatch, nothing else. The
    // SlashCommandBuilder for these is genuinely ~200 lines, so this sits above
    // that and below anything that would mean logic crept back in.
    test.each(GRINDS)('/%s index.js holds the definition and the dispatch only', name => {
        const index = fs.readFileSync(path.join(ECONOMY, name, 'index.js'), 'utf8');

        expect(index.split('\n').length).toBeLessThan(300);
        // Every handler comes from a sibling; none is defined here.
        expect(index).not.toMatch(/^async function /m);
    });

    // The number is not sacred — it is roughly a quarter of what the smallest of
    // the three was before, and it came down from 900 when #917 split the
    // shops. What matters is that it fails before any one file is back to being
    // the thing this issue was about.
    //
    // It is deliberately tighter than the repo-wide cap the lint rule enforces
    // (eslint-rules/command-file-size.js, currently 900): these three are the
    // commands that have already been through this twice, so they are held to
    // where the split actually left them rather than to where the rest of
    // src/commands still is.
    const GRIND_FILE_MAX_LINES = 750;

    test.each(GRINDS)('no file in /%s has grown back into a god file', name => {
        const oversized = grindCommandFiles(name)
            .map(file => ({ file: path.basename(file), lines: fs.readFileSync(file, 'utf8').split('\n').length - 1 }))
            .filter(f => f.lines > GRIND_FILE_MAX_LINES);

        expect(oversized).toEqual([]);
    });

    // The shop was the group that outgrew a file in all three, so it is the one
    // with a shape to pin. Everything beside index.js is one verb of the shop.
    test.each(GRINDS)('/%s shop is a folder of verbs behind one dispatch', name => {
        const shop = path.join(ECONOMY, name, 'shop');

        expect(fs.existsSync(path.join(ECONOMY, name, 'shop.js'))).toBe(false);
        expect(fs.existsSync(path.join(shop, 'index.js'))).toBe(true);
        expect(fs.readdirSync(shop).filter(f => f.endsWith('.js')).length).toBeGreaterThan(4);
    });

    // The hazard the deeper split introduced. Every guard that reads a grind
    // command's source goes through tests/helpers/grindSources, and a walk that
    // stopped at the top level would have dropped the whole shop — 800-odd
    // lines of transactions and charges — out of all of them, while staying
    // green.
    test.each(GRINDS)('the source helper reaches into /%s subfolders', name => {
        const files = grindCommandRelPaths(name);

        expect(files).toContain(`src/commands/economy/${name}/shop/index.js`);
        expect(files.filter(f => f.includes(`/${name}/shop/`)).length).toBeGreaterThan(4);
        // index.js first, because it is the command and the rest are its parts.
        expect(files[0]).toBe(`src/commands/economy/${name}/index.js`);
    });
});
