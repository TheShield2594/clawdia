'use strict';

// Semantic retrieval: the embedding backend behind the knowledge base's
// meaning-based tier (#1042).
//
// The rest of AI retrieval scores by literal token overlap — a stemmer that
// fits on a page and an author-curated synonym map (services/ai/retrieval.js)
// — which is the right call for the ~640 fixed game records and the command
// tree: small, fixed, and wanting exact numbers. It is the wrong call for the
// one corpus that both grows *and* is phrased by users rather than authored:
// the guild knowledge base. A question that shares no stem with any entry
// retrieves nothing, so the model answers blind even though the fact was on
// file. This module turns a piece of text into a vector so cosine distance can
// find those paraphrases; services/ai/knowledge.js unions the nearest few with
// the keyword hits and hands the union to the existing budget/trim ordering.
//
// One interface, three backends, chosen per guild:
//   local  — @xenova/transformers, all-MiniLM-L6-v2, on-device, no key. The
//            default, so switching the tier on costs no new credential. The
//            package is not bundled (it pulls a large native dependency tree),
//            so an operator who wants the on-device option installs it and the
//            model downloads on first use; until then the tier logs a note and
//            falls back to keyword scoring, so an operator who never enables
//            this installs nothing and pays nothing.
//   openai — text-embedding-3-small, using the guild's existing OpenAI key.
//   gemini — text-embedding-004, using the guild's existing Gemini key.
//
// Everything heavy is required lazily inside the function that needs it —
// nothing here loads a provider SDK or the transformers runtime at import time,
// so requiring this module (as knowledge.js does, for `cosineSimilarity`) is
// cheap whether or not any guild has the tier on.

const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const GEMINI_EMBED_MODEL = 'text-embedding-004';

/**
 * Cosine similarity of two vectors, in [-1, 1]; 0 for anything malformed.
 *
 * The local and OpenAI vectors arrive normalized, so this is effectively a dot
 * product for them, but Gemini's are not guaranteed to be — and a stored vector
 * can outlive a code change — so the norms are computed rather than assumed.
 * Mismatched lengths mean two different embedders' output met, which is not a
 * comparison worth making: it returns 0 so a stale vector simply does not match
 * rather than scoring nonsense.
 */
function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The guild's semantic-retrieval config, or null when it is off.
 *
 * Null is the whole of the "off unless enabled" contract: every caller treats a
 * null embedder as "keyword scoring only", so a guild that never switched this
 * on takes exactly the path it took before this module existed.
 */
function semanticConfig(aiSettings) {
    const settings = aiSettings?.semanticRetrieval;
    if (!settings || !settings.enabled) return null;
    return {
        provider: settings.provider || 'local',
        localModel: settings.localModel || DEFAULT_LOCAL_MODEL
    };
}

/**
 * A stable identity for the vectors a config produces, stored beside each
 * vector as `embeddingModel`.
 *
 * Two embedders put text in two different spaces, and a cosine between them is
 * meaningless. Tagging every stored vector with the embedder that made it lets
 * retrieval read only the vectors it can actually compare — so switching a
 * guild from local to OpenAI, or bumping the local model, does not silently
 * start ranking against vectors from the old space; the old ones are ignored
 * until the entry is re-saved.
 */
function embedderId(config) {
    if (!config) return null;
    if (config.provider === 'openai') return `openai:${OPENAI_EMBED_MODEL}`;
    if (config.provider === 'gemini') return `gemini:${GEMINI_EMBED_MODEL}`;
    return `local:${config.localModel}`;
}

// One loaded pipeline per local model, kept for the life of the process: the
// first call downloads and initialises the model (the reason the tier is
// opt-in), and every call after it is a matrix multiply. Keyed by model name so
// an operator changing the model loads the new one without a restart.
const localPipelines = new Map();
// Set once the transformers package is found to be absent, so a guild with the
// local tier on does not pay a failing `require` on every message.
let transformersMissing = false;

/**
 * The on-device embedder for `model`, or null when it cannot be loaded.
 *
 * The package is optional and the model is a network download, so both failure
 * modes — not installed, and could-not-load — degrade to keyword scoring with a
 * warning rather than throwing onto the reply path.
 */
