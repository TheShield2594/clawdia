'use strict';

// The read model behind the public server page and player card (#1018).
//
// Everything here is deliberately kept apart from the authenticated dashboard
// data paths: these are the first unauthenticated reads the dashboard serves, so
// the one rule that matters is enforced in one place — a Discord user id (the
// snowflake, and anything that embeds it, an avatar URL included) never leaves
// this module for a member who has not run `/profile public on`. Leaderboards
// name people by their display name, which is the point of a leaderboard; the id
// that would confirm membership or join their records across servers is withheld
// unless they opted in, in which case it is already theirs to publish.

const Guild = require('../../models/Guild');
const User = require('../../models/User');
const { topByNetWorth, netWorthOf } = require('../../utils/netWorth');
const { titleForExactRank, badgeFor } = require('../../utils/prestige');
const { attachGrind } = require('../../utils/grindProfile');
const {
    getWeeklyChampionLeader,
    WEEKLY_CATEGORY_ORDER,
    WEEKLY_CATEGORY_LABELS,
} = require('../../utils/weeklyChampion');
const { MATERIAL_RARITY, TIER_STARS } = require('../../data/materialRarity');
const { ACHIEVEMENTS } = require('../../data/achievements');

const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
const MATERIAL_TRACKS = ['hunt', 'fishing', 'mining', 'exploration'];

// A vanity slug is lowercase letters, digits and single hyphens, 3–32 long, and
// never all digits — a purely numeric slug would be indistinguishable from a
// guild id in the /s/:id path and could shadow a real guild's page.
const SLUG_RE = /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;

function isValidSlug(slug) {
    return typeof slug === 'string' && slug.length >= 3 && slug.length <= 32 && SLUG_RE.test(slug);
}

/**
 * The board definitions the admin ticks on, in display order. Each knows how to
 * pull its own top ten and how a row reads.
 */
const LEADERBOARDS = [
    {
        key: 'level',
        title: 'Top Levels',
        unit: 'level',
        async top(guildId) {
            const rows = await User.find({ guildId, $or: [{ level: { $gt: 0 } }, { xp: { $gt: 0 } }] })
                .sort({ level: -1, xp: -1 })
                .limit(10)
                .select('userId level xp publicProfile.enabled')
                .lean();
            return rows.map(u => ({
                userId: u.userId,
                opted: u.publicProfile?.enabled === true,
                value: `Level ${(u.level ?? 0).toLocaleString()}`,
            }));
        },
    },
    {
        key: 'wealth',
        title: 'Wealthiest',
        unit: 'net worth',
        async top(guildId, currency) {
            const rows = await topByNetWorth(User, guildId, 10, { 'publicProfile.enabled': 1 });
            return rows
                .filter(u => netWorthOf(u) > 0)
                .map(u => ({
                    userId: u.userId,
                    opted: u.publicProfile?.enabled === true,
                    value: `${currency}${(u.netWorth ?? 0).toLocaleString()}`,
                }));
        },
    },
    {
        key: 'streak',
        title: 'Longest Active Streaks',
        unit: 'streak',
        async top(guildId) {
            const rows = await User.find({ guildId, 'streak.current': { $gt: 0 } })
                .sort({ 'streak.current': -1 })
                .limit(10)
                .select('userId streak.current publicProfile.enabled')
                .lean();
            return rows.map(u => ({
                userId: u.userId,
                opted: u.publicProfile?.enabled === true,
                value: `${(u.streak?.current ?? 0).toLocaleString()}-day streak`,
            }));
        },
    },
    {
        key: 'achievements',
        title: 'Most Achievements',
        unit: 'achievements',
        async top(guildId) {
            const rows = await User.find({ guildId, achievementsCount: { $gt: 0 } })
                .sort({ achievementsCount: -1 })
                .limit(10)
                .select('userId achievementsCount publicProfile.enabled')
                .lean();
            return rows.map(u => ({
                userId: u.userId,
                opted: u.publicProfile?.enabled === true,
                value: `${(u.achievementsCount ?? 0).toLocaleString()} achievements`,
            }));
        },
    },
];

/**
 * Find the guild whose public page is being asked for, by id or vanity slug, but
 * only when its page is switched on.
 *
 * Returns the guild settings document (lean) or null. Null is the answer for a
 * guild that does not exist, one whose page is off, and one reached by a slug it
 * does not own — the caller turns every one of those into the same 404, so the
 * URL space cannot be probed to tell them apart.
 *
 * @param {string} idOrSlug
 * @returns {Promise<object|null>}
 */
