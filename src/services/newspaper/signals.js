'use strict';

const User         = require('../../models/User');
const Case         = require('../../models/Case');
const Transaction  = require('../../models/Transaction');
const GrindProfile = require('../../models/GrindProfile');
const AiItem       = require('../../models/AiItem');
const AiQuest      = require('../../models/AiQuest');
const WeeklyChampion = require('../../models/WeeklyChampion');
const { topByNetWorth } = require('../../utils/netWorth');
const { getPreviousWeekKey } = require('../../utils/weeklyChampion');

/**
 * What the server newspaper can write about (#836).
 *
 * The paper used to know six things — earners, levels, casino wins, mod
 * actions, grind leaders, new members — because `collectStats` was six `if`
 * blocks, `buildDataSummary` was six more, and the plain-text fallback was six
 * after that. Adding a seventh meant editing three functions in step and
 * remembering the toggle, so nothing was ever added, and the paper reported on
 * a fraction of a bot that by then also had AI-forged items, generated quests,
 * inter-server wars, weekly champions and a live shop economy.
 *
 * So each thing the paper can cover is one entry here, and the three functions
 * become three loops over this list:
 *
 *   - `id`      the key in `guildDoc.newspaper.sections`, so a section is
 *               switched off exactly the way the six original ones are.
 *   - `query`   reads the signal. Returns whatever the two renderers want;
 *               `null` and `[]` are both "nothing to say".
 *   - `userIds` which Discord IDs the result needs resolved to names, so the
 *               paper still resolves every member in one `members.fetch`.
 *   - `brief`   the block handed to the model, in the flat upper-case style the
 *               prompt has always used.
 *   - `render`  the lines for the paper printed when there is no model, or when
 *               the model failed.
 *
 * A signal that throws costs its own section and nothing else — with eleven
 * queries behind one weekly embed, one bad collection must not be the reason a
 * server gets no paper at all.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A name for a user id, or a stable placeholder. */
const nameOf = (names, userId) => names[userId] || 'Unknown';

const MEDALS = ['🥇', '🥈', '🥉'];

