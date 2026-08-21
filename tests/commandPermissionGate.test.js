'use strict';

// `setDefaultMemberPermissions` is a default, not a rule. Under Server Settings →
// Integrations a guild admin can hand any command to @everyone, and Discord will
// then deliver it as an ordinary interaction with nothing to say the gate moved.
// Fifteen moderation commands trusted that default and re-checked nothing, so the
// only thing between a reassigned /ban and an ordinary member was a setting an
// attacker's own admin could change.
//
// Two things need proving. That the gate refuses; and that every command which
// declares a default also opts into it — the gate is central precisely so no
// individual handler can forget, but a command can still forget to declare.

const fs   = require('fs');
const path = require('path');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { missingRequiredPermissions } = require('../src/events/interactionCreate');

const held = (...bits) => new PermissionsBitField(bits);

describe('missingRequiredPermissions', () => {
    test('names the permission a caller is missing', () => {
        const missing = missingRequiredPermissions(
            { memberPermissions: held(PermissionFlagsBits.SendMessages) },
            { requiredPermissions: [PermissionFlagsBits.BanMembers] },
        );
        expect(missing).toEqual(['BanMembers']);
    });

    test('passes a caller who holds it', () => {
        const missing = missingRequiredPermissions(
            { memberPermissions: held(PermissionFlagsBits.BanMembers) },
            { requiredPermissions: [PermissionFlagsBits.BanMembers] },
        );
        expect(missing).toBeNull();
    });

    // massban wants both bits. Holding one is not holding the pair.
    test('rejects a caller holding only part of what a command requires', () => {
        const missing = missingRequiredPermissions(
            { memberPermissions: held(PermissionFlagsBits.BanMembers) },
            { requiredPermissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild] },
        );
        expect(missing).toEqual(['ManageGuild']);
    });

    test('reports every missing bit, not just the first', () => {
        const missing = missingRequiredPermissions(
            { memberPermissions: held(PermissionFlagsBits.SendMessages) },
            { requiredPermissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild] },
        );
        expect(missing.sort()).toEqual(['BanMembers', 'ManageGuild']);
    });

    // Discord folds Administrator (and ownership) into the permissions it sends,
    // and PermissionsBitField#missing honours it — so an admin is not locked out
    // of a command whose specific bit they were never granted.
    test('an Administrator satisfies any requirement', () => {
        const missing = missingRequiredPermissions(
            { memberPermissions: held(PermissionFlagsBits.Administrator) },
            { requiredPermissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild] },
        );
        expect(missing).toBeNull();
    });

    test('leaves commands that declare nothing alone', () => {
        const open = { memberPermissions: held() };
        expect(missingRequiredPermissions(open, {})).toBeNull();
        expect(missingRequiredPermissions(open, { requiredPermissions: [] })).toBeNull();
        expect(missingRequiredPermissions(open, { requiredPermissions: null })).toBeNull();
    });

    // A DM or a malformed payload leaves memberPermissions null. "Cannot tell"
    // is not "allowed".
    test('fails closed when the interaction carries no permissions', () => {
        for (const memberPermissions of [null, undefined]) {
            expect(missingRequiredPermissions(
                { memberPermissions },
                { requiredPermissions: [PermissionFlagsBits.BanMembers] },
            )).toEqual(['Unknown']);
        }
    });
});

// Walk the real command tree. A command that declares a Discord-side default is
// declaring "this needs the bit"; if it does not also declare it to the gate, the
// bit is enforced only by a setting a guild admin can move.
describe('every command with a Discord-side default re-declares it to the gate', () => {
    const commandsDir = path.join(__dirname, '..', 'src', 'commands');

    const commands = fs.readdirSync(commandsDir)
        .filter(d => fs.statSync(path.join(commandsDir, d)).isDirectory())
        .flatMap(dir => fs.readdirSync(path.join(commandsDir, dir))
            .filter(f => f.endsWith('.js'))
            .map(file => {
                const mod = require(path.join(commandsDir, dir, file));
                return { file: `${dir}/${file}`, mod };
            }))
        .filter(c => typeof c.mod?.data?.toJSON === 'function')
        .map(c => ({ ...c, json: c.mod.data.toJSON() }));

    const gated = commands.filter(c => c.json.default_member_permissions != null);

    test('the sweep found the command tree', () => {
        expect(commands.length).toBeGreaterThan(50);
        expect(gated.length).toBeGreaterThan(15);
    });

    test.each(gated.map(c => [c.file, c]))('%s', (_file, command) => {
        expect(command.mod.requiredPermissions).toBeDefined();
        // Same bits on both sides: a mismatch means the gate enforces something
        // other than what the command told Discord it needs.
        expect(new PermissionsBitField(command.mod.requiredPermissions).bitfield)
            .toBe(BigInt(command.json.default_member_permissions));
    });

    test('the commands the issue named are all in the gated set', () => {
        const named = [
            'ban', 'kick', 'mute', 'softban', 'clear', 'lockdown', 'massban', 'unban',
            'warn', 'note', 'case', 'cases', 'closecase', 'slowmode', 'raidmode',
        ];
        const gatedNames = new Set(gated.map(c => c.json.name));
        for (const name of named) expect(gatedNames).toContain(name);
    });

    test('a command that sets no default declares no requirement either', () => {
        // /shop passes null deliberately — it is a player command. The gate must
        // not acquire a requirement the command never asked for.
        for (const command of commands.filter(c => c.json.default_member_permissions == null)) {
            expect(`${command.file}: ${command.mod.requiredPermissions ?? 'none'}`)
                .toBe(`${command.file}: none`);
        }
    });
});

describe('the gate is wired into the dispatch', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'events', 'interactionCreate.js'), 'utf8',
    );

    test('runs before the command executes', () => {
        const gate = source.indexOf('missingRequiredPermissions(interaction, command)');
        const run  = source.indexOf('await command.execute(interaction, client)');
        expect(gate).toBeGreaterThan(-1);
        expect(run).toBeGreaterThan(gate);
    });

    test('refuses rather than falling through', () => {
        expect(source).toMatch(/if \(missingPerms\) \{[\s\S]*?return interaction\.reply\(/);
    });

    test('records the refusal, so a reassigned command is visible in metrics', () => {
        expect(source).toContain("'missing_permissions'");
    });
});
