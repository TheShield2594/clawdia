const { Schema, model } = require('mongoose');

const MigrationRecordSchema = new Schema({
    name: { type: String, required: true, unique: true },
    appliedAt: { type: Date, default: Date.now },
    durationMs: { type: Number, default: null },
});

module.exports = model('MigrationRecord', MigrationRecordSchema);
