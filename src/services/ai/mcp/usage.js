'use strict';

const McpUsage = require('../../../models/McpUsage');

// The per-guild MCP ledger: which tools a guild's models actually reach for,
// how often they work, and how long they take.
//
// Recorded from the turn's activity rather than from inside the toolkit. The
// toolkit does not know which guild it is working for — it is handed a list of
// servers, not a Discord context — and the transport that does know already has
// every call the turn made, so this needs no extra plumbing through four
// provider modules to reach the one caller that can fill it in.

// The reserved tool name for "the server itself could not be reached". A
// connection that is down makes no calls, so without a row for the connection
// it would look identical to a connection nobody used.
const CONNECTION_ROW = '(connection)';

// A tool name is the far side's to choose. It is stored, so it gets a ceiling.
const MAX_NAME_LENGTH = 128;
const MAX_ERROR_LENGTH = 300;

function utcDayString(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function trim(value, limit) {
    const text = String(value ?? '').trim();
    return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Roll a turn's calls up into one row per (server, tool).
 *
 * A turn calls the same tool more than once often enough — a search, then a
 * read of each result — that summing here saves a write per call.
 */
function summarise(calls = [], unreachableServers = []) {
    const rows = new Map();

    const rowFor = (server, tool) => {
        const key = `${server} ${tool}`;
        let row = rows.get(key);
        if (!row) {
            row = { server, tool, calls: 0, failures: 0, declined: 0, totalMs: 0, lastError: null };
            rows.set(key, row);
        }
        return row;
    };

    for (const call of calls) {
        const server = trim(call?.server, MAX_NAME_LENGTH);
        const tool = trim(call?.tool, MAX_NAME_LENGTH);
        if (!server || !tool) continue;

        const row = rowFor(server, tool);
        row.calls++;
        if (call.declined) {
            row.declined++;
        } else if (!call.ok) {
            row.failures++;
            // The most recent failure wins, which is the one an admin opening
            // the panel is trying to explain.
            if (call.error) row.lastError = call.error;
        }
        if (Number.isFinite(call.durationMs) && call.durationMs > 0) {
            row.totalMs += Math.round(call.durationMs);
        }
    }

    for (const name of unreachableServers) {
        const server = trim(name, MAX_NAME_LENGTH);
        if (!server) continue;
        const row = rowFor(server, CONNECTION_ROW);
        row.calls++;
        row.failures++;
    }

    return [...rows.values()];
}

async function applyRow(guildId, day, row) {
    const filter = { guildId, day, server: row.server, tool: row.tool };
    const update = {
        $inc: {
            calls: row.calls,
            failures: row.failures,
            declined: row.declined,
            totalMs: row.totalMs
        },
        $set: { updatedAt: new Date() }
    };
    if (row.lastError) {
        update.$set.lastError = trim(row.lastError, MAX_ERROR_LENGTH);
        update.$set.lastErrorAt = new Date();
    }

    try {
        await McpUsage.updateOne(filter, update, { upsert: true });
    } catch (err) {
        // Two turns finishing together race the upsert: one creates the row,
        // the other gets E11000. The row exists by then, so the retry without
        // upsert lands the counts rather than dropping them — same as AIUsage.
        if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
            await McpUsage.updateOne(filter, update, { upsert: false });
        } else {
            throw err;
        }
    }
}

/**
 * Record what one turn's MCP tools did.
 *
 * Best-effort in every direction: the reply has already been sent by the time
 * this runs, so a ledger write must never turn into an error the user sees.
 */
async function recordToolCalls(guildId, calls, unreachableServers = []) {
    if (!guildId) return;
    const rows = summarise(calls, unreachableServers);
    if (!rows.length) return;

    const day = utcDayString();
    for (const row of rows) {
        try {
            await applyRow(guildId, day, row);
        } catch (err) {
            console.error('[MCP usage] record error:', err.message);
        }
    }
}

/**
 * The guild's tool activity over the last `days` days, per server and tool.
 *
 * Shaped for the Connections panel: a per-server total to put beside each
 * connection, and the tools under it ordered by how much they are used, which
 * is the list an admin fills the allow and block lists in from.
 */
async function getToolUsage(guildId, days = 7) {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const rows = await McpUsage.find({ guildId, day: { $gte: utcDayString(start) } }).lean();

    const servers = new Map();
    for (const row of rows) {
        let server = servers.get(row.server);
        if (!server) {
            server = {
                server: row.server, calls: 0, failures: 0, declined: 0, totalMs: 0,
                unreachable: 0, lastError: null, lastErrorAt: null, tools: new Map()
            };
            servers.set(row.server, server);
        }

        if (row.tool === CONNECTION_ROW) {
            server.unreachable += row.calls;
        } else {
            server.calls += row.calls;
            server.failures += row.failures;
            server.declined += row.declined;
            server.totalMs += row.totalMs;

            const tool = server.tools.get(row.tool)
                || { tool: row.tool, calls: 0, failures: 0, declined: 0, totalMs: 0 };
            tool.calls += row.calls;
            tool.failures += row.failures;
            tool.declined += row.declined;
            tool.totalMs += row.totalMs;
            server.tools.set(row.tool, tool);
        }

        if (row.lastErrorAt && (!server.lastErrorAt || row.lastErrorAt > server.lastErrorAt)) {
            server.lastError = row.lastError;
            server.lastErrorAt = row.lastErrorAt;
        }
    }

    const withAverage = row => ({
        ...row,
        avgMs: row.calls ? Math.round(row.totalMs / row.calls) : 0
    });

    return [...servers.values()]
        .map(server => withAverage({
            ...server,
            tools: [...server.tools.values()]
                .map(withAverage)
                .sort((a, b) => b.calls - a.calls)
        }))
        .sort((a, b) => b.calls - a.calls);
}

module.exports = { recordToolCalls, getToolUsage, summarise, CONNECTION_ROW };
