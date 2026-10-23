'use strict';

/**
 * When the AI reads its reply aloud (`ai.voiceReplies`, #1231). Shared by the
 * Guild schema, the settings endpoint and services/ai/speech.js, so the enum,
 * the validator and the behaviour cannot list different modes.
 *
 *   off             text only
 *   when-spoken-to  a reply to a voice message is spoken too
 *   always-in-dms   every DM reply is spoken too, and a voice message anywhere
 */
const VOICE_REPLY_MODES = ['off', 'when-spoken-to', 'always-in-dms'];

module.exports = { VOICE_REPLY_MODES };
