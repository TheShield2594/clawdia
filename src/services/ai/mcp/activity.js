'use strict';

const { toolLabel: label } = require('../../../utils/toolLabel');

// What a user sees while the bot is calling MCP tools.
//
// A tool round is dead air. The model has stopped producing text, the bot is
// waiting on somebody else's HTTP request, and the Discord message sits on "…"
// for as long as that takes — which for a repository search or a calendar query
// is seconds, not milliseconds. Nothing in the reply afterwards says a tool ran
// at all, so a slow answer looks like a stuck bot and a wrong answer from an
// unreachable server looks like a confidently wrong model.
//
// This turns the toolkit's events into two short pieces of text: a live line
// naming the tools running right now, and a footer on the finished reply
// listing what ran, how long it took and what failed.

// Live status names at most this many tools; the rest become "+N more". Two is
// what fits on one line on a phone.
const MAX_LIVE_ENTRIES = 2;

// Past this many calls the footer stops naming them and gives a count instead,
// which is both shorter and more useful than eight truncated tool names.
const MAX_FOOTER_ENTRIES = 4;

// Files one reply may carry into the channel. Discord takes ten per message;
// four is what a reply can carry without becoming an image dump, and the
// toolkit has already capped each individual result.
const MAX_ATTACHMENTS = 4;

// And a ceiling on what is held in memory until the reply lands. Discord's own
// limit for an unboosted server is 10MB per message.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// How much of a 2000-character Discord message the status line may claim. The
// transport keeps this much free while tools are running so the status can be
// appended without eating the text above it.
const STATUS_RESERVE = 220;

// Discord's own limit, repeated here rather than imported from the transport:
// this module is what decides whether the status fits, so it needs the number.
const DISCORD_MAX_LEN = 2000;

function seconds(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    return `${(ms / 1000).toFixed(1)}s`;
}

function clamp(text, limit) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A per-turn record of MCP tool activity.
 *
 * One of these is created per Discord reply and handed to the provider as
 * `onToolEvent`, so it sees every call the model makes across every round.
 * `reset()` exists because the transport retries a failed stream from the
 * start: without it a retried turn would report each tool twice.
 */
