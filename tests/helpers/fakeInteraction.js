'use strict';

/**
 * A stand-in ChatInputCommandInteraction, general enough to drive any command
 * that takes options, defers, replies and opens a collector.
 *
 * #786: 86 of the 97 command files with an `execute()` had never had it invoked
 * by a test. The eleven that were driven are the eleven with real coverage,
 * which is the whole argument — nothing about these commands resists testing,
 * there was just no shared harness for them. This is that harness, promoted out
 * of tests/helpers/casinoInteraction.js, which already handled all four of
 * those things for `src/games/casino/*` and nothing else.
 *
 * What a test reads afterwards:
 *
 *   interaction.replies    every payload the command rendered, in order, from
 *                          reply / editReply / followUp / message.edit — which
 *                          is "what did the player actually see"
 *   interaction.channel.sent  anything posted to the channel rather than to the
 *                          interaction, e.g. a milestone announcement
 *
 * Every reply resolves to a message with a collector surface on it, because a
 * command that passes `fetchReply: true` uses the return value. By default the
 * collector never fires and `awaitMessageComponent` rejects the way discord.js
 * does when the window closes — which is the timeout path every one of these
 * commands already handles. `components` queues presses for a test that wants
 * the other one.
 *
 * A queued press goes through the command's own `filter` first, so a press from
 * somebody else is dropped rather than collected — which is what makes a test
 * for "another member reached for this button" possible at all, and what caught
 * every `ownedBy(id, "message")` call site throwing on its own owner's click.
 */

const DEFAULTS = {
    guildId: 'guild-1',
    userId: 'user-1',
    channelId: 'channel-1',
    username: 'player',
    // Every economy command refuses an account younger than seven days, so the
    // default has to be older than that or nothing gets past the first line.
    accountAgeMs: 365 * 24 * 3_600_000,
};

/**
 * @param {object} [opts]
 * @param {object} [opts.options]     what the options resolver returns, by option name
 * @param {string} [opts.subcommand]  what getSubcommand() returns
 * @param {object} [opts.user]        overrides for interaction.user
 * @param {Array}  [opts.components]  button presses to hand back, in order; each
 *                                    is `{ customId, user? }` and becomes a
 *                                    component interaction. Once the queue is
 *                                    empty the window closes, as it does live.
 * @param {Map}    [opts.channels]    guild channels by id, for a command that
 *                                    announces somewhere other than in place
 */
