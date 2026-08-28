const crypto = require('crypto');
const { REST, Routes } = require('discord.js');
const { listCommandFiles, loadCommandModules } = require('./commandLoader');

// Discord registers at most this many global application commands. Going over
// is not a soft limit or a truncation — the whole `PUT` is rejected, so one
// command too many takes every other command down with it.
const GLOBAL_COMMAND_LIMIT = 100;

// How close to the limit we are willing to sit. Each command under src/commands
// — one file, or one folder with an index.js — is one top-level command, so
// this is also the count that tests/commandCap pins: new top-level commands
// have to displace an old one or become a subcommand of an existing group (the
// shape /hunt, /fish and /explore use).
// Lower it when a consolidation lands; raising it spends the last of the
// headroom between here and a deploy that cannot be undone by a revert.
const COMMAND_BUDGET = 97;

/**
 * Serialize the command set that is about to be published, and refuse to
 * produce a partial one.
 *
 * @param {Iterable<object>} [loadedCommands] commands already required at
 *   startup (`client.commands`). Startup has just required all 98 of them; a
 *   second walk-and-require here bought nothing but ~800 ms and a chance for
 *   the deployed set to disagree with the running one. Omit it — as the
 *   standalone `npm run deploy` does, where no client exists — and the payload
 *   is loaded from disk here.
 * @returns {object[]} the JSON bodies, in the order they were handed over.
 */
function buildCommandPayload(loadedCommands = null) {
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

    return commands;
}

