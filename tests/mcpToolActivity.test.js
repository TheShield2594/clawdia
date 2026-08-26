'use strict';

// What the channel is told while MCP tools are running, and afterwards.
//
// The rules worth pinning are the ones a user or an admin would notice: a tool
// that is running is named, a tool that failed is marked, a server that could
// not be reached is reported rather than silently making the model wrong, and
// nothing a *server* chose to call itself can turn into markup or a ping in a
// message the bot sends.

const { createToolActivity, STATUS_RESERVE } = require('../src/services/ai/mcp/activity');

const start = (id, tool, server = 'github') => ({ type: 'start', id, server, tool });
const end = (id, tool, { server = 'github', durationMs = 1200, ok = true } = {}) =>
    ({ type: 'end', id, server, tool, durationMs, ok });

describe('live status', () => {
    test('says nothing until a tool is actually running', () => {
        const activity = createToolActivity();
        expect(activity.render()).toBe('');
        expect(activity.used).toBe(false);
    });

    test('names the tool in flight and the server it belongs to', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));

        expect(activity.render()).toBe('-# 🔧 github · search_repositories…');
        expect(activity.used).toBe(true);
    });

    test('counts the rest instead of listing every parallel call', () => {
        const activity = createToolActivity();
        for (let i = 1; i <= 4; i++) activity.onEvent(start(i, `tool_${i}`));

        expect(activity.render()).toBe('-# 🔧 github · tool_1, github · tool_2 +2 more…');
    });

    test('clears the line once the calls finish', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));
        activity.onEvent(end(1, 'search_repositories'));

        expect(activity.render()).toBe('');
    });

    test('tracks two calls to the same tool separately', () => {
        // Both carry the same name, so only the id distinguishes them; matching
        // on the name would clear the line while one was still running.
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));
        activity.onEvent(start(2, 'search_repositories'));
        activity.onEvent(end(1, 'search_repositories'));

        expect(activity.render()).toBe('-# 🔧 github · search_repositories…');
    });
});

describe('the summary footer', () => {
    test('is empty when no tool ran', () => {
        expect(createToolActivity().footer()).toBe('');
    });

    test('names each call and how long it took', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));
        activity.onEvent(end(1, 'search_repositories', { durationMs: 1240 }));
        activity.onEvent(start(2, 'read_wiki', 'deepwiki'));
        activity.onEvent(end(2, 'read_wiki', { server: 'deepwiki', durationMs: 400 }));

        expect(activity.footer())
            .toBe('-# 🔧 github·search_repositories 1.2s · deepwiki·read_wiki 0.4s');
    });

    test('marks a call that failed', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));
        activity.onEvent(end(1, 'search_repositories', { ok: false, durationMs: 900 }));

        expect(activity.footer()).toBe('-# 🔧 ⚠️ github·search_repositories 0.9s');
    });

    test('counts them once there are too many to name', () => {
        const activity = createToolActivity();
        for (let i = 1; i <= 6; i++) {
            activity.onEvent(start(i, `tool_${i}`));
            activity.onEvent(end(i, `tool_${i}`, { ok: i !== 3 }));
        }

        expect(activity.footer()).toBe('-# 🔧 6 tool calls, 1 failed');
    });

    test('reports a server that could not be reached at all', () => {
        // Nothing was called, so without this the reply is just a model that
        // does not know — and the admin who could fix it never finds out.
        const activity = createToolActivity();
        activity.onEvent({ type: 'unavailable', server: 'github', error: 'HTTP 401' });

        expect(activity.footer()).toBe('-# 🔧 ⚠️ github unreachable');
        expect(activity.used).toBe(true);
    });

    test('reports an unreachable server once, not once per attempt', () => {
        const activity = createToolActivity();
        activity.onEvent({ type: 'unavailable', server: 'github' });
        activity.onEvent({ type: 'unavailable', server: 'github' });

        expect(activity.footer()).toBe('-# 🔧 ⚠️ github unreachable');
    });
});

describe('names from the far side', () => {
    test('strips anything that could open markup or ping a role', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, '`@everyone` <@&123>'));

        const line = activity.render();
        expect(line).not.toMatch(/[`<>@]/);
        expect(line).toBe('-# 🔧 github · everyone 123…');
    });

    test('shortens a name long enough to fill the message on its own', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'a'.repeat(200)));

        expect(activity.render().length).toBeLessThanOrEqual(STATUS_RESERVE);
    });

    test('falls back to a placeholder for a name with nothing usable in it', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, '🙂🙂🙂'));

        expect(activity.render()).toBe('-# 🔧 github · tool…');
    });

    test('keeps a footer of many long names inside the reserve', () => {
        const activity = createToolActivity();
        for (let i = 1; i <= 3; i++) {
            activity.onEvent(start(i, `${'tool_name_'.repeat(6)}${i}`, `${'server_'.repeat(6)}${i}`));
            activity.onEvent(end(i, `${'tool_name_'.repeat(6)}${i}`, { server: `${'server_'.repeat(6)}${i}` }));
        }

        expect(activity.footer().length).toBeLessThanOrEqual(STATUS_RESERVE);
    });
});

describe('decorating the streamed message', () => {
    test('leaves the text alone when nothing is running', () => {
        const activity = createToolActivity();
        expect(activity.decorate('Three open PRs.')).toBe('Three open PRs.');
    });

    test('puts the status on its own line under the text', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));

        expect(activity.decorate('Let me look…'))
            .toBe('Let me look…\n-# 🔧 github · search_repositories…');
    });

    test('never builds a message Discord would refuse', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));

        expect(activity.decorate('x'.repeat(2000)).length).toBeLessThanOrEqual(2000);
    });
});

describe('reset', () => {
    test('forgets a retried attempt so its tools are not counted twice', () => {
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));
        activity.onEvent(end(1, 'search_repositories'));

        activity.reset();
        expect(activity.footer()).toBe('');
        expect(activity.render()).toBe('');
        expect(activity.used).toBe(false);
    });
});

describe('events it does not understand', () => {
    test('ignores them rather than throwing inside the provider loop', () => {
        const activity = createToolActivity();
        expect(() => {
            activity.onEvent(null);
            activity.onEvent('start');
            activity.onEvent({ type: 'progress' });
        }).not.toThrow();
        expect(activity.used).toBe(false);
    });
});

describe('decorating an empty message', () => {
    test('shows the status on its own rather than under a blank line', () => {
        // The first message of a turn that opens with a tool call has no text
        // in it yet; a leading newline there reads as a rendering glitch.
        const activity = createToolActivity();
        activity.onEvent(start(1, 'search_repositories'));

        expect(activity.decorate('')).toBe('-# 🔧 github · search_repositories…');
    });
});
