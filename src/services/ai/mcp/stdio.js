'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const {
    McpHttpClient,
    McpError,
    readWithDeadline,
    CONNECT_TIMEOUT_MS,
    MAX_RESPONSE_BYTES
} = require('./client');

/**
 * An MCP server the bot runs itself, spoken to over the process's stdin and
 * stdout — the transport most MCP servers ship with, and the only one a lot of
 * them have (an Obsidian vault, a git checkout, a local filesystem).
 *
 * Operator-only, from the config file (`command` in src/config/mcpServers.js):
 * a dashboard field that could name a command would be remote code execution
 * for every guild admin.
 *
 * Everything above the wire is the HTTP client's. The older HTTP+SSE transport
 * already has exactly this shape — one standing channel, answers arriving on it
 * out of band, a table of waiters keyed by id — so this reuses its dispatcher
 * (`dispatchSseMessage`), including the rule that a server request is only
 * answered on behalf of one turn at a time. What changes is the pipe: a line of
 * JSON on stdin out, a line of JSON on stdout back.
 *
 * The process is started on first use and stopped by `close()`, which is what
 * the connection pool calls when a server has been idle — so an unused server
 * costs nothing, and the next request starts it again.
 */

// What a server inherits from the bot's environment. Deliberately not all of
// it: the bot's environment holds the Discord token, the database URI and every
// provider key, and a third-party MCP server has no business with any of them.
// Anything else a server needs is named in its `env`.
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_ENV', 'SHELL', 'TERM'];

// How much of a server's stderr is kept, to say why it died.
const STDERR_TAIL_CHARS = 2000;

// How long a process gets to exit on its own before it is killed.
const KILL_GRACE_MS = 2000;

// After a crash on start, how long before it is tried again. A server that
// cannot start (a typo in the command, a missing package) would otherwise be
// respawned by every message that touches it.
const RESPAWN_BACKOFF_MS = 30_000;

// Every process this module started, so none outlives the bot.
const running = new Set();
let exitHookInstalled = false;

function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once('exit', () => {
        for (const child of running) {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
    });
}

function childEnv(configured) {
    const env = {};
    for (const key of INHERITED_ENV) {
        if (typeof process.env[key] === 'string') env[key] = process.env[key];
    }
    for (const [key, value] of Object.entries(configured || {})) {
        if (typeof value === 'string') env[key] = value;
    }
    return env;
}

class McpStdioClient extends McpHttpClient {
    /**
     * @param {object} options
     * @param {object} options.stdio `{ command, args, env, cwd }` from the config file
     * @param {string} [options.label]
     * @param {Function} [options.spawnImpl] for tests
     */
    constructor({ stdio, spawnImpl = spawn, ...rest }) {
        super({ ...rest, url: null, transport: 'stdio' });
        if (!stdio || typeof stdio.command !== 'string' || !stdio.command.trim()) {
            throw new Error(`${this.label} has no command to run`);
        }
        this.stdio = stdio;
        this.spawnImpl = spawnImpl;
        this.child = null;
        this.starting = null;
        this.stderrTail = '';
        this.failedAt = 0;
        this.lastFailure = null;
    }

    async post(payload, options = {}) {
        return this.postOverStdio(payload, options);
    }

