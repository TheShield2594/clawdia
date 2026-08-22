'use strict';

const fs = require('fs');
const path = require('path');

const { listCommandFiles } = require('../src/utils/commandLoader');
const { grindCommandFiles } = require('./helpers/grindSources');

// #721: fish.js (3,178 lines), hunt.js (3,476) and mine.js (2,806) were the
// three largest files in the repo, each holding forty-odd top-level functions —
// dispatch, embeds, shop, craft, quests, repairs, locations — beside a service
// layer that already existed for exactly that logic. Each is now a folder.
//
// Two things have to keep holding for that to be worth anything: the folders
// register as one command each rather than one per file, and no single file
// grows back into what was just split.

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

    // The number is not sacred — it is roughly a third of what the smallest of
    // the three was before, which is the point. What matters is that it fails
    // before any one file is back to being the thing this issue was about.
    test.each(GRINDS)('no file in /%s has grown back into a god file', name => {
        const oversized = grindCommandFiles(name)
            .map(file => ({ file: path.basename(file), lines: fs.readFileSync(file, 'utf8').split('\n').length }))
            .filter(f => f.lines > 900);

        expect(oversized).toEqual([]);
    });
});
