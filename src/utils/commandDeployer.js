const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Discord registers at most this many global application commands. Going over
// is not a soft limit or a truncation — the whole `PUT` is rejected, so one
// command too many takes every other command down with it.
const GLOBAL_COMMAND_LIMIT = 100;

// How close to the limit we are willing to sit. Each file under src/commands
// is one top-level command, so this is also the count that tests/commandCap
// pins: new top-level commands have to displace an old one or become a
// subcommand of an existing group (the shape /hunt, /fish and /explore use).
// Lower it when a consolidation lands; raising it spends the last of the
// headroom between here and a deploy that cannot be undone by a revert.
const COMMAND_BUDGET = 97;

// The walk the deploy actually performs, shared with the test so the guard
// cannot drift from the thing it guards.
function listCommandFiles(foldersPath = path.join(__dirname, '../commands')) {
    const files = [];
    for (const entry of fs.readdirSync(foldersPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const commandsPath = path.join(foldersPath, entry.name);
        for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
            files.push({ dir: entry.name, file, rel: `${entry.name}/${file}`, full: path.join(commandsPath, file) });
        }
    }
    return files;
}

async function deployCommands(clientId, token) {
    const commands = [];
    const failures = [];

    for (const { rel, full } of listCommandFiles()) {
        try {
            const command = require(full);
            if ('data' in command && 'execute' in command && typeof command.data?.toJSON === 'function') {
                commands.push(command.data.toJSON());
            } else {
                failures.push(`${rel} (missing data/execute or data.toJSON)`);
            }
        } catch (error) {
            failures.push(`${rel} (${error.message})`);
        }
    }

    if (commands.length > GLOBAL_COMMAND_LIMIT) {
        throw new Error(
            `${commands.length} commands built, but Discord registers at most ${GLOBAL_COMMAND_LIMIT} global commands. ` +
            'Discord rejects the entire payload rather than taking the first 100, so this would unregister every ' +
            'command rather than dropping the excess. Fold commands into subcommand groups before deploying.'
        );
    }

    if (failures.length) {
        console.error(`[DEPLOY] ${failures.length} command file(s) failed to load:`);
        for (const f of failures) console.error(`  - ${f}`);
        throw new Error(`${failures.length} command file(s) failed to load; aborting so the registered set is not silently truncated.`);
    }

    const rest = new REST().setToken(token);
    try {
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
    } catch (error) {
        if (error.rawError) {
            console.error('[DEPLOY] Discord rejected the command payload:', JSON.stringify(error.rawError, null, 2));
        }
        throw error;
    }
    return commands.length;
}

module.exports = { deployCommands, listCommandFiles, GLOBAL_COMMAND_LIMIT, COMMAND_BUDGET };
