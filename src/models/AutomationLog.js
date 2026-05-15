const { Schema, model } = require('mongoose');

const automationLogSchema = new Schema({
    guildId:        { type: String, required: true },
    automationId:   { type: Schema.Types.ObjectId, ref: 'Automation', index: true },
    automationName: { type: String },
    triggerType:    { type: String },
    success:        { type: Boolean, default: false },
    error:          { type: String, default: null },
    contextData:    { type: Schema.Types.Mixed, default: {} },
    executedAt:     { type: Date, default: Date.now }
}, { timestamps: false });

automationLogSchema.index({ guildId: 1, executedAt: -1 });
// Retain logs for 30 days, then let MongoDB remove them automatically
automationLogSchema.index({ executedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = model('AutomationLog', automationLogSchema);
