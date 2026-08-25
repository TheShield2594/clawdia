const { Schema, model } = require('mongoose');

// One row per guild/server/tool/day: what the model actually reached for, how
// often it worked, and how long it took. A per-call log would be the obvious
// shape and the wrong one — a busy guild would write thousands of documents a
// day for a question ("is this connection healthy, and is anything using it?")
// that only ever gets asked in aggregate.
const mcpUsageSchema = new Schema({
    guildId:  { type: String, required: true, index: true },
    server:   { type: String, required: true },
    // The tool's own name, unqualified. `(connection)` is the one reserved
    // value: it counts turns where the server could not be reached at all, so a
    // connection that is down still has a row rather than simply going quiet.
    tool:     { type: String, required: true },
    // ISO date string (YYYY-MM-DD, UTC), matching AIUsage.
    day:      { type: String, required: true },
    calls:    { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    // Calls a person was asked about and said no to, or never answered. Not a
    // failure: the connection worked and the answer was no.
    declined: { type: Number, default: 0 },
    totalMs:  { type: Number, default: 0 },
    lastError:   { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    updatedAt:   { type: Date, default: Date.now }
});

mcpUsageSchema.index(
    { guildId: 1, day: 1, server: 1, tool: 1 },
    { unique: true }
);

module.exports = model('McpUsage', mcpUsageSchema);