/** The one call that actually changes what Discord has registered. */
async function putCommands(clientId, token, commands) {
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

/**
 * Publish the global command set, unconditionally.
 *
 * This is the `npm run deploy` path: an operator asking for a deploy gets one,
 * with no database involved and nothing to reason about. The boot path wants
 * the opposite — see deployCommandsIfChanged below.
 *
 * @param {string} clientId
 * @param {string} token
 * @param {Iterable<object>} [loadedCommands] see buildCommandPayload.
 */
async function deployCommands(clientId, token, loadedCommands = null) {
    return putCommands(clientId, token, buildCommandPayload(loadedCommands));
}

// The single document in the CommandDeployment collection. There is one global
// command set per application, so the key is fixed.
const DEPLOYMENT_KEY = 'global';

/**
 * Fingerprint of a command payload, as published.
 *
 * Sorted by name so that the order `client.commands` happens to iterate in
 * cannot change the hash — only the commands themselves can. The application id
 * is folded in because the same payload published under a different CLIENT_ID
 * is a different registration.
 */
function commandSetHash(clientId, commands) {
    const sorted = [...commands].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return crypto.createHash('sha256')
        .update(JSON.stringify({ clientId, commands: sorted }))
        .digest('hex');
}

/**
 * How DEPLOY_COMMANDS is read. Anything unrecognised falls back to 'auto' with
 * a warning rather than silently disabling the deploy — an operator who
 * mistypes it should get commands, not a bot with none.
 */
function deployMode() {
    const raw = String(process.env.DEPLOY_COMMANDS ?? '').trim().toLowerCase();
    if (raw === '') return 'auto';
    if (raw === 'auto' || raw === 'always' || raw === 'never') return raw;
    console.warn(
        `[DEPLOY] Ignoring DEPLOY_COMMANDS="${process.env.DEPLOY_COMMANDS}": expected auto, always or never. Using auto.`
    );
    return 'auto';
}

/**
 * Publish the global command set, but only when it differs from the set that
 * was last published (#643).
 *
 * The deploy at `clientReady` is what makes the Docker quick-start work — the
 * image's CMD is `node src/index.js` and nothing in either stack file runs
 * `npm run deploy`, so a deploy step outside the process is a step that never
 * happens. Running it on every boot, though, means a full PUT of every command
 * to Discord each restart, and under sharding one PUT per shard publishing the
 * identical set. The hash below is what turns "on every boot" into "when it
 * actually changed": the common restart does one indexed read and no API call.
 *
 * The claim is a single conditional update, so it also settles which shard
 * deploys: whichever one wins the write does the PUT and the rest see their own
 * hash already recorded and skip.
 *
 * @returns {Promise<{deployed: boolean, count: number, reason: string}>}
 *   `reason` is why it did or did not deploy, suitable for a log line.
 */
async function deployCommandsIfChanged(clientId, token, loadedCommands = null) {
    const mode = deployMode();
    if (mode === 'never') {
        return { deployed: false, count: 0, reason: 'DEPLOY_COMMANDS=never' };
    }

    const commands = buildCommandPayload(loadedCommands);

    if (mode === 'always') {
        const count = await putCommands(clientId, token, commands);
        // Recorded even here, so switching back to `auto` does not re-deploy an
        // unchanged set once. Non-fatal for the same reason as below.
        try {
            await recordDeployment(clientId, commandSetHash(clientId, commands), count);
        } catch (error) {
            console.error('[DEPLOY] Published, but could not record the deployment:', error.message);
        }
        return { deployed: true, count, reason: 'DEPLOY_COMMANDS=always' };
    }

    const hash = commandSetHash(clientId, commands);
    // Required lazily: `npm run deploy` (src/deploy-commands.js) runs this
    // module with no database connection and must not pull mongoose in.
    const CommandDeployment = require('../models/CommandDeployment');

    let claimed;
    try {
        // Deploy when the recorded hash differs *or* when a previous attempt
        // claimed this hash and never finished. Without the second clause a
        // process killed mid-PUT would leave its hash recorded and every later
        // boot would skip the deploy it never actually made.
        await CommandDeployment.findOneAndUpdate(
            { _id: DEPLOYMENT_KEY, $or: [{ hash: { $ne: hash } }, { pending: true }] },
            { $set: { hash, pending: true, clientId } },
            { upsert: true, new: true }
        );
        claimed = true;
    } catch (error) {
        // The document exists and did not match the filter, so the upsert tried
        // to insert a second one against the fixed _id. That is precisely the
        // "already deployed, nothing to do" case.
        if (error?.code === 11000) claimed = false;
        else throw error;
    }

    if (!claimed) {
        return { deployed: false, count: commands.length, reason: 'command set unchanged' };
    }

    let count;
    try {
        count = await putCommands(clientId, token, commands);
    } catch (error) {
        // Release the claim so the next boot retries instead of inheriting a
        // hash that was never accepted. Best-effort: `pending` already marks the
        // document as unfinished, so a failure here is not worth masking the
        // deploy error with.
        try {
            await CommandDeployment.updateOne(
                { _id: DEPLOYMENT_KEY },
                { $set: { hash: null, pending: true } }
            );
        } catch (releaseError) {
            console.error('[DEPLOY] Could not release the deployment claim:', releaseError.message);
        }
        throw error;
    }

    // Discord has the new set. A failure to write the bookkeeping after that
    // must not be reported as a failed deploy: the document still says
    // `pending`, so the next boot re-publishes — which is wasteful, not wrong.
    try {
        await recordDeployment(clientId, hash, count);
    } catch (error) {
        console.error('[DEPLOY] Published, but could not record the deployment:', error.message);
    }
    return { deployed: true, count, reason: 'command set changed' };
}

async function recordDeployment(clientId, hash, count) {
    const CommandDeployment = require('../models/CommandDeployment');
    await CommandDeployment.updateOne(
        { _id: DEPLOYMENT_KEY },
        { $set: { hash, pending: false, clientId, commandCount: count, deployedAt: new Date() } },
        { upsert: true }
    );
}

module.exports = {
    deployCommands,
    buildCommandPayload,
    deployCommandsIfChanged,
    commandSetHash,
    listCommandFiles,
    GLOBAL_COMMAND_LIMIT,
    COMMAND_BUDGET,
    DEPLOYMENT_KEY,
};