const SIGNALS = [
    {
        id: 'topEarners',
        // Ranked on balance + bank so the paper's rich list matches the one
        // `/leaderboard economy` and the dashboard print.
        query: ({ guildId }) => topByNetWorth(User, guildId, 5),
        userIds: rows => rows.map(u => u.userId),
        brief: (rows, { names, currency }) => rows.length && [
            'TOP EARNERS (NET WORTH — BALANCE + BANK):',
            ...rows.map((u, i) => `  ${i + 1}. ${nameOf(names, u.userId)} — ${(u.netWorth || 0).toLocaleString()} ${currency}`)
        ].join('\n'),
        render: (rows, { names, currency }) => rows.slice(0, 3).map((u, i) =>
            `${MEDALS[i]} **${nameOf(names, u.userId)}** — ${(u.netWorth || 0).toLocaleString()} ${currency}`),
        heading: '**💰 Top Earners**'
    },
    {
        id: 'levelUps',
        query: ({ guildId }) => User.find({ guildId })
            .sort({ level: -1 }).limit(5).select('userId level xp').lean(),
        userIds: rows => rows.map(u => u.userId),
        brief: (rows, { names }) => rows.length && [
            'TOP LEVELS:',
            ...rows.map((u, i) => `  ${i + 1}. ${nameOf(names, u.userId)} — Level ${u.level}`)
        ].join('\n'),
        render: (rows, { names }) => rows.slice(0, 3).map((u, i) =>
            `${i + 1}. **${nameOf(names, u.userId)}** — Level ${u.level}`),
        heading: '**📈 Level Leaders**'
    },
    {
        id: 'casinoHighlights',
        query: ({ guildId, since }) => Transaction.find({
            guildId,
            type: { $in: ['gamble', 'casino_jackpot', 'duel_win'] },
            amount: { $gt: 0 },
            createdAt: { $gte: since }
        }).sort({ amount: -1 }).limit(5).select('userId type amount note').lean(),
        userIds: rows => rows.map(t => t.userId),
        // The one signal that says something when it has nothing: a quiet week
        // at the tables is itself a fact about the week, and the model writes
        // better copy for "nothing happened" than for a missing section.
        brief: (rows, { names, currency }) => rows.length
            ? [
                'BIGGEST WINS THIS WEEK:',
                ...rows.map(t => `  ${nameOf(names, t.userId)} — +${t.amount.toLocaleString()} ${currency} (${t.type.replace(/_/g, ' ')})`)
            ].join('\n')
            : 'CASINO HIGHLIGHTS: A quiet week at the tables. No major wins.',
        render: (rows, { names, currency }) => rows.slice(0, 3).map(t =>
            `• **${nameOf(names, t.userId)}** won **${t.amount.toLocaleString()} ${currency}**`),
        heading: '**🎰 Casino Highlights**'
    },
    {
        id: 'moderationDigest',
        query: ({ guildId, since }) => Case.countDocuments({ guildId, createdAt: { $gte: since } }),
        brief: count => `MODERATION: ${count} action${count === 1 ? '' : 's'} taken this week.`,
        render: count => [`**🛡️ Moderation Digest** — ${count} action${count === 1 ? '' : 's'} this week.`]
    },
    {
        id: 'gameStandouts',
        query: async ({ guildId }) => {
            const topBySystem = system =>
                GrindProfile.findOne({ guildId, system, 'data.xp': { $gt: 0 } })
                    .sort({ 'data.xp': -1 }).select('userId data').lean()
                    .then(p => (p ? { userId: p.userId, level: p.data?.level ?? 1 } : null));
            const [hunt, fishing, mining, exploration] = await Promise.all([
                topBySystem('hunt'), topBySystem('fishing'), topBySystem('mining'), topBySystem('exploration'),
            ]);
            return [
                { emoji: '🏹', label: 'hunting', short: 'Hunt', leader: hunt },
                { emoji: '🎣', label: 'fishing', short: 'Fishing', leader: fishing },
                { emoji: '⛏️', label: 'mining', short: 'Mining', leader: mining },
                { emoji: '🧭', label: 'exploration', short: 'Explorer', leader: exploration },
            ].filter(entry => entry.leader);
        },
        userIds: rows => rows.map(entry => entry.leader.userId),
        brief: (rows, { names }) => rows.length && ['GAME STANDOUTS:', ...rows.map(
            ({ emoji, label, leader }) => `  ${emoji} ${nameOf(names, leader.userId)} leads ${label} at level ${leader.level}`
        )].join('\n'),
        render: (rows, { names }) => rows.map(
            ({ emoji, short, leader }) => `${emoji} **${nameOf(names, leader.userId)}** — ${short} Level ${leader.level}`),
        heading: '**🎮 Game Standouts**'
    },
    {
        id: 'newMembers',
        query: ({ guildId, since }) => User.countDocuments({ guildId, createdAt: { $gte: since } }),
        brief: count => `NEW MEMBERS: ${count} new member${count === 1 ? '' : 's'} joined this week.`,
        render: count => [`**👋 New Members** — ${count} new member${count === 1 ? '' : 's'} joined this week.`]
    },

    // ── What the paper never knew about ──────────────────────────────────────

    {
        // The war the guild just fought. `activeWar` holds the last one whether
        // it is running or finished, so this reports a result the members
        // already saw an announcement for and a deadline they have not.
        id: 'warReport',
        query: ({ guildDoc }) => {
            const war = guildDoc?.activeWar;
            if (!war?.opponentGuildName) return null;
            return {
                opponent: war.opponentGuildName,
                us: war.myScore ?? 0,
                them: war.opponentScore ?? 0,
                running: war.status === 'active',
                endsAt: war.endsAt ?? null
            };
        },
        brief: war => war && (war.running
            ? `WAR IN PROGRESS against ${war.opponent}: ${war.us.toLocaleString()} — ${war.them.toLocaleString()}.`
            : `LAST WAR against ${war.opponent}: ${war.us.toLocaleString()} — ${war.them.toLocaleString()} (`
              + `${war.us === war.them ? 'a draw' : war.us > war.them ? 'we won' : 'we lost'}).`),
        render: war => war ? [
            `**⚔️ ${war.running ? 'War Room' : 'War Report'}** — vs **${war.opponent}**: `
            + `${war.us.toLocaleString()} — ${war.them.toLocaleString()}`
            + `${war.running ? ' (still running)' : war.us === war.them ? ' — a draw' : war.us > war.them ? ' — **we won**' : ' — we lost'}`
        ] : []
    },
    {
        // Items the AI forged this week. One of the most distinctive things the
        // bot does and the paper had no idea it happened.
        id: 'legendaryForges',
        query: ({ guildId, since }) => AiItem.find({ guildId, createdAt: { $gte: since } })
            .sort({ createdAt: -1 }).limit(5).select('name emoji rarity createdBy').lean(),
        userIds: rows => rows.map(item => item.createdBy),
        brief: (rows, { names }) => rows.length && ['LEGENDARY ITEMS FORGED THIS WEEK:', ...rows.map(
            item => `  ${item.emoji || '✨'} ${item.name} (${item.rarity || 'Legendary'}) — forged by ${nameOf(names, item.createdBy)}`
        )].join('\n'),
        render: (rows, { names }) => rows.slice(0, 3).map(
            item => `${item.emoji || '✨'} **${item.name}** — forged by ${nameOf(names, item.createdBy)}`),
        heading: '**⚒️ The Forge**'
    },
    {
        // Quests: how many were finished server-wide, and which legendary ones
        // the AI wrote. `quests` is an array on each user, so the count is an
        // aggregation rather than a `countDocuments` — one row per completion,
        // not per player.
        id: 'questLog',
        query: async ({ guildId, since }) => {
            const [completed, forged] = await Promise.all([
                User.aggregate([
                    { $match: { guildId } },
                    { $unwind: '$quests' },
                    { $match: { 'quests.completedAt': { $gte: since } } },
                    { $count: 'total' }
                ]).then(rows => rows[0]?.total ?? 0),
                AiQuest.find({ guildId, createdAt: { $gte: since } })
                    .sort({ createdAt: -1 }).limit(3).select('name emoji mechanic').lean()
            ]);
            return { completed, forged };
        },
        brief: ({ completed, forged }) => (completed || forged.length) && [
            `QUESTS: ${completed} quest${completed === 1 ? '' : 's'} completed across the server this week.`,
            ...forged.map(q => `  New legendary quest: ${q.emoji || '⭐'} ${q.name} (${q.mechanic})`)
        ].join('\n'),
        render: ({ completed, forged }) => {
            if (!completed && !forged.length) return [];
            return [
                `**📜 Quest Log** — ${completed} quest${completed === 1 ? '' : 's'} completed this week.`,
                ...forged.map(q => `${q.emoji || '⭐'} New legendary quest: **${q.name}**`)
            ];
        }
    },
    {
        // Last week's champions, from the rows the Monday sweep crowned. The
        // paper is the only place a member who missed the announcement sees
        // them.
        id: 'championBoard',
        query: ({ guildId }) => WeeklyChampion.find({ guildId, week: getPreviousWeekKey(), rewarded: true })
            .sort({ total: -1 }).select('category username userId total runs').lean(),
        userIds: rows => rows.map(row => row.userId),
        brief: rows => rows.length && ['CHAMPIONS OF LAST WEEK:', ...rows.map(
            row => `  ${row.category}: ${row.username} — ${(row.total ?? 0).toLocaleString()} over ${row.runs ?? 0} run${row.runs === 1 ? '' : 's'}`
        )].join('\n'),
        render: rows => rows.map(
            row => `👑 **${row.username}** — ${row.category} (${(row.total ?? 0).toLocaleString()})`),
        heading: '**🏆 Last Week\'s Champions**'
    },
    {
        // What the dynamic-pricing job did to the shop. `recalcShopPrices`
        // writes a `priceHistory` entry every tick and nothing ever read it
        // back — this is the week's biggest movers, which is the closest thing
        // the server has to a stock ticker.
        id: 'priceMovers',
        query: ({ guildDoc, since }) => {
            if (!guildDoc?.dynamicPricing?.enabled) return [];
            const movers = [];
            for (const item of guildDoc.shop || []) {
                const history = (item.priceHistory || []).filter(point => point.at >= since);
                if (history.length < 2 || !item.currentPrice) continue;
                const opened = history[0].price;
                if (!opened) continue;
                const change = Math.round(((item.currentPrice - opened) / opened) * 100);
                if (Math.abs(change) < 5) continue;
                movers.push({ name: item.name, change, price: item.currentPrice });
            }
            return movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 3);
        },
        brief: (movers, { currency }) => movers.length && ['SHOP PRICE MOVERS THIS WEEK:', ...movers.map(
            m => `  ${m.name}: ${m.change > 0 ? '+' : ''}${m.change}% to ${m.price.toLocaleString()} ${currency}`
        )].join('\n'),
        render: (movers, { currency }) => movers.map(
            m => `${m.change > 0 ? '📈' : '📉'} **${m.name}** ${m.change > 0 ? '+' : ''}${m.change}% — now ${m.price.toLocaleString()} ${currency}`),
        heading: '**🏪 Market Watch**'
    }
];

