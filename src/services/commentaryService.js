'use strict';

const { getCompletion, resolveProviderConfig } = require('./aiService');

/**
 * AI colour commentary on the things the scheduler resolves (#836).
 *
 * The bot already decides, every week, who won a war, who topped a season, and
 * who was the champion of each category — and then prints a table about it. The
 * numbers are right and nobody reads them twice. What a resolution is missing is
 * the half-sentence a commentator would add: that it was close, that the
 * favourite collapsed, that the same person has now won mining three weeks
 * running.
 *
 * Every ingredient for that already exists at the moment of resolution. The
 * winner, the scores and the MVP are computed there; the guild has a persona
 * configured for its chat; and `newspaperService` is the standing example of
 * asking a model for prose with a deterministic fallback underneath. This is
 * that pattern applied to the game layer, where the trigger is an event rather
 * than a cron slot.
 *
 * Three things keep it from being a way to spend somebody's money:
 *
 *   - **It is off unless a guild turns it on.** `ai.eventCommentary`, alongside
 *     `ai.enabled`. A guild that connected a key for chat has not thereby asked
 *     for prose on its war announcements.
 *   - **The cadence is the budget.** A war ends when a war ends; a season, a
 *     season. There is no path here that fires more often than the event does,
 *     which is what makes this the cheapest proactive AI in the codebase.
 *   - **It is attributed.** `guildId` goes with the call, so the tokens land on
 *     that guild's ledger and its monthly ceilings apply — these are calls
 *     nobody sent, and the monthly limits are the only ones that bind them
 *     (see services/ai/index.js).
 *
 * `mcp: false`: a commentator has nothing to look up. Everything it is allowed
 * to say is in the prompt, and a tool loop on a scheduled job has no user to
 * charge a tool budget to.
 *
 * Failure is always `null`, never a throw. This runs inside jobs that have
 * already paid people out, and a provider being down must not cost a guild its
 * announcement — the static embed is the announcement, and this is a field on
 * top of it.
 */

// Two or three sentences. The cap is deliberately tight: this rides in an embed
// field next to the numbers, and a model given room will write an essay.
const MAX_TOKENS = 220;

// Discord's embed field ceiling is 1024; leaving room means a long answer is
// trimmed here rather than rejected by the API.
const MAX_CHARS = 900;

const STYLE_RULES =
    'You are writing two or three sentences of colour commentary for a Discord server announcement. '
    + 'Stay in character. React to what actually happened — the margin, the upset, the standout player — '
    + 'and never invent a number, a name or an event that is not in the facts you are given. '
    + 'No headings, no bullet points, no preamble, no sign-off: just the commentary. '
    + 'Do not use @everyone, @here or role pings.';

/**
 * What the model is told about each kind of resolution.
 *
 * A registry rather than three near-identical functions at the call sites, so
 * the scheduler asks for "commentary on this war" and the wording of the ask
 * lives here with the rules it has to obey.
 */
const EVENTS = {
    war: {
        label: 'server war',
        instruct: 'Call the result of this inter-server war for the members of this server.'
    },
    season: {
        label: 'economy season',
        instruct: 'Sign off the season for this server — the podium, and anything the standings say about how it went.'
    },
    champions: {
        label: 'weekly champions',
        instruct: 'Announce this week\'s champions. Give each of them a line\'s worth of credit.'
    }
};

/** `key: value` lines, skipping anything the caller had nothing for. */
function factLines(facts) {
    return Object.entries(facts || {})
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n');
}

/**
 * Model prose is about to be put in an embed, so the mass-mention tokens come
 * out. An embed cannot ping anybody, which makes this cosmetic rather than a
 * control — but a commentary line reading "@everyone go congratulate them" is
 * a bot appearing to try, and the same care the mod-suggestion path takes
 * (services/ai/actions.js) is cheap here.
 */
function sanitize(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const clean = trimmed
        .replace(/@(everyone|here)/gi, '')
        .replace(/<@&\d+>/g, '')
        .trim();
    if (!clean) return null;
    return clean.length > MAX_CHARS ? `${clean.slice(0, MAX_CHARS - 1)}…` : clean;
}

/**
 * Whether this guild has asked for commentary and can pay for it.
 *
 * Exported so a caller can skip the work of assembling facts for a guild that
 * was never going to use them — the weekly sweep touches every guild in the
 * bot, and most of them have no AI configured at all.
 */
function commentaryEnabled(guildDoc) {
    const ai = guildDoc?.ai;
    if (!ai?.enabled || !ai.eventCommentary) return false;
    const { provider, apiKey } = resolveProviderConfig(ai);
    return provider === 'ollama' || Boolean(apiKey);
}

/**
 * Two or three sentences on a resolution, or null.
 *
 * @param {object} guildDoc the guild, with its `ai` settings — a lean document
 *        is fine, this only reads
 * @param {object} request
 * @param {string} request.event one of the keys in `EVENTS`
 * @param {object} request.facts what happened, as `label -> value` pairs; every
 *        one of them is quotable and nothing else is
 * @returns {Promise<?string>} the commentary, or null when the guild has it
 *   switched off, has no usable provider, or the call failed for any reason
 */
async function eventCommentary(guildDoc, { event, facts }) {
    const spec = EVENTS[event];
    if (!spec) return null;
    if (!commentaryEnabled(guildDoc)) return null;

    const { provider, model, apiKey, baseUrl, rateLimit } = resolveProviderConfig(guildDoc.ai);
    // The guild's own voice, the one it configured for chat. A server whose bot
    // is a sardonic pirate should not turn into a sports anchor for one embed.
    const persona = guildDoc.ai.systemPrompt || 'You are a lively Discord bot commentator.';

    try {
        const text = await getCompletion({
            provider, model, apiKey, baseUrl, rateLimit,
            // No userId or channelId: nobody asked for this, so the per-user and
            // per-channel windows have nothing to bind to. The guild's monthly
            // token and cost ceilings are what bound it, and they need guildId.
            guildId: guildDoc.guildId,
            // A commentator has nothing to look up, and a scheduled call has no
            // user to charge a tool budget to.
            mcp: false,
            systemPrompt: `${persona}\n\n${STYLE_RULES}`,
            history: [],
            prompt:
                `${spec.instruct}\n\nServer: ${guildDoc.name || 'this server'}\n`
                + `Event: ${spec.label}\n\nWhat happened:\n${factLines(facts)}`,
            temperature: 0.9,
            maxTokens: MAX_TOKENS
        });
        return sanitize(text);
    } catch (err) {
        // Including a rate-limit refusal, which is the guild's own setting
        // talking and still not a reason to lose the announcement.
        console.warn(`[commentary] ${event} commentary failed for guild ${guildDoc.guildId}: ${err.message}`);
        return null;
    }
}

/**
 * Add the commentary to an embed, if there is any.
 *
 * A helper rather than three copies of the same `if`, and the reason the static
 * embed is genuinely the fallback: the announcement is built and ready before
 * this is called, and a null answer leaves it exactly as it was.
 */
function addCommentary(embed, commentary, name = '🎙️ Commentary') {
    if (embed && commentary) embed.addFields({ name, value: commentary });
    return embed;
}

module.exports = { eventCommentary, addCommentary, commentaryEnabled, MAX_TOKENS, MAX_CHARS };
