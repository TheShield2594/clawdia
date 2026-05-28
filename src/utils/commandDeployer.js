const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

async function deployCommands(clientId, token) {
    const commands = [];
    const failures = [];
    const foldersPath = path.join(__dirname, '../commands');

    for (const entry of fs.readdirSync(foldersPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const commandsPath = path.join(foldersPath, entry.name);

        for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
            const rel = `${entry.name}/${file}`;
            try {
                const command = require(path.join(commandsPath, file));
                if ('data' in command && 'execute' in command && typeof command.data?.toJSON === 'function') {
                    commands.push(command.data.toJSON());
                } else {
                    failures.push(`${rel} (missing data/execute or data.toJSON)`);
                }
            } catch (error) {
                failures.push(`${rel} (${error.message})`);
            }
        }
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

module.exports = { deployCommands };
