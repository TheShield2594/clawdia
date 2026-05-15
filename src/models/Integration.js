const { Schema, model } = require('mongoose');

const integrationSchema = new Schema({
    guildId:              { type: String, required: true },
    ownerId:              { type: String, required: true },
    appName:              { type: String, required: true },
    displayName:          { type: String, required: true },
    status:               { type: String, enum: ['pending', 'connected', 'error', 'disconnected'], default: 'pending' },
    composioConnectionId: { type: String, default: null },
    connectedAt:          { type: Date, default: null },
    metadata:             { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });

integrationSchema.index({ guildId: 1, appName: 1 }, { unique: true });

module.exports = model('Integration', integrationSchema);
