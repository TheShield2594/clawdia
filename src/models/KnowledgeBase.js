const { Schema, model } = require('mongoose');

const knowledgeBaseSchema = new Schema({
    guildId:   { type: String, required: true, index: true },
    title:     { type: String, required: true },
    content:   { type: String, required: true },
    tags:      [{ type: String }],
    addedBy:   { type: String, required: true },
    // Stable key for pin-synced entries (`${guildId}:${messageId}`); null for manual entries
    sourceKey: { type: String, default: null },
    createdAt: { type: Date, default: Date.now }
});

knowledgeBaseSchema.index({ guildId: 1, createdAt: -1 });
// Sparse unique index on sourceKey so reruns of sync-pins upsert in place and manual entries (sourceKey=null) are unaffected
knowledgeBaseSchema.index({ guildId: 1, sourceKey: 1 }, { unique: true, sparse: true });
// Compound text index with guildId as equality-prefix so MongoDB can scope $text searches per guild
knowledgeBaseSchema.index({ guildId: 1, title: 'text', content: 'text', tags: 'text' });

module.exports = model('KnowledgeBase', knowledgeBaseSchema);
