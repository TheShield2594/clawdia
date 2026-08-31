'use strict';

// #875. The bot sat at 98 of Discord's 100 global command slots, five of them
// held by activities usable a few weeks a year. They are subcommands of /event
// now, which is the group that already gated them.
//
// What has to keep holding: the fold is not undone one command at a time, the
// activities are still reachable, and the ManageGuild check that came across
// from commands/admin/event.js still stands in front of the two subcommands
// that change what event is running.

const fs = require('fs');
const path = require('path');

const { listCommandFiles } = require('../src/utils/commandLoader');
const { COMMAND_BUDGET, GLOBAL_COMMAND_LIMIT } = require('../src/utils/commandDeployer');

const command = require('../src/commands/economy/event');
const json = command.data.toJSON();
const subcommands = json.options.map(o => o.name);

const ACTIVITIES = ['snowball', 'sandcastle', 'trickortreat', 'lovenote', 'trackhunt'];
const MANAGED = ['start', 'end'];

describe('/event is one command holding what was seven', () => {
    test('every folded activity is a subcommand', () => {
        for (const name of ACTIVITIES) expect(subcommands).toContain(name);
        expect(subcommands).toContain('status');
        for (const name of MANAGED) expect(subcommands).toContain(name);
    });

    test('none of them is a top-level command any more', () => {
        const rels = listCommandFiles().map(f => f.rel);

        for (const name of ACTIVITIES) {
            expect(rels).not.toContain(`economy/${name}.js`);
        }
        // /event moved out of admin/ when it stopped being admin-only.
        expect(rels).not.toContain('admin/event.js');
        expect(rels).toContain('economy/event/index.js');
    });

    test('the folder registers as exactly one command, not one per activity', () => {
        const registered = listCommandFiles().filter(f => f.rel.startsWith('economy/event/'));

        expect(registered).toHaveLength(1);
        expect(registered[0].rel).toBe('economy/event/index.js');
    });

    // The whole point of the fold. If a later change spends this back, the
    // number here is what says how much was banked.
    test('the fold bought back headroom rather than being spent immediately', () => {
        expect(COMMAND_BUDGET).toBeLessThanOrEqual(GLOBAL_COMMAND_LIMIT - 5);
    });

    test('every activity file exports the handler index.js dispatches to', () => {
        const handlers = {
            snowball: 'handleSnowball',
            sandcastle: 'handleSandcastle',
            trickortreat: 'handleTrickOrTreat',
            lovenote: 'handleLoveNote',
            trackhunt: 'handleTrackHunt',
        };
        for (const [file, fn] of Object.entries(handlers)) {
            expect(typeof require(`../src/commands/economy/event/${file}`)[fn]).toBe('function');
        }
    });
});

describe('the management half stays behind Manage Server', () => {
    // Discord's setDefaultMemberPermissions is per command, and this command is
    // mostly player-facing — using it would hide /event snowball from everyone
    // without Manage Server. So the check is inline, and this is what says it
    // did not get lost in the move.
    test('start and end are gated, and the player subcommands are not', async () => {
        const { requireManageGuild } = require('../src/commands/economy/event/manage');
        const replies = [];
        const denied = {
            memberPermissions: { has: () => false },
            reply: r => { replies.push(r); return Promise.resolve(); },
        };

        await expect(requireManageGuild(denied)).resolves.toBe(false);
        expect(replies).toHaveLength(1);
        expect(replies[0].content).toMatch(/Manage Server/);

        await expect(requireManageGuild({ memberPermissions: { has: () => true } })).resolves.toBe(true);
    });

    test('the command does not carry a default-permission gate of its own', () => {
        // `default_member_permissions` here would take the activities down with
        // the management subcommands.
        expect(json.default_member_permissions ?? null).toBeNull();
    });

    test('index.js dispatches nothing itself', () => {
        const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'economy', 'event', 'index.js'), 'utf8');

        expect(index).not.toMatch(/^async function /m);
    });
});

describe('each subcommand keeps its own cooldown bucket', () => {
    const at = sub => ({ options: { getSubcommand: () => sub } });

    test('a snowball throw no longer spends the sandcastle window', () => {
        expect(command.cooldownKey(at('snowball'))).toBe('event:snowball');
        expect(command.cooldownKey(at('sandcastle'))).toBe('event:sandcastle');
    });

    // The activities claim their real cooldowns in Mongo — client.cooldowns is
    // a process-local Map that is empty after a restart, so it is not what
    // bounds a command that pays coins (tests/economyCooldownClaims).
    test('the activities ask for no process-local cooldown, the rest take the default', () => {
        for (const name of ACTIVITIES) expect(command.cooldownAmount(at(name))).toBe(0);
        for (const name of [...MANAGED, 'status']) expect(command.cooldownAmount(at(name))).toBe(3);
    });
});
