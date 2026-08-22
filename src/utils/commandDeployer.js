const { REST, Routes } = require('discord.js');
const { listCommandFiles, loadCommandModules } = require('./commandLoader');

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

/**
 * Publish the global command set.
 *
 * @param {string} clientId
 * @param {string} token
 * @param {Iterable<object>} [loadedCommands] commands already required at
 *   startup (`client.commands`). Startup has just required all 98 of them; a
 *   second walk-and-require here bought nothing but ~800 ms and a chance for
 *   the deployed set to disagree with the running one. Omit it — as the
 *   standalone `npm run deploy` does, where no client exists — and the deploy
 *   loads them itself.
 */
async function deployCommands(clientId, token, loadedCommands = null) {
    const commands = [];
    const failures = [];

    if (loadedCommands) {
        for (const command of loadedCommands) {
            const name = command?.data?.name ?? '(unnamed command)';
            if (typeof command?.data?.toJSON === 'function') {
                commands.push(command.data.toJSON());
            } else {
                failures.push(`${name} (data.toJSON is not a function)`);
            }
        }
    } else {
        const loaded = loadCommandModules();
        failures.push(...loaded.failures);
        for (const { entry, command } of loaded.commands) {
            if (typeof command.data?.toJSON === 'function') {
                commands.push(command.data.toJSON());
            } else {
                failures.push(`${entry.rel} (data.toJSON is not a function)`);
            }
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