async function localEmbedder(model) {
    if (transformersMissing) return null;

    let pipelinePromise = localPipelines.get(model);
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            let transformers;
            try {
                transformers = require('@xenova/transformers');
            } catch {
                transformersMissing = true;
                console.warn('[AI:embeddings] @xenova/transformers is not installed, so the local semantic tier is off. '
                    + 'Run `npm install @xenova/transformers` to enable on-device embeddings.');
                return null;
            }
            return transformers.pipeline('feature-extraction', model);
        })().catch(err => {
            // A load failure is per-model, not permanent: clear it so a later
            // message can retry (a transient download failure, say) rather than
            // wedging the tier off until a restart.
            localPipelines.delete(model);
            console.warn(`[AI:embeddings] could not load the local model "${model}": ${err.message}`);
            return null;
        });
        localPipelines.set(model, pipelinePromise);
    }

    const extractor = await pipelinePromise;
    if (!extractor) return null;

    return async texts => {
        const vectors = [];
        for (const text of texts) {
            // Mean-pooled and normalized is the sentence-embedding recipe for
            // this model family; `data` is a typed array, copied to a plain one
            // so it stores and serialises cleanly.
            const output = await extractor(text, { pooling: 'mean', normalize: true });
            vectors.push(Array.from(output.data));
        }
        return vectors;
    };
}

/** The OpenAI embedder for this guild, or null when no key resolves. */
async function openaiEmbedder(aiSettings) {
    const { decryptSecret } = require('../../config/secretBox');
    const apiKey = decryptSecret(aiSettings.openaiKey) || process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });
    return async texts => {
        const response = await client.embeddings.create({ model: OPENAI_EMBED_MODEL, input: texts });
        return response.data.map(item => item.embedding);
    };
}

/** The Gemini embedder for this guild, or null when no key resolves. */
async function geminiEmbedder(aiSettings) {
    const { decryptSecret } = require('../../config/secretBox');
    const apiKey = decryptSecret(aiSettings.geminiKey) || process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey });
    return async texts => {
        const response = await client.models.embedContent({ model: GEMINI_EMBED_MODEL, contents: texts });
        return (response.embeddings || []).map(item => item.values);
    };
}

/**
 * The embedder a guild's settings ask for, or null when the tier is off or
 * cannot be stood up.
 *
 * @param {object} aiSettings a guild's `ai` settings subdocument
 * @returns {Promise<null|{id: string, embed: (texts: string[]) => Promise<number[][]>}>}
 *   `id` is the embedder's identity, stored beside each vector; `embed` turns a
 *   batch of strings into their vectors. Null on every failure — no key, package
 *   missing, model unavailable — so callers treat "no embedder" and "tier off"
 *   the same way and fall back to keyword scoring.
 */
async function getEmbedder(aiSettings) {
    const config = semanticConfig(aiSettings);
    if (!config) return null;

    let embed;
    try {
        if (config.provider === 'openai') embed = await openaiEmbedder(aiSettings);
        else if (config.provider === 'gemini') embed = await geminiEmbedder(aiSettings);
        else embed = await localEmbedder(config.localModel);
    } catch (err) {
        console.warn(`[AI:embeddings] could not initialise the ${config.provider} embedder: ${err.message}`);
        return null;
    }
    if (!embed) return null;

    return { id: embedderId(config), embed };
}

/**
 * Embed one document for storage on its record, or null when the tier is off or
 * embedding failed.
 *
 * Best-effort by design: it is called on the knowledge-base write path, and a
 * failure there should store the entry without a vector (retrieval falls back to
 * keyword) rather than fail the write.
 *
 * @returns {Promise<null|{embedding: number[], embeddingModel: string}>}
 */
async function embedForStorage(aiSettings, text) {
    const embedder = await getEmbedder(aiSettings);
    if (!embedder) return null;

    try {
        const [vector] = await embedder.embed([String(text || '')]);
        if (!Array.isArray(vector) || !vector.length) return null;
        return { embedding: vector, embeddingModel: embedder.id };
    } catch (err) {
        console.warn(`[AI:embeddings] could not embed an entry for storage: ${err.message}`);
        return null;
    }
}

module.exports = {
    cosineSimilarity,
    semanticConfig,
    embedderId,
    getEmbedder,
    embedForStorage,
    DEFAULT_LOCAL_MODEL,
    OPENAI_EMBED_MODEL,
    GEMINI_EMBED_MODEL
};
