'use strict';

const {
    listCommandFiles,
    GLOBAL_COMMAND_LIMIT,
    COMMAND_BUDGET,
} = require('../src/utils/commandDeployer');

// Discord caps global application commands at 100 and rejects the whole `PUT`
// when a payload exceeds it — it does not register the first 100 and drop the
// rest. So the failure mode is not "the new command is missing", it is "every
// command is missing", discovered in production at deploy time with no local
// signal beforehand. This suite is that signal: `npm test` is what CI gates on.
describe('global slash-command cap', () => {
    // One file under src/commands is one top-level command, which is what makes
    // a file count a stand-in for the registered count. Reading it through the
    // deployer's own walk rather than a second copy of the glob is deliberate:
    // a guard that scans a different set than the deploy does is not a guard.
    const files = listCommandFiles();

    test('the registered set stays under Discord’s hard limit', () => {
        expect(files.length).toBeLessThanOrEqual(GLOBAL_COMMAND_LIMIT);
    });

    // The ratchet. It sits at the current count rather than at some round
    // number below it, so adding a top-level command turns this red instead of
    // quietly spending headroom that nothing is tracking. Two ways out when it
    // fails, and picking one is the point of the failure:
    //   - make the new command a subcommand of an existing group, the shape
    //     /hunt, /fish and /explore already use, and the count does not move;
    //   - retire or fold a command, then lower COMMAND_BUDGET to match.
    // Raising the budget to get green is the third way, and it is the one that
    // walks the repo back to a deploy that cannot be reverted.
    test('no new top-level commands without spending the budget deliberately', () => {
        expect(COMMAND_BUDGET).toBeLessThanOrEqual(GLOBAL_COMMAND_LIMIT);
        expect(files.length).toBeLessThanOrEqual(COMMAND_BUDGET);
    });

    // A budget that has drifted above the real count is not a ratchet any more
    // — it is slack that lets the next few commands land unnoticed. Consolidate
    // and this fails until COMMAND_BUDGET is lowered to bank the win.
    test('the budget tracks the real count rather than drifting above it', () => {
        expect(COMMAND_BUDGET).toBe(files.length);
    });

    // A command is either `<category>/<name>.js` or `<category>/<name>/index.js`
    // — the folder form is how a command too big for one file (fish, hunt,
    // mine) splits up without its helper files each registering as a command
    // of their own. Either way it lives under a category, never loose at the
    // root, and `rel` is `dir` plus `file` with nothing invented in between.
    test('every command sits in a category directory', () => {
        for (const { dir, file, rel } of files) {
            expect(dir).not.toBe('');
            expect(rel).toBe(`${dir}/${file}`);
            expect(file === 'index.js').toBe(false);
            expect(file.endsWith('.js')).toBe(true);
        }
    });

    // Two files cannot both claim one command name, and the deploy would fail
    // the whole payload if they tried.
    test('no two commands share a name', () => {
        const names = files.map(f => f.file.replace(/\/index\.js$/, '').replace(/\.js$/, ''));
        expect(new Set(names).size).toBe(names.length);
    });
});
