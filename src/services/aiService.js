// Façade over the ai/ modules, kept so existing import sites and tests keep
// working unchanged. The implementation was split (#615):
//
//   ai/providers/*   — one module per provider behind a common interface,
//                      registered in ai/providers/index.js
//   ai/index.js      — provider config resolution + completion dispatch
//   ai/usage.js      — cost estimation and the per-guild usage ledger
//   ai/knowledge.js  — knowledge-base RAG
//   ai/history.js    — conversation history persistence
//   ai/rateLimit.js  — per-user / per-channel sliding-window limits
//   ai/actions.js    — AI in-channel actions (addendum, parser, executor)
//   ai/discordChat.js — the Discord transport (handleAIChat)

const { resolveProviderConfig, streamCompletion, getCompletion, DEFAULT_MODELS } = require('./ai');
const { handleAIChat } = require('./ai/discordChat');
const { clearHistory } = require('./ai/history');
const { retrieveKnowledge } = require('./ai/knowledge');
const { buildActionsAddendum } = require('./ai/actions');
const { buildMcpAddendum } = require('./ai/mcp/prompt');
const { checkRateLimit, checkChannelRateLimit, peekRateLimit, peekChannelRateLimit, AiRateLimitError, AiBudgetError, monthlyBudgetState } = require('./ai/rateLimit');
const { recordUsage, getUsageStats, estimateCost, loadMonthlyUsage, monthlyBudget } = require('./ai/usage');

module.exports = {
    handleAIChat,
    clearHistory,
    getCompletion,
    streamCompletion,
    resolveProviderConfig,
    retrieveKnowledge,
    buildActionsAddendum,
    buildMcpAddendum,
    checkRateLimit,
    checkChannelRateLimit,
    peekRateLimit,
    peekChannelRateLimit,
    AiRateLimitError,
    AiBudgetError,
    monthlyBudgetState,
    recordUsage,
    getUsageStats,
    loadMonthlyUsage,
    monthlyBudget,
    estimateCost,
    DEFAULT_MODELS
};