    /** Start the process if it is not running. Coalesced like the SSE channel. */
    async openProcess() {
        if (this.child) return this.child;
        if (this.starting) return this.starting;

        if (this.failedAt && Date.now() - this.failedAt < RESPAWN_BACKOFF_MS) {
            throw new McpError(`${this.label} failed to start a moment ago (${this.lastFailure}); not retrying yet`);
        }

        this.starting = new Promise((resolve, reject) => {
            let child;
            try {
                child = this.spawnImpl(this.stdio.command, this.stdio.args || [], {
                    cwd: this.stdio.cwd || undefined,
                    env: childEnv(this.stdio.env),
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });
            } catch (err) {
                this.noteFailure(err.message);
                reject(new McpError(`could not start ${this.label}: ${err.message}`));
                return;
            }

            const started = Date.now();
            let settled = false;

            child.once('error', err => {
                // ENOENT for a command that does not exist arrives here, not as
                // a throw from spawn.
                this.noteFailure(err.message);
                if (!settled) {
                    settled = true;
                    reject(new McpError(`could not start ${this.label}: ${err.message}`));
                }
                this.processGone(child, err);
            });

            child.once('exit', (code, signal) => {
                const why = signal ? `killed by ${signal}` : `exited with code ${code}`;
                if (Date.now() - started < 5000 && code !== 0) this.noteFailure(why);
                // Gone before the start settled: the start failed, and must
                // not resolve with a dead child a request would then wait on.
                if (!settled) {
                    settled = true;
                    reject(new McpError(`could not start ${this.label}: ${why}`));
                }
                this.processGone(child, new Error(`${why}${this.stderrTail ? ` — ${this.stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
            });

            child.stderr?.setEncoding?.('utf8');
            child.stderr?.on('data', chunk => {
                this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
            });

            const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
            lines.on('line', line => this.receiveLine(line));
            child.stdin.on('error', () => { /* the exit handler reports it */ });

            running.add(child);
            installExitHook();
            this.child = child;

            // `spawn` reports a missing command asynchronously; give it one turn
            // of the event loop to say so before treating the process as up.
            setImmediate(() => {
                if (settled) return;
                settled = true;
                resolve(child);
            });
        }).finally(() => { this.starting = null; });

        return this.starting;
    }

    noteFailure(message) {
        this.failedAt = Date.now();
        this.lastFailure = message;
    }

    /** One line of stdout: a JSON-RPC message, or noise a server logged by mistake. */
    receiveLine(line) {
        if (!line.trim()) return;
        if (line.length > MAX_RESPONSE_BYTES) {
            console.warn(`[MCP] "${this.label}" sent a message over ${MAX_RESPONSE_BYTES} bytes; dropping it`);
            return;
        }
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            // Some servers print a banner to stdout. It is not ours to answer.
            return;
        }
        if (!message || typeof message !== 'object') return;
        this.dispatchSseMessage(message);
    }

    /** The process is gone: fail every waiter and forget the session. */
    processGone(child, error) {
        running.delete(child);
        if (this.child !== child) return;
        this.child = null;
        this.initialized = false;
        this.protocolVersion = null;
        const waiters = [...this.pending.values()];
        this.pending.clear();
        for (const waiter of waiters) {
            waiter.reject(new McpError(`${this.label} stopped: ${error.message}`, { sessionExpired: true }));
        }
    }

    async postOverStdio(payload, { id = null, timeout = CONNECT_TIMEOUT_MS, onNotification = null, onServerRequest = null } = {}) {
        const child = await this.openProcess();
        // The process can die between starting and this request; a waiter
        // registered against a child that is already gone is never answered.
        if (this.child !== child) {
            throw new McpError(`${this.label} stopped before the request was sent`, { sessionExpired: true });
        }

        const deadline = { at: Date.now() + timeout, reschedule: null };
        let waiting = null;
        if (id !== null) {
            waiting = new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject, onNotification, onServerRequest, deadline });
            });
        }

        try {
            await new Promise((resolve, reject) => {
                child.stdin.write(`${JSON.stringify(payload)}\n`, err => (err ? reject(err) : resolve()));
            });
        } catch (err) {
            if (id !== null) this.pending.delete(id);
            waiting?.catch(() => {});
            throw new McpError(`could not write to ${this.label}: ${err.message}`);
        }

        if (id === null) return null;
        try {
            return await readWithDeadline(waiting, null, deadline);
        } finally {
            this.pending.delete(id);
        }
    }

    async close() {
        const child = this.child;
        this.initialized = false;
        if (!child) return;
        this.child = null;
        running.delete(child);
        try { child.stdin.end(); } catch { /* already closed */ }
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, KILL_GRACE_MS);
        timer.unref?.();
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        const waiters = [...this.pending.values()];
        this.pending.clear();
        for (const waiter of waiters) waiter.reject(new McpError(`${this.label} was closed`, { sessionExpired: true }));
    }
}

module.exports = { McpStdioClient, childEnv, INHERITED_ENV, RESPAWN_BACKOFF_MS };
