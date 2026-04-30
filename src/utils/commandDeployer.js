const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

async function deployCommands(clientId, token) {
    const commands = [];
    const foldersPath = path.join(__dirname, '../commands');

    for (const entry of fs.readdirSync(foldersPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const commandsPath = path.join(foldersPath, entry.name);

        for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
            try {
                const command = require(path.join(commandsPath, file));
                if ('data' in command && 'execute' in command && typeof command.data?.toJSON === 'function') {
                    commands.push(command.data.toJSON());
                }
            } catch (error) {
                console.error(`[DEPLOY] Failed to load command ${file}:`, error);
            }
        }
    }

    const rest = new REST().setToken(token);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    return commands.length;
}

module.exports = { deployCommands };