function createToolActivity() {
    let active = new Map();
    let done = [];
    let unreachable = [];
    let files = [];
    let fileBytes = 0;
    let used = false;
    // Separate from `used`, which a server merely being unreachable also sets.
    // This one means a tool call was actually put in motion — which is what
    // makes re-running the turn something with consequences.
    let attempted = false;

    function onEvent(event) {
        if (!event || typeof event !== 'object') return;
        switch (event.type) {
            // A call held at the approval prompt is the one wait a user can do
            // something about, so it is worth its own wording rather than
            // looking like a tool that is being slow.
            case 'confirm':
                used = true;
                attempted = true;
                active.set(event.id, { server: event.server, tool: event.tool, awaiting: true });
                break;
            case 'start':
                used = true;
                attempted = true;
                active.set(event.id, { server: event.server, tool: event.tool });
                break;
            case 'end': {
                used = true;
                const call = active.get(event.id);
                active.delete(event.id);
                done.push({
                    server: event.server ?? call?.server,
                    tool: event.tool ?? call?.tool,
                    durationMs: event.durationMs,
                    ok: event.ok !== false,
                    declined: event.declined === true,
                    // Kept for the ledger, never for the footer: "what exactly
                    // did the server say" is a question for the dashboard, not
                    // for the channel the reply landed in.
                    error: typeof event.error === 'string' ? event.error : null
                });
                break;
            }
            case 'unavailable':
                used = true;
                if (!unreachable.includes(event.server)) unreachable.push(event.server);
                break;
            // A chart, a screenshot, a rendered page: something the channel can
            // show and the model cannot use. Dropped past the cap rather than
            // queued — a reply that arrives is worth more than every file in it.
            case 'attachment': {
                if (!Buffer.isBuffer(event.buffer) || !event.buffer.length) break;
                if (files.length >= MAX_ATTACHMENTS) break;
                if (fileBytes + event.buffer.length > MAX_ATTACHMENT_BYTES) break;
                used = true;
                fileBytes += event.buffer.length;
                files.push({ attachment: event.buffer, name: event.name });
                break;
            }
        }
    }

    function reset() {
        active = new Map();
        done = [];
        unreachable = [];
        files = [];
        fileBytes = 0;
        used = false;
        attempted = false;
    }

    /** The line shown while calls are in flight, or '' when none are. */
    function render() {
        if (!active.size) return '';
        const calls = [...active.values()];
        // A prompt on screen is what the whole reply is now blocked on, so it
        // takes the line rather than queueing behind whatever else is running.
        const waiting = calls.filter(call => call.awaiting);
        if (waiting.length) {
            const names = waiting.slice(0, MAX_LIVE_ENTRIES)
                .map(call => `${label(call.server)} · ${label(call.tool)}`);
            const more = waiting.length - names.length;
            return clamp(
                `-# ⏸️ waiting for approval: ${names.join(', ')}${more > 0 ? ` +${more} more` : ''}`,
                STATUS_RESERVE
            );
        }

        const names = calls
            .slice(0, MAX_LIVE_ENTRIES)
            .map(call => `${label(call.server)} · ${label(call.tool)}`);
        const more = calls.length - names.length;
        return clamp(`-# 🔧 ${names.join(', ')}${more > 0 ? ` +${more} more` : ''}…`, STATUS_RESERVE);
    }

    /**
     * The summary left on the finished reply, or '' when no tool ran.
     *
     * A server that could not be reached is named here even though it produced
     * no calls: it is the difference between "the model does not know" and "the
     * thing that knows was down", and the admin who can fix it is reading the
     * same channel.
     */
    function footer() {
        if (!done.length && !unreachable.length) return '';

        const parts = [];
        if (done.length > MAX_FOOTER_ENTRIES) {
            const declined = done.filter(call => call.declined).length;
            const failed = done.filter(call => !call.ok && !call.declined).length;
            parts.push([
                `${done.length} tool calls`,
                failed ? `${failed} failed` : '',
                declined ? `${declined} not approved` : ''
            ].filter(Boolean).join(', '));
        } else {
            for (const call of done) {
                // A call nobody approved did not fail — it was answered, and
                // saying so is the difference between a broken server and a
                // moderator who said no.
                if (call.declined) {
                    parts.push(`⛔ ${label(call.server)}·${label(call.tool)} not approved`);
                    continue;
                }
                const time = seconds(call.durationMs);
                parts.push(`${call.ok ? '' : '⚠️ '}${label(call.server)}·${label(call.tool)}${time ? ` ${time}` : ''}`);
            }
        }
        for (const server of unreachable) parts.push(`⚠️ ${label(server)} unreachable`);

        return clamp(`-# 🔧 ${parts.join(' · ')}`, STATUS_RESERVE);
    }

    /**
     * `text` with the live status appended, ready to be put in a message.
     *
     * The body is trimmed to fit rather than the status dropped: the status is
     * the part that is changing, and a body long enough to collide with it is
     * about to be flushed into its own message anyway.
     */
    function decorate(text) {
        const status = render();
        const body = text || '';
        if (!status) return body;
        if (!body) return status;
        const room = DISCORD_MAX_LEN - status.length - 1;
        return `${body.length > room ? clamp(body, room) : body}\n${status}`;
    }

    return {
        onEvent,
        reset,
        render,
        footer,
        decorate,
        // Whether any tool event has been seen this turn. The transport asks so
        // it only reserves room for a status line once there is one to show.
        get used() { return used; },
        // Whether any tool call was put in motion this turn. The transport asks
        // before retrying a failed stream: re-running the turn would re-run the
        // calls, and a tool that wrote something cannot be un-written.
        get ranTools() { return attempted; },
        get calls() { return [...done]; },
        get unreachableServers() { return [...unreachable]; },
        // In the shape discord.js takes, so the transport hands them straight on.
        get attachments() { return [...files]; }
    };
}

module.exports = { createToolActivity, STATUS_RESERVE, MAX_ATTACHMENTS };
