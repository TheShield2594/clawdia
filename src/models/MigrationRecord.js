const { Schema, model } = require('mongoose');

/**
 * One row per applied migration, and the lock that keeps two processes from
 * applying the same one (#654).
 *
 * `name` is unique, which is what makes the claim work: the runner inserts the
 * record *before* running the migration, so a second process racing it loses on
 * a duplicate key and waits rather than running the migration a second time.
 *
 * That is also why `state` exists. A row is written in two halves — claimed,
 * then completed — and only a completed one means "applied". Everything that
 * asks whether a migration has run (the runner's own skip list, the shard-wait
 * poll of #732, rollback) has to ignore a row that is merely claimed, or a
 * second shard starts serving traffic against a database that is still being
 * migrated.
 *
 * Records written before this field existed have no `state` at all, and a
 * missing field is not 'running' — which is exactly how they should read: they
 * are finished.
 */
const MigrationRecordSchema = new Schema({
    name: { type: String, required: true, unique: true },
    appliedAt: { type: Date, default: Date.now },
    durationMs: { type: Number, default: null },

    // 'running' while the claim is held, 'complete' once up() has returned.
    // Defaults to complete so a plain create({ name }) still means "applied",
    // which is what the tests and any hand-written record expect.
    state: { type: String, enum: ['running', 'complete'], default: 'complete' },

    // When the claim was taken. A claim whose holder died is only tellable from
    // its age, so this is what lets another process take one over instead of
    // waiting on a process that is never coming back.
    startedAt: { type: Date, default: null },

    // Which process holds the claim. A claim can change hands, so "this row
    // says running" and "this process still holds it" are different questions;
    // every write that completes or releases a claim matches on this as well as
    // the name, so a runner that lost its claim cannot finish or delete the
    // record belonging to the one that took over.
    owner: { type: String, default: null },
});

module.exports = model('MigrationRecord', MigrationRecordSchema);
