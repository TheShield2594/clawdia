const crypto = require('crypto');
const { randomUUID } = crypto;
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
// headroom between here and a deploy that cannot be undone by a revert. It
// last moved for #875, which folded five single-holiday commands into the
// /event group they were already gated by.
const COMMAND_BUDGET = 92;

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
/**
 * @param {string} clientId
 * @param {string} token the bot token.
 * @param {object[]} commands the bodies to publish.
 * @returns {Promise<number>} how many were published.
 */
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
 * @param {string} token the bot token.
 * @param {Iterable<object>} [loadedCommands] see buildCommandPayload.
 * @returns {Promise<number>} how many commands were published.
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
/**
 * @param {string} clientId the Discord application the set would be published under.
 * @param {object[]} commands the serialized command bodies.
 * @returns {string} a sha256 hex digest, stable across iteration order.
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
/**
 * @returns {'auto'|'always'|'never'} how DEPLOY_COMMANDS says to behave.
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
 * Take exclusive ownership of the right to publish `hash`.
 *
 * A plain `findOneAndUpdate` on `{ hash: { $ne } }` is not exclusive: when the
 * document already exists holding an older hash, every shard's filter matches
 * it and every shard proceeds to PUT. Mongo serializes the writes but matches
 * all of them, so the duplicate-key error only ever guarded the case where no
 * document existed yet.
 *
 * So the claim is a compare-and-swap on a token that changes on every attempt:
 * each caller reads the token it saw, and only the writer whose filter still
 * names that token wins. The loser's filter no longer matches and it is told
 * the set is being published by someone else.
 *
 * There is deliberately no lease expiry. A claim abandoned by a crashed process
 * is recovered by `pending` — the next boot sees an unfinished claim and takes
 * it over — which needs no wall clock and no guess at how long a PUT may
 * legitimately take.
 *
 * @param {import('mongoose').Model} CommandDeployment
 * @param {string} hash fingerprint of the set to publish.
 * @param {string} clientId
 * @returns {Promise<{claimed: boolean, token: string|null, reason: string}>}
 */
async function claimDeployment(CommandDeployment, hash, clientId) {
    const current = await CommandDeployment.findOne({ _id: DEPLOYMENT_KEY }).lean();

    // Already published, and the publish finished. The common restart.
    if (current && current.hash === hash && current.pending !== true) {
        return { claimed: false, token: null, reason: 'command set unchanged' };
    }

    const token = randomUUID();
    // `null` matches a missing field as well as an explicit null, which is what
    // makes this work against a document written before claimToken existed.
    const expected = current
        ? { _id: DEPLOYMENT_KEY, claimToken: current.claimToken ?? null }
        : { _id: DEPLOYMENT_KEY, claimToken: null };

    try {
        const claimed = await CommandDeployment.findOneAndUpdate(
            expected,
            { $set: { hash, pending: true, clientId, claimToken: token } },
            // Only the no-document case may insert. With a document present an
            // upsert would race a concurrent insert into a duplicate key rather
            // than losing cleanly.
            { upsert: !current, new: true }
        );
        return claimed
            ? { claimed: true, token, reason: 'command set changed' }
            : { claimed: false, token: null, reason: 'another process is publishing this set' };
    } catch (error) {
        // Another process inserted the document between our read and our write.
        // It holds the claim; we do not.
        if (error?.code === 11000) {
            return { claimed: false, token: null, reason: 'another process is publishing this set' };
        }
        throw error;
    }
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

    const claim = await claimDeployment(CommandDeployment, hash, clientId);
    if (!claim.claimed) {
        return { deployed: false, count: commands.length, reason: claim.reason };
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
                // Only this claim may release it. Without the token a shard
                // whose PUT failed would clear a claim a *later* boot had since
                // taken, and both would then publish.
                { _id: DEPLOYMENT_KEY, claimToken: claim.token },
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
        await recordDeployment(clientId, hash, count, claim.token);
    } catch (error) {
        console.error('[DEPLOY] Published, but could not record the deployment:', error.message);
    }
    return { deployed: true, count, reason: 'command set changed' };
}

/**
 * Mark the claim satisfied: this hash is what Discord now has.
 *
 * `token` scopes the write to the claim that actually made the call, so a slow
 * shard cannot mark someone else's in-flight claim finished. The `always` path
 * has no claim to scope to and passes none.
 *
 * @param {string} clientId
 * @param {string} hash fingerprint of the published set.
 * @param {number} count how many commands were published.
 * @param {string|null} [token] the claim token this deploy holds, if any.
 */
async function recordDeployment(clientId, hash, count, token = null) {
    const CommandDeployment = require('../models/CommandDeployment');
    await CommandDeployment.updateOne(
        token ? { _id: DEPLOYMENT_KEY, claimToken: token } : { _id: DEPLOYMENT_KEY },
        { $set: { hash, pending: false, clientId, commandCount: count, deployedAt: new Date() } },
        { upsert: !token }
    );
}

/**
 * The `npm run deploy` front door: the guard, the logging and the exit code
 * (#951).
 *
 * It was the body of src/deploy-commands.js, which is on the `neverExecuted`
 * list in coverage-floors.json — so the branch that decides whether an operator
 * gets a deploy or an error message was never run by anything. It is here
 * rather than there because that is the difference between logic with a test
 * and logic without one.
 *
 * Returns the exit code instead of calling `process.exit`, for two reasons: a
 * function that kills the process cannot be tested, and the caller can then do
 * what the entrypoint has always done — exit explicitly on failure, and fall
 * off the end on success rather than truncating a pipe that has not drained.
 *
 * The two variables are checked here as well as in config/validateEnv.js
 * because this path deliberately does not run the validator: `npm run deploy`
 * needs a token and an application id and nothing else, and holding it to the
 * bot's whole configuration would make an operator set DASHBOARD_URL to
 * register slash commands.
 *
 * @param {object} [deps]
 * @param {object} [deps.env] the environment to read; injectable for the tests.
 * @param {function(string, string): Promise<number>} [deps.deploy]
 * @param {function(...*): void} [deps.log]
 * @param {function(...*): void} [deps.logError]
 * @returns {Promise<number>} 0 when the set was published, 1 otherwise.
 */
async function runDeployCli({
    env = process.env,
    deploy = deployCommands,
    log = console.log,
    logError = console.error,
} = {}) {
    if (!env.CLIENT_ID || !env.DISCORD_TOKEN) {
        logError('Missing CLIENT_ID or DISCORD_TOKEN environment variable.');
        return 1;
    }

    try {
        log('Started refreshing application (/) commands.');
        const count = await deploy(env.CLIENT_ID, env.DISCORD_TOKEN);
        log(`Successfully reloaded ${count} application (/) commands.`);
        return 0;
    } catch (error) {
        // The whole error, not `error.message`: a Discord rejection carries the
        // per-command detail in `rawError`, and that detail is the only thing
        // that says *which* command body it refused.
        logError('Failed to deploy commands:', error);
        return 1;
    }
}

module.exports = {
    deployCommands,
    runDeployCli,
    buildCommandPayload,
    deployCommandsIfChanged,
    commandSetHash,
    claimDeployment,
    listCommandFiles,
    GLOBAL_COMMAND_LIMIT,
    COMMAND_BUDGET,
    DEPLOYMENT_KEY,
};
