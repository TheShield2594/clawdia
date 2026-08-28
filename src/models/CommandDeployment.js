const { Schema, model } = require('mongoose');

/**
 * What the global slash-command set looked like the last time it was published
 * (#643).
 *
 * The bot deploys its commands on every `clientReady`, which is what makes the
 * documented Docker quick-start produce a bot that actually has commands — no
 * `npm run deploy` step the container never runs. Doing that unconditionally
 * meant a full `PUT` of ~98 commands to Discord on every restart, and under
 * sharding one per shard, all publishing the same set. This is the record that
 * makes the deploy conditional: one document, holding a hash of the payload
 * that was last accepted.
 *
 * `pending` is the crash marker. It is set when a deploy claims the hash and
 * cleared when Discord accepts the payload, so a process that dies mid-`PUT`
 * leaves a claim the next boot can see and retry rather than a hash that says
 * "already done".
 */
const CommandDeploymentSchema = new Schema({
    // Fixed key — there is exactly one global command set per application.
    // Declared as a String so it is the name the gate supplies rather than a
    // generated ObjectId; with one of those, every boot would insert a new
    // document and never match the previous one, and the claim could not be an
    // upsert.
    _id: { type: String, required: true },
    // sha256 of the serialized payload plus the application id. Null while a
    // deploy is being retried, so the next boot's `$ne` always matches.
    hash: { type: String, default: null },
    // Set on claim, cleared on success. A document left pending is a deploy
    // that never finished.
    pending: { type: Boolean, default: false },
    clientId: { type: String, default: null },
    commandCount: { type: Number, default: null },
    deployedAt: { type: Date, default: null },
}, { versionKey: false });

module.exports = model('CommandDeployment', CommandDeploymentSchema);
