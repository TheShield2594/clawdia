'use strict';

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

// How much of a 2000-character Discord message the status line may claim. The
// transport keeps this much free while tools are running so the status can be
// appended without eating the text above it.
const STATUS_RESERVE = 220;

const MAX_LABEL_LENGTH = 40;

// Discord's own limit, repeated here rather than imported from the transport:
// this module is what decides whether the status fits, so it needs the number.
const DISCORD_MAX_LEN = 2000;

/**
 * A tool or server name as something safe to put in a Discord message.
 *
 * Server names are validated on the way into the config, but tool names come
 * from the far side and are whatever that server decided to call things. Here
 * they are display text in a message the bot sends to a channel, so they are
 * reduced to characters that cannot open markup, ping a role, or run to three
 * lines — a server that names a tool `@everyone` gets to be called `everyone`.
 */
function label(text) {
    const clean = String(text || '').replace(/[^A-Za-z0-9._\- ]+/g, '').trim();
    if (!clean) return 'tool';
    return clean.length > MAX_LABEL_LENGTH ? `${clean.slice(0, MAX_LABEL_LENGTH - 1)}…` : clean;
}

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
    let used = false;

    function onEvent(event) {
        if (!event || typeof event !== 'object') return;
        switch (event.type) {
            case 'start':
                used = true;
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
                    ok: event.ok !== false
                });
                break;
            }
            case 'unavailable':
                used = true;
                if (!unreachable.includes(event.server)) unreachable.push(event.server);
                break;
        }
    }

    function reset() {
        active = new Map();
        done = [];
        unreachable = [];
        used = false;
    }

    /** The line shown while calls are in flight, or '' when none are. */
    function render() {
        if (!active.size) return '';
        const names = [...active.values()]
            .slice(0, MAX_LIVE_ENTRIES)
            .map(call => `${label(call.server)} · ${label(call.tool)}`);
        const more = active.size - names.length;
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
            const failed = done.filter(call => !call.ok).length;
            parts.push(`${done.length} tool calls${failed ? `, ${failed} failed` : ''}`);
        } else {
            for (const call of done) {
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
        get calls() { return [...done]; }
    };
}

module.exports = { createToolActivity, STATUS_RESERVE };