function makeInteraction({
    options = {},
    subcommand = null,
    user: userOverrides = {},
    components = [],
    channels = new Map(),
    guildId = DEFAULTS.guildId,
    userId = DEFAULTS.userId,
} = {}) {
    const replies = [];
    const sent = [];
    const pending = [...components];

    const record = payload => { replies.push(payload); return Promise.resolve(message); };

    /** A filter the command supplied, run the way discord.js runs it. */
    const accepts = (filter, press) => (typeof filter === 'function' ? filter(press) !== false : true);

    const componentInteraction = press => ({
        customId: press.customId,
        user: { id: press.user ?? userId },
        deferUpdate: jest.fn().mockResolvedValue(undefined),
        update: jest.fn(record),
        reply: jest.fn(record),
        editReply: jest.fn(record),
        followUp: jest.fn(record),
        message: { edit: jest.fn(record) },
    });

    const collectors = [];
    const message = {
        id: 'message-1',
        edit: jest.fn(record),
        /**
         * The collector a command attaches handlers to. Presses queued in
         * `components` are delivered on the next tick, then 'end' fires — the
         * same order a real collector produces when its time runs out.
         */
        createMessageComponentCollector: (opts = {}) => {
            const handlers = {};
            let ended = false;
            // discord.js hands 'end' a Collection of what was collected, and
            // commands branch on `collected.size` to tell "nobody pressed" from
            // "somebody did". An array has no `.size`, so that check read
            // `undefined === 0` and the timeout branch of every collector was
            // unreachable from a test. A Map is the Collection surface that
            // matters here.
            const collected = new Map();
            const end = reason => {
                if (ended) return;
                ended = true;
                (handlers.end ?? []).forEach(fn => fn(collected, reason));
            };
            const collector = {
                on(event, fn) { (handlers[event] ??= []).push(fn); return this; },
                stop: () => end('stopped'),
            };
            collectors.push(collector);
            // Deliver once the command has finished wiring its handlers on,
            // which is the tick after it asked for the collector.
            setTimeout(() => {
                while (pending.length && !ended) {
                    const press = componentInteraction(pending.shift());
                    // A rejected press is dropped and the next one tried, the
                    // way a real collector goes on listening.
                    if (!accepts(opts.filter, press)) continue;
                    collected.set(`${collected.size}`, press);
                    (handlers.collect ?? []).forEach(fn => fn(press));
                }
                end('time');
            }, 0);
            return collector;
        },
        awaitMessageComponent: jest.fn((opts = {}) => {
            // Presses the filter turns away do not resolve the await; the real
            // one keeps waiting, so here they are skipped and the next queued
            // press is tried.
            while (pending.length && !accepts(opts.filter, componentInteraction(pending[0]))) {
                pending.shift();
            }
            if (!pending.length) {
                // Exactly what discord.js rejects with when the window closes
                // with no press — the `name` included, because commands branch
                // on it to tell a timeout from a real failure and would
                // otherwise log every one of these as an error.
                const error = new Error('Collector received no interactions before ending with reason: time');
                error.name = 'InteractionCollectorError';
                error.code = 'InteractionCollectorError';
                return Promise.reject(error);
            }
            return Promise.resolve(componentInteraction(pending.shift()));
        }),
    };

    const interaction = {
        replies,
        id: 'interaction-1',
        guildId,
        // The real interaction carries this beside `channel`, and commands
        // compare it against a configured channel to decide whether announcing
        // would just repeat themselves in place. Absent, that comparison was
        // always true and the branch could not be tested.
        channelId: DEFAULTS.channelId,
        user: {
            id: userId,
            username: DEFAULTS.username,
            createdTimestamp: Date.now() - DEFAULTS.accountAgeMs,
            displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png',
            send: jest.fn().mockResolvedValue(undefined),
            ...userOverrides,
        },
        member: { displayName: DEFAULTS.username, id: userId },
        guild: {
            id: guildId,
            name: 'Guild',
            channels: { cache: { get: id => channels.get(id) ?? null } },
            members: { cache: new Map(), fetch: jest.fn().mockResolvedValue(null) },
        },
        channel: {
            id: DEFAULTS.channelId,
            sent,
            send: jest.fn(payload => { sent.push(payload); return Promise.resolve(message); }),
        },
        client: { users: { fetch: jest.fn().mockResolvedValue(null) }, user: { id: 'bot-1' } },
        options: {
            getString:     name => options[name] ?? null,
            getInteger:    name => options[name] ?? null,
            getNumber:     name => options[name] ?? null,
            getBoolean:    name => options[name] ?? null,
            getUser:       name => options[name] ?? null,
            getMember:     name => options[name] ?? null,
            getChannel:    name => options[name] ?? null,
            getFocused:    () => options.focused ?? '',
            getSubcommand: () => subcommand,
        },
        replied: false,
        deferred: false,
        deferReply: jest.fn(function (payload) {
            this.deferred = true;
            return record(payload ?? {});
        }),
        reply: jest.fn(function (payload) {
            this.replied = true;
            return record(payload);
        }),
        editReply: jest.fn(record),
        followUp: jest.fn(record),
        fetchReply: jest.fn().mockResolvedValue(message),
        respond: jest.fn(choices => { replies.push({ choices }); return Promise.resolve(); }),
        // The message every reply resolves to, for a test that wants to reach it
        // without going through a return value.
        message,
    };

    return interaction;
}

/** Everything the command rendered, flattened to text, for a contains-style assertion. */
function repliedText(interaction) {
    return interaction.replies.map(payload => {
        if (!payload) return '';
        const embeds = (payload.embeds ?? []).map(e => {
            const data = e?.data ?? e ?? {};
            const fields = (data.fields ?? []).map(f => `${f.name} ${f.value}`).join(' ');
            return [data.title, data.description, fields, data.footer?.text].filter(Boolean).join(' ');
        });
        return [payload.content, ...embeds].filter(Boolean).join(' ');
    }).join('\n');
}

module.exports = { makeInteraction, repliedText, DEFAULTS };
