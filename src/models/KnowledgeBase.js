const { Schema, model } = require('mongoose');

const knowledgeBaseSchema = new Schema({
    guildId:   { type: String, required: true, index: true },
    title:     { type: String, required: true },
    content:   { type: String, required: true },
    tags:      [{ type: String }],
    addedBy:   { type: String, required: true },
    // Stable key for pin-synced entries (`${guildId}:${messageId}`); absent for manual entries
    sourceKey: { type: String },
    // The semantic-retrieval vector for this entry, and the embedder that made
    // it (#1042). Both absent unless a guild has the semantic tier switched on:
    // the vector is computed from title+content+tags when the entry is written,
    // and read back at query time to find paraphrases the keyword scorer misses.
    // `embeddingModel` is the embedder's identity (e.g. `local:Xenova/all-MiniLM-L6-v2`)
    // so a guild that later switches provider or model does not compare vectors
    // from two different spaces — retrieval only reads vectors tagged with the
    // embedder it is asking with, and a stale one falls back to keyword scoring
    // until the entry is re-saved.
    embedding:      { type: [Number], default: undefined },
    embeddingModel: { type: String },
    createdAt: { type: Date, default: Date.now }
});

knowledgeBaseSchema.index({ guildId: 1, createdAt: -1 });
// Sparse unique index on sourceKey so reruns of sync-pins upsert in place and manual entries (sourceKey absent/undefined, not present) are unaffected
knowledgeBaseSchema.index({ guildId: 1, sourceKey: 1 }, { unique: true, sparse: true });
// Compound text index with guildId as equality-prefix so MongoDB can scope $text searches per guild
knowledgeBaseSchema.index({ guildId: 1, title: 'text', content: 'text', tags: 'text' });

module.exports = model('KnowledgeBase', knowledgeBaseSchema);