async function resolvePublicGuild(idOrSlug) {
    if (typeof idOrSlug !== 'string' || !idOrSlug) return null;

    const or = [];
    if (SNOWFLAKE_RE.test(idOrSlug)) or.push({ guildId: idOrSlug });
    if (isValidSlug(idOrSlug)) or.push({ 'publicPage.slug': idOrSlug });
    if (!or.length) return null;

    const guild = await Guild.findOne({ $or: or }).lean();
    if (!guild || guild.publicPage?.enabled !== true) return null;
    return guild;
}

/**
 * Map a set of ids to display names once, in a single Discord round trip, so a
 * page assembling four boards resolves each id at most once.
 *
 * @returns {Promise<Map<string,string>>} id -> display name; an id Discord could
 *   not resolve maps to a short generic label rather than being dropped, so a
 *   row is never blank.
 */
async function resolveNames(bot, ids) {
    const unique = [...new Set(ids)];
    const names = new Map();
    if (!unique.length) return names;
    const resolved = await bot.resolveUsers(unique).catch(() => ({}));
    for (const id of unique) {
        const card = resolved?.[id];
        names.set(id, card?.displayName || card?.username || 'Unknown member');
    }
    return names;
}

/**
 * The weekly champion race — one leader per category, named by the username the
 * competition recorded. No id is emitted: the stored username is what the
 * in-Discord footers already show, and the row is a name and a total, not a link
 * to a member.
 */
async function buildChampions(guildId) {
    const rows = await Promise.all(WEEKLY_CATEGORY_ORDER.map(async category => {
        const leader = await getWeeklyChampionLeader(guildId, category).catch(() => null);
        if (!leader) return null;
        const label = WEEKLY_CATEGORY_LABELS[category];
        return {
            category,
            title: label?.title ?? category,
            name: leader.username || 'Unknown member',
            value: `${(leader.total ?? 0).toLocaleString()} ${label?.unit ?? ''}`.trim(),
        };
    }));
    return rows.filter(Boolean);
}

/** Active district funding pools — a coin total and a goal, never a contributor id. */
function buildDistricts(guild) {
    const now = Date.now();
    return (guild.districts ?? [])
        .filter(d => d && (d.pool ?? 0) > 0)
        .sort((a, b) => (b.pool ?? 0) - (a.pool ?? 0))
        .map(d => ({
            districtId: d.districtId,
            pool: d.pool ?? 0,
            goal: d.goal ?? 0,
            active: d.activeUntil ? new Date(d.activeUntil).getTime() > now : false,
            pct: d.goal > 0 ? Math.min(100, Math.round(((d.pool ?? 0) / d.goal) * 100)) : 0,
        }));
}

/** The active seasonal event as the guild has it stored, or null. */
function buildEvent(guild) {
    const e = guild.activeEvent;
    if (!e || !e.type || !e.name) return null;
    const active = e.endsAt ? new Date(e.endsAt).getTime() > Date.now() : true;
    if (!active) return null;
    return {
        name: e.name,
        emoji: e.emoji || '✨',
        coinMultiplier: e.coinMultiplier ?? 1,
        xpMultiplier: e.xpMultiplier ?? 1,
        endsAt: e.endsAt ?? null,
    };
}

/**
 * Everything the public server page renders for an enabled guild.
 *
 * @param {object} bot   the gateway facade
 * @param {object} guild the guild settings document from resolvePublicGuild
 * @returns {Promise<object|null>} null when the bot is not in the guild (so
 *   there is no live name or icon to show), which the route answers as a 404
 */
async function buildServerPage(bot, guild) {
    const live = await bot.getGuild(guild.guildId);
    if (!live) return null;

    const cfg = guild.publicPage ?? {};
    const currency = guild.economy?.currency ?? '💰';

    // Only the boards the admin ticked, each capped at ten, assembled in parallel.
    const enabledBoards = LEADERBOARDS.filter(b => cfg.leaderboards?.[b.key] === true);
    const boardRows = await Promise.all(enabledBoards.map(b => b.top(guild.guildId, currency)));

    // Resolve every board's ids in one call, then attach names. A member who has
    // not opted in gets a name and a stat and nothing else — no id, no avatar, no
    // link — so the board cannot be read back into a list of member ids.
    const allIds = boardRows.flat().map(r => r.userId);
    const names = await resolveNames(bot, allIds);

    const boards = enabledBoards.map((b, i) => ({
        key: b.key,
        title: b.title,
        rows: boardRows[i].map((r, idx) => ({
            rank: idx + 1,
            name: names.get(r.userId) || 'Unknown member',
            value: r.value,
            // Only opted-in members are linkable, and only their id travels — it
            // is one they chose to publish.
            userId: r.opted ? r.userId : null,
        })),
    })).filter(b => b.rows.length > 0);

    const [champions, districts, event] = await Promise.all([
        cfg.showChampions ? buildChampions(guild.guildId) : Promise.resolve([]),
        Promise.resolve(cfg.showDistricts ? buildDistricts(guild) : []),
        Promise.resolve(cfg.showEvent ? buildEvent(guild) : null),
    ]);

    return {
        guild: { id: live.id, name: live.name, icon: live.icon },
        slug: cfg.slug || null,
        boards,
        champions,
        districts,
        event,
    };
}

