const { Schema, model } = require('mongoose');

const TRIGGER_TYPES = [
    'member_join', 'member_leave', 'message_keyword',
    'role_assigned', 'moderation_action', 'level_up', 'scheduled'
];

const automationSchema = new Schema({
    guildId:   { type: String, required: true, index: true },
    createdBy: { type: String, required: true },
    name:      { type: String, required: true, maxlength: 100 },
    enabled:   { type: Boolean, default: true },
    trigger: {
        type:   { type: String, required: true, enum: TRIGGER_TYPES },
        config: { type: Schema.Types.Mixed, default: {} }
    },
    action: {
        appName:    { type: String, required: true },
        actionName: { type: String, required: true },
        input:      { type: Schema.Types.Mixed, default: {} }
    },
    runCount:  { type: Number, default: 0 },
    lastRunAt: { type: Date, default: null }
}, { timestamps: true });

// Compound index matches the hot query in fire(): { guildId, enabled, trigger.type }
automationSchema.index({ guildId: 1, enabled: 1, 'trigger.type': 1 });

module.exports = model('Automation', automationSchema);