/**
 * Read every signal the guild has switched on.
 *
 * Sections default to on, the way the original six did — a guild that has never
 * touched the toggles gets the whole paper. A query that throws is logged and
 * dropped: with eleven of them behind one weekly embed, one bad collection is
 * not a reason for a server to get nothing.
 *
 * @param {object} context
 * @param {string} context.guildId
 * @param {object} context.guildDoc the guild, for the signals that read it
 * @param {object} context.sections `guildDoc.newspaper.sections`
 * @returns {Promise<object>} `id -> result`, holding only the signals that ran
 */
async function collectSignals({ guildId, guildDoc, sections = {} }) {
    const since = new Date(Date.now() - WEEK_MS);
    const enabled = SIGNALS.filter(signal => sections[signal.id] !== false);

    const results = await Promise.all(enabled.map(async signal => {
        try {
            return [signal.id, await signal.query({ guildId, guildDoc, since })];
        } catch (err) {
            console.warn(`[newspaper] signal "${signal.id}" failed for guild ${guildId}: ${err.message}`);
            return [signal.id, undefined];
        }
    }));

    return Object.fromEntries(results.filter(([, value]) => value !== undefined));
}

/** Every user id the collected signals want a name for. */
function signalUserIds(data) {
    const ids = new Set();
    for (const signal of SIGNALS) {
        const value = data[signal.id];
        if (value === undefined || value === null || !signal.userIds) continue;
        for (const id of signal.userIds(value)) if (id) ids.add(id);
    }
    return [...ids];
}

/** The stats block the model is given, in the shape the prompt has always used. */
function buildDataSummary(data, context) {
    const blocks = [];
    for (const signal of SIGNALS) {
        const value = data[signal.id];
        if (value === undefined || value === null) continue;
        const text = signal.brief(value, context);
        if (text) blocks.push(text);
    }
    return blocks.join('\n\n');
}

/** The paper as it prints without a model: a heading and its lines, per signal. */
function buildSections(data, context) {
    const blocks = [];
    for (const signal of SIGNALS) {
        const value = data[signal.id];
        if (value === undefined || value === null) continue;
        const lines = signal.render(value, context);
        if (!lines?.length) continue;
        blocks.push(signal.heading ? [signal.heading, ...lines] : lines);
    }
    return blocks;
}

module.exports = { SIGNALS, collectSignals, signalUserIds, buildDataSummary, buildSections, WEEK_MS };