/** Top three rarest materials the player holds, richest tier first. */
function topMaterials(user) {
    const found = [];
    for (const track of MATERIAL_TRACKS) {
        const mats = user[track]?.materials ?? {};
        for (const [key, qty] of Object.entries(mats)) {
            if (qty > 0 && MATERIAL_RARITY[key]) found.push({ key, qty, ...MATERIAL_RARITY[key] });
        }
    }
    found.sort((a, b) => b.tier - a.tier || b.qty - a.qty);
    return found.slice(0, 3).map(m => ({ label: m.label, emoji: m.emoji, stars: TIER_STARS[m.tier] || '' }));
}

/** Top three achievements the player has earned, by XP reward. */
function topAchievements(user) {
    return (user.achievements ?? [])
        .map(a => ACHIEVEMENT_BY_ID.get(a.id))
        .filter(Boolean)
        .sort((a, b) => (b.xpReward ?? 0) - (a.xpReward ?? 0))
        .slice(0, 3)
        .map(def => ({ name: def.name, emoji: def.emoji || '🏅' }));
}

/**
 * Everything the public player card renders — the same figures `/profile` and
 * `/showcase` draw, as plain data.
 *
 * The gate is upstream of the data: the card is built only for a member who has
 * opted in, so this never has to decide whether to hide a field. It answers null
 * for a member with no record or one who has not opted in, and the route turns
 * both into the same 404 as a member who is not in the guild — the URL space
 * never confirms who is a member.
 *
 * @returns {Promise<object|null>}
 */
async function buildPlayerCard(bot, guild, userId) {
    if (!SNOWFLAKE_RE.test(String(userId ?? ''))) return null;

    const user = await User.findOne({ userId, guildId: guild.guildId });
    if (!user || user.publicProfile?.enabled !== true) return null;

    await attachGrind(user);

    const currency = guild.economy?.currency ?? '💰';
    const [card] = await Promise.all([bot.resolveUsers([userId]).catch(() => ({}))]);
    const identity = card?.[userId] ?? null;

    const rank = await User.countDocuments({
        guildId: guild.guildId,
        $or: [
            { level: { $gt: user.level } },
            { level: user.level, xp: { $gt: user.xp } },
        ],
    }) + 1;

    const prestigeRank = user.accountPrestige?.rank ?? 0;

    return {
        guild: { id: guild.guildId, name: (await bot.getGuild(guild.guildId))?.name ?? 'Server', slug: guild.publicPage?.slug || null },
        // The id in the response is this member's own, published by their opt-in.
        userId: user.userId,
        // A display name and avatar the member chose to make public by opting in.
        name: identity?.displayName || identity?.username || 'Member',
        avatarUrl: identity?.avatarUrl || null,
        level: user.level ?? 0,
        rank,
        xp: user.xp ?? 0,
        requiredXp: (user.level ?? 0) * 100 + 100,
        messages: user.messages ?? 0,
        currency,
        netWorth: (user.balance ?? 0) + (user.bank ?? 0),
        streak: user.streak?.current ?? 0,
        longestStreak: user.streak?.longest ?? 0,
        prestigeTitle: prestigeRank > 0 ? titleForExactRank(prestigeRank) : null,
        prestigeBadge: prestigeRank > 0 ? badgeFor(prestigeRank) : null,
        grind: {
            hunt: user.hunt?.level ?? 1,
            fishing: user.fishing?.level ?? 1,
            mining: user.mining?.level ?? 1,
            exploration: user.exploration?.level ?? 1,
        },
        achievementsCount: user.achievementsCount ?? (user.achievements?.length ?? 0),
        topAchievements: topAchievements(user),
        topMaterials: topMaterials(user),
    };
}

module.exports = {
    SLUG_RE,
    isValidSlug,
    resolvePublicGuild,
    buildServerPage,
    buildPlayerCard,
    LEADERBOARDS,
    // Exported for the dashboard settings validator and tests.
    _internals: { buildChampions, buildDistricts, buildEvent, topMaterials, topAchievements, resolveNames },
};
