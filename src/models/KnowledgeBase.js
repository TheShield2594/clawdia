const { Schema, model } = require('mongoose');

const knowledgeBaseSchema = new Schema({
    guildId:   { type: String, required: true, index: true },
    title:     { type: String, required: true },
    content:   { type: String, required: true },
    tags:      [{ type: String }],
    addedBy:   { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

knowledgeBaseSchema.index({ guildId: 1, createdAt: -1 });
knowledgeBaseSchema.index({ title: 'text', content: 'text', tags: 'text' });

module.exports = model('KnowledgeBase', knowledgeBaseSchema);
