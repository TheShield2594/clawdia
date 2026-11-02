/**
 * Ambient chat events — the bot occasionally interrupts an active channel with
 * a claimable opportunity: a coin drop, a supply crate, or flash trivia.
 *
 * Pacing is per guild: an event can fire only after a preset number of
 * qualifying messages AND a cooldown since the last event, and then only with a
 * small probability per message — so active servers see a few events per hour
 * and quiet ones aren't spammed. The preset is the guild's
 * `economy.chatEventFrequency` (FREQUENCY_PRESETS below). An event is only
 * spent once the bot has confirmed it can actually post in the target channel;
 * a channel it cannot speak in does not burn the guild's cooldown on a drop
 * nobody sees.
 *
 * Admins steer it from the dashboard's Economy → Games tab: the master switch,
 * the frequency, an optional events channel every event posts in, channels
 * whose chat never counts (and where nothing lands), and a switch per kind.
 *
 * Claims are first-come-first-served. A per-event `claimed` flag settles
 * button races (single process; collector callbacks run sequentially). The
 * award goes through the same exactly-once paths as every other payout
 * (src/utils/creditOrOwe.js): keyed on the event's own message, so a retry
 * whose first attempt landed cannot pay twice, and a credit that will not land
 * is written down as owed for `npm run payouts:replay` rather than lost or
 * re-offered to the channel.
 *
 * These are buttons on a collector, so the command-level freeze gate in
 * events/interactionCreate.js never sees them — a frozen member is turned away
 * here instead, before the prize is reserved for them.
 */

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const User = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');
const { creditCoinsOrOwe, grantItemsOrOwe } = require('../utils/creditOrOwe');
const { chatEventPayoutKey } = require('../utils/payoutKey');
const { getCoinMultiplier } = require('./effectsService');
const { describeItem } = require('../utils/itemDisplay');
const { attachItemThumbnail } = require('../utils/itemImageHelper');
const { delay } = require('../utils/delay');
const { getQuestion } = require('./triviaQuestionService');
const COLORS = require('../utils/embedColors');

// How often events fire, per guild. `normal` is the pacing the feature has
// always had; the other two halve and roughly double it.
const FREQUENCY_PRESETS = Object.freeze({
    low:    Object.freeze({ minMessages: 40, minAuthors: 4, cooldownMs: 20 * 60 * 1000, chance: 0.03 }),
    normal: Object.freeze({ minMessages: 20, minAuthors: 3, cooldownMs: 10 * 60 * 1000, chance: 0.04 }),
    high:   Object.freeze({ minMessages: 10, minAuthors: 2, cooldownMs:  5 * 60 * 1000, chance: 0.06 }),
});
const MIN_MESSAGES_BETWEEN = FREQUENCY_PRESETS.normal.minMessages;
const CLAIM_WINDOW_MS      = 60_000;

// Fairness. A drop used to appear directly under the message that triggered
// it, live, so whoever happened to be typing saw it first — and one person
// spamming both earned the trigger and won it. Three things even that out:
//
//   * an author's messages count once per AUTHOR_COUNT_GAP_MS, so a burst of
//     one-word spam moves the counter no faster than steady chat;
//   * an event needs chat from at least the preset's `minAuthors` different
//     people since the last one, so one person cannot summon events alone;
//   * every event posts with its buttons locked and unlocks ARM_MS later, so
//     the whole channel gets a moment to notice it before anyone can click.
const AUTHOR_COUNT_GAP_MS = 4_000;
const ARM_MS              = 2_000;
// Bounds the per-guild author map between events. Past it, new authors still
// count toward the message total; the distinct-author bar is long since met.
const MAX_TRACKED_AUTHORS = 500;

// Which kind fires, by weight, among the kinds the guild has left on.
const EVENT_KINDS = [
    { kind: 'airdrop', setting: 'chatEventAirdropsEnabled', weight: 45 },
    { kind: 'crate',   setting: 'chatEventCratesEnabled',   weight: 30 },
    { kind: 'trivia',  setting: 'chatEventTriviaEnabled',   weight: 25 },
];

const AIRDROP_MIN = 500;
const AIRDROP_MAX = 2_000;

// Coin-drop variants, for variety. Rolled high so a plain drop stays the
// common case: 80% standard, 15% split, 5% golden.
//
//   golden  the same drop at GOLDEN_MULTIPLIER the coins
//   split   a bigger pot shared equally by the first SPLIT_SHARES grabbers,
//           one share each — a drop more than one person walks away from
const GOLDEN_CHANCE     = 0.05;
const SPLIT_CHANCE      = 0.15;
const GOLDEN_MULTIPLIER = 3;
const SPLIT_SHARES      = 3;
const SPLIT_POT_MIN     = 1_500;
const SPLIT_POT_MAX     = 4_500;

// Each variant's own colour — feature identities, not outcome roles (see
// src/utils/embedColors.js). The golden drop wears PRIZE gold.
const DROP_COLOR  = '#4fc3f7';
const SPLIT_COLOR = '#1abc9c';
const TRIVIA_REWARD = 1_000;

// How long the crate sits on "cracking it open…" before the reveal. Long
// enough to read as a beat, short enough not to feel like lag.
const CRATE_REVEAL_BEAT_MS = 1_200;

// The supply crate's own colour — a feature identity, not an outcome role
// (see src/utils/embedColors.js), so it lives here.
const CRATE_COLOR = '#e67e22';

// Weighted item table for supply crates (itemIds from defaultShopItems)
const CRATE_ITEMS = [
    { itemId: 'lucky_charm',     name: 'Lucky Charm',     emoji: '🍀', weight: 30 },
    { itemId: 'xp_booster_2x',   name: '2x XP Booster',   emoji: '⭐', weight: 25 },
    { itemId: 'coin_booster_2x', name: '2x Coin Booster', emoji: '💰', weight: 25 },
    { itemId: 'lucky_streak',    name: 'Lucky Streak',    emoji: '🎯', weight: 15 },
    { itemId: 'lifesaver',       name: 'Lifesaver',       emoji: '🛟', weight: 5 },
];

const FROZEN_CLAIM_NOTICE =
    '🧊 Your economy access is frozen in this server, so you can\'t claim drops. '
    + 'A server admin can lift it from the dashboard.';
const CLAIM_ERROR_NOTICE = '⚠️ Something went wrong reaching your account — try again!';

const guildState = new Map(); // guildId -> { lastEventAt, messagesSince, authors: Map(userId -> lastCountedAt) }

// One entry per guild the process has ever seen a message in, with nothing to
// remove it — the bot leaving a guild does not, and there is no TTL because a
// quiet guild's message count is meant to survive between events. Capped FIFO,
// the same rule guildSettingsCache and BoundedRateLimiter use. Eviction costs
// the evicted guild its progress toward the next event, so it waits another
// MIN_MESSAGES_BETWEEN messages; nothing fires early and no money moves.
const MAX_TRACKED_GUILDS = 5_000;

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Fisher–Yates: `.sort(() => Math.random() - 0.5)` is not a uniform shuffle,
// so the correct answer was not equally likely to land in each button slot.
function shuffle(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function weightedPick(items) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let roll = Math.random() * total;
    for (const item of items) {
        roll -= item.weight;
        if (roll <= 0) return item;
    }
    return items[items.length - 1];
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Whether the bot can post an event in `channel` — see it, speak in it (the
 * thread flavour of that permission inside a thread) and embed. Anything it
 * cannot read is a no.
 */
function botCanPost(channel, guild) {
    const me = guild?.members?.me;
    const perms = me ? channel?.permissionsFor?.(me) : null;
    if (!perms) return false;
    const speak = channel.isThread?.()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
    return perms.has([PermissionFlagsBits.ViewChannel, speak, PermissionFlagsBits.EmbedLinks]);
}

function botCanAttach(channel, guild) {
    const me = guild?.members?.me;
    return Boolean(me && channel?.permissionsFor?.(me)?.has(PermissionFlagsBits.AttachFiles));
}

/** Discord relative timestamp for the moment the claim window closes. */
function expiryStamp(armedAt) {
    return `<t:${Math.floor((armedAt + CLAIM_WINDOW_MS) / 1000)}:R>`;
}

/**
 * Posts an event with its buttons locked, and unlocks them ARM_MS later.
 *
 * `render(armedAt)` builds the message: `armedAt` is null for the locked
 * version and the unlock time for the live one, which is also when the claim
 * window starts — so the countdown and the reaction times are measured from
 * the moment anyone could click, not from when the post appeared.
 *
 * The collector starts with the post (a locked button cannot be clicked) and
 * runs for the arming beat plus the claim window.
 */
async function postArmed(channel, render, filter) {
    const sent = await channel.send(render(null));
    const collector = sent.createMessageComponentCollector({ filter, time: ARM_MS + CLAIM_WINDOW_MS });
    const timing = { armedAt: null };
    await delay(ARM_MS);
    timing.armedAt = Date.now();
    await sent.edit(render(timing.armedAt)).catch(() => {});
    return { sent, collector, timing };
}

/** How long after the unlock a click came, for the winner card. */
function reactionTime(timing, clickedAt) {
    return seconds(clickedAt - (timing.armedAt ?? clickedAt));
}

/** The closing line of a live or locked event. */
function countdownLine(armedAt, verb = 'Gone') {
    return armedAt == null ? '🔒 Unlocks in a moment…' : `⏳ ${verb} ${expiryStamp(armedAt)}`;
}

function seconds(ms) {
    return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function displayName(i) {
    return i.member?.displayName ?? i.user.globalName ?? i.user.username;
}

/**
 * The claimant's freeze flag, balance and active effects — what the claim has
 * to know before it reserves anything. A member with no document yet gets an
 * empty one, because the keyed credits deliberately do not upsert (a missing
 * document would read as an owed payout, not a win). Throws when the database
 * cannot be read; the caller releases the reservation.
 */
async function loadClaimant(filter) {
    const snapshot = await User.findOne(filter, { economyFrozen: 1, balance: 1, activeEffects: 1 }).lean();
    if (snapshot) return snapshot;
    try {
        await User.updateOne(filter, { $setOnInsert: filter }, { upsert: true });
    } catch (err) {
        // Someone else created it in between — that is all this wanted.
        if (err?.code !== 11000) throw err;
    }
    return (await User.findOne(filter, { economyFrozen: 1, balance: 1, activeEffects: 1 }).lean())
        ?? { balance: 0, activeEffects: [] };
}

/**
 * Pays a coin prize, doubled by an active 2x Coin Booster — whose description
 * promises "2x coin earnings from everything but the casino".
 */
async function payCoinPrize({ filter, base, snapshot, kind, eventMessageId, note }) {
    // getCoinMultiplier prunes `activeEffects` in place, so hand it a copy.
    const multiplier = getCoinMultiplier({ activeEffects: [...(snapshot.activeEffects ?? [])] });
    const amount = Math.floor(base * multiplier);

    const { credited, doc } = await creditCoinsOrOwe(filter, amount, {
        payoutKey: chatEventPayoutKey(kind, eventMessageId),
        service:   'chatEventService',
        jobName:   kind,
    });

    if (credited) {
        logTransaction({
            ...filter, type: 'chat_event', amount,
            balance: doc?.balance ?? (snapshot.balance ?? 0) + amount, note,
        });
    }
    return { credited, amount, boosted: multiplier > 1 };
}

/** The coin line of a winner card, showing the booster when it applied. */
function coinPrizeLine(currency, base, { amount, boosted }) {
    return boosted
        ? `${currency} **+${amount.toLocaleString()}** · 🚀 Coin Booster doubled it from ${base.toLocaleString()}`
        : `${currency} **+${amount.toLocaleString()}**`;
}

const OWED_LINE =
    '⏳ The payout hit a snag on our end. It has been recorded and will be delivered — nothing is lost.';

/** Resolves the winner's interaction, falling back to the message itself. */
function finish(i, sent, payload) {
    return i.editReply(payload).catch(() => sent.edit(payload)).catch(() => {});
}

/** The pacing preset for a guild, falling back to `normal` for anything unknown. */
function frequencyFor(economy) {
    return FREQUENCY_PRESETS[economy?.chatEventFrequency] ?? FREQUENCY_PRESETS.normal;
}

/** The event kinds this guild has switched on. Unset means on. */
function enabledKinds(economy) {
    return EVENT_KINDS.filter(k => economy?.[k.setting] !== false);
}

/**
 * Whether `channel` is one the guild excluded. A thread is judged by its
 * parent, so excluding a forum or a channel covers the threads under it.
 */
function isExcluded(channel, economy) {
    const excluded = economy?.chatEventExcludedChannelIds;
    if (!Array.isArray(excluded) || excluded.length === 0 || !channel) return false;
    return excluded.includes(channel.id) || (channel.parentId != null && excluded.includes(channel.parentId));
}

/**
 * Where an event earned by chat in `channel` should land: the guild's events
 * channel when it has one, otherwise the channel itself. Null when the
 * configured events channel is gone, is not a text channel, or is excluded —
 * an admin who picked a channel meant "only there", so the event waits rather
 * than landing somewhere they did not choose.
 */
function eventTarget(message, economy) {
    const id = economy?.chatEventChannelId;
    if (!id) return message.channel;
    const channel = message.guild.channels?.cache?.get(id) ?? null;
    if (!channel?.isTextBased?.() || isExcluded(channel, economy)) return null;
    return channel;
}

const SPAWNERS = {
    airdrop: (...args) => spawnAirdrop(...args),
    crate:   (...args) => spawnCrate(...args),
    trivia:  (...args) => spawnTrivia(...args),
};

/**
 * Called from messageCreate for every non-bot guild message. Cheap unless an
 * event actually fires. Never throws.
 */
async function maybeTriggerChatEvent(message, guildSettings) {
    try {
        const economy = guildSettings?.economy;
        if (economy?.enabled === false) return;
        if (economy?.chatEventsEnabled === false) return;
        if (!message.guild || !message.channel?.isTextBased?.()) return;
        // Chat in an excluded channel doesn't count toward anything.
        if (isExcluded(message.channel, economy)) return;
        const kinds = enabledKinds(economy);
        if (kinds.length === 0) return;

        const guildId = message.guild.id;
        let state = guildState.get(guildId);
        if (!state) {
            if (guildState.size >= MAX_TRACKED_GUILDS) {
                guildState.delete(guildState.keys().next().value);
            }
            state = { lastEventAt: 0, messagesSince: 0, authors: new Map() };
            guildState.set(guildId, state);
        }

        // One author's burst counts once per gap; see AUTHOR_COUNT_GAP_MS.
        const now = Date.now();
        const authorId = message.author?.id ?? null;
        if (authorId) {
            const last = state.authors.get(authorId);
            if (last != null && now - last < AUTHOR_COUNT_GAP_MS) return;
            if (last != null || state.authors.size < MAX_TRACKED_AUTHORS) state.authors.set(authorId, now);
        }

        const pace = frequencyFor(economy);
        state.messagesSince += 1;
        if (state.messagesSince < pace.minMessages) return;
        if (state.authors.size < pace.minAuthors) return;
        if (Date.now() - state.lastEventAt < pace.cooldownMs) return;
        if (Math.random() >= pace.chance) return;
        // Checked last so the cheap counters still short-circuit the common
        // case, and before the cooldown is spent so a channel the bot cannot
        // speak in does not cost the guild its next event.
        const channel = eventTarget(message, economy);
        if (!channel || !botCanPost(channel, message.guild)) return;

        state.lastEventAt   = Date.now();
        state.messagesSince = 0;
        state.authors.clear();

        // The spawners read the id (for button ids), the guild and the channel
        // to post in — which is the events channel when one is set.
        const target = { id: message.id, guild: message.guild, channel };
        const { kind } = weightedPick(kinds);
        await SPAWNERS[kind](target, guildSettings);
    } catch (err) {
        console.error('[chatEvent] error:', err);
    }
}

// ── Coin drop ─────────────────────────────────────────────────────────────────

/** standard | golden | split — rolled high so 0 is the plain drop. */
function rollDropVariant() {
    const roll = Math.random();
    if (roll >= 1 - GOLDEN_CHANCE) return 'golden';
    if (roll >= 1 - GOLDEN_CHANCE - SPLIT_CHANCE) return 'split';
    return 'standard';
}

async function spawnAirdrop(message, guildSettings, variant = rollDropVariant()) {
    if (variant === 'split') return spawnSplitDrop(message, guildSettings);

    const currency = guildSettings?.economy?.currency ?? '💰';
    const golden   = variant === 'golden';
    const base     = randInt(AIRDROP_MIN, AIRDROP_MAX) * (golden ? GOLDEN_MULTIPLIER : 1);
    const claimId  = `chatev_air_${message.id}`;
    const title    = golden ? '🌟 A GOLDEN coin drop!' : '🪂 Coin drop incoming!';

    const render = armedAt => ({
        embeds: [new EmbedBuilder()
            .setColor(golden ? COLORS.PRIZE : DROP_COLOR)
            .setTitle(title)
            .setDescription(
                (golden
                    ? `A shimmering parachute of **${currency}${base.toLocaleString()}** is drifting down — `
                      + `${GOLDEN_MULTIPLIER}× the usual haul!\n`
                    : `A parachute of **${currency}${base.toLocaleString()}** is drifting down.\n`)
                + 'First to grab it keeps it!\n\n'
                + countdownLine(armedAt),
            )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(claimId).setLabel('Grab it!').setEmoji(golden ? '🌟' : '🪂')
                .setStyle(ButtonStyle.Success).setDisabled(armedAt == null),
        )],
    });

    const { sent, collector, timing } = await postArmed(
        message.channel, render, i => i.customId === claimId && !i.user.bot,
    );
    let claimed = false;

    collector.on('collect', async i => {
        if (claimed) {
            return i.reply({ content: '💨 Too slow — someone got there first!', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        // Reserve before the first await so interleaved clicks can't double-claim.
        claimed = true;
        const clickedAt = Date.now();
        const filter = { userId: i.user.id, guildId: message.guild.id };

        let snapshot;
        try {
            snapshot = await loadClaimant(filter);
        } catch (err) {
            claimed = false; // release the reservation — the drop is still up for grabs
            console.error('[chatEvent] airdrop claimant read failed:', err);
            return i.reply({ content: CLAIM_ERROR_NOTICE, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        if (snapshot.economyFrozen) {
            claimed = false;
            return i.reply({ content: FROZEN_CLAIM_NOTICE, flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        // The prize is theirs from here: a credit that will not land is owed,
        // never handed back to the channel, so the collector can stop now.
        collector.stop('claimed');
        await i.deferUpdate().catch(() => {});

        const prize = await payCoinPrize({
            filter, base, snapshot, kind: 'airdrop', eventMessageId: sent.id,
            note: golden ? 'Golden coin drop claim' : 'Coin drop claim',
        });

        const lines = [
            `**${displayName(i)}** snatched it in **${reactionTime(timing, clickedAt)}**! 💨`,
            '',
            prize.credited ? coinPrizeLine(currency, base, prize) : OWED_LINE,
        ];
        await finish(i, sent, {
            embeds: [new EmbedBuilder()
                .setColor(prize.credited ? (golden ? COLORS.PRIZE : COLORS.SUCCESS) : COLORS.WARN)
                .setTitle(golden ? '🌟 Golden coin drop claimed!' : '🪂 Coin drop claimed!')
                .setDescription(lines.join('\n'))
                .setFooter({ text: 'Keep chatting — more drops are on the way.' })],
            components: [],
        });
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'claimed') {
            sent.edit({
                embeds: [new EmbedBuilder()
                    .setColor(COLORS.NEUTRAL)
                    .setTitle(golden ? '🌟 The golden drop drifted away…' : '🪂 The coin drop drifted away…')
                    .setDescription(`Nobody grabbed the **${currency}${base.toLocaleString()}** in time.`)
                    .setFooter({ text: 'Stay alert for the next one!' })],
                components: [],
            }).catch(() => {});
        }
    });
}

// ── Split drop (a coin-drop variant) ──────────────────────────────────────────

/**
 * A bigger pot, shared equally by the first SPLIT_SHARES members to grab it.
 * Each share is its own keyed credit — the key names the drop and lives on
 * each winner's document, so it guards each member's share separately.
 *
 * Every render reads the live state and goes through one chain, so two claims
 * landing together cannot leave an older card on top of a newer one.
 */
async function spawnSplitDrop(message, guildSettings) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    const pot      = randInt(SPLIT_POT_MIN, SPLIT_POT_MAX);
    const share    = Math.floor(pot / SPLIT_SHARES);
    const claimId  = `chatev_split_${message.id}`;

    const winners  = [];          // { name, prize, time } in claim order
    const inFlight = new Set();   // user ids whose claim is being paid
    const done     = new Set();   // user ids already holding a share
    let closed     = false;

    const sharesLeft = () => SPLIT_SHARES - winners.length - inFlight.size;
    const winnerLines = () => winners.map((w, n) =>
        `${['🥇', '🥈', '🥉'][n] ?? '🎁'} **${w.name}** · ${w.time} · `
        + (w.prize.credited ? coinPrizeLine(currency, share, w.prize) : '⏳ payout recorded, delivery pending'));

    const render = armedAt => ({
        embeds: [new EmbedBuilder()
            .setColor(SPLIT_COLOR)
            .setTitle('🎁 A split drop is coming down!')
            .setDescription([
                `**${currency}${pot.toLocaleString()}** split ${SPLIT_SHARES} ways — `
                + `the first ${SPLIT_SHARES} to grab it get **${currency}${share.toLocaleString()}** each.`,
                '',
                ...(winners.length ? [...winnerLines(), ''] : []),
                `**${Math.max(0, SPLIT_SHARES - winners.length)}** of ${SPLIT_SHARES} shares left · ${countdownLine(armedAt)}`,
            ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(claimId).setLabel('Grab a share!').setEmoji('🎁')
                .setStyle(ButtonStyle.Success).setDisabled(armedAt == null),
        )],
    });

    const { sent, collector, timing } = await postArmed(
        message.channel, render, i => i.customId === claimId && !i.user.bot,
    );

    let chain = Promise.resolve();
    const rerender = () => {
        chain = chain.then(() => sent.edit(closed ? closedCard() : render(timing.armedAt))).catch(() => {});
        return chain;
    };
    const closedCard = () => ({
        embeds: [new EmbedBuilder()
            .setColor(winners.length ? COLORS.SUCCESS : COLORS.NEUTRAL)
            .setTitle(winners.length === SPLIT_SHARES
                ? '🎁 Split drop shared out!'
                : winners.length ? '🎁 Split drop over' : '🎁 The split drop drifted away…')
            .setDescription(winners.length
                ? [...winnerLines(), '',
                    winners.length < SPLIT_SHARES
                        ? `-# ${SPLIT_SHARES - winners.length} unclaimed share${SPLIT_SHARES - winners.length === 1 ? '' : 's'} drifted away.`
                        : `-# ${currency}${pot.toLocaleString()} shared ${SPLIT_SHARES} ways.`,
                ].join('\n')
                : `Nobody grabbed a share of the **${currency}${pot.toLocaleString()}** in time.`)
            .setFooter({ text: 'Keep chatting — more drops are on the way.' })],
        components: [],
    });

    collector.on('collect', async i => {
        if (done.has(i.user.id) || inFlight.has(i.user.id)) {
            return i.reply({ content: '🎁 You already grabbed a share — leave some for the others!', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        if (closed || sharesLeft() <= 0) {
            return i.reply({ content: '💨 Too slow — every share is taken!', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        // Reserve a share before the first await.
        inFlight.add(i.user.id);
        const clickedAt = Date.now();
        const filter = { userId: i.user.id, guildId: message.guild.id };

        let snapshot;
        try {
            snapshot = await loadClaimant(filter);
        } catch (err) {
            inFlight.delete(i.user.id);
            console.error('[chatEvent] split drop claimant read failed:', err);
            return i.reply({ content: CLAIM_ERROR_NOTICE, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        if (snapshot.economyFrozen) {
            inFlight.delete(i.user.id);
            return i.reply({ content: FROZEN_CLAIM_NOTICE, flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        await i.deferUpdate().catch(() => {});
        const prize = await payCoinPrize({
            filter, base: share, snapshot, kind: 'split', eventMessageId: sent.id, note: 'Split drop share',
        });

        inFlight.delete(i.user.id);
        done.add(i.user.id);
        winners.push({ name: displayName(i), prize, time: reactionTime(timing, clickedAt) });

        if (winners.length >= SPLIT_SHARES) {
            closed = true;
            collector.stop('claimed');
        }
        await rerender();
    });

    collector.on('end', () => {
        closed = true;
        rerender();
    });
}

// ── Supply crate (item drop) ─────────────────────────────────────────────────

async function spawnCrate(message, guildSettings) {
    const currency  = guildSettings?.economy?.currency ?? '💰';
    const item      = weightedPick(CRATE_ITEMS);
    const claimId   = `chatev_crate_${message.id}`;

    const render = armedAt => ({
        embeds: [new EmbedBuilder()
            .setColor(CRATE_COLOR)
            .setTitle('📦 A supply crate crash-lands!')
            .setDescription(
                'Something rattles inside…\n'
                + 'First to crack it open keeps the loot!\n\n'
                + '-# Could be anything from a 🍀 Lucky Charm to a rare 🛟 Lifesaver.\n'
                + countdownLine(armedAt),
            )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(claimId).setLabel('Crack it open').setEmoji('📦')
                .setStyle(ButtonStyle.Primary).setDisabled(armedAt == null),
        )],
    });

    const { sent, collector, timing } = await postArmed(
        message.channel, render, i => i.customId === claimId && !i.user.bot,
    );
    let claimed = false;

    collector.on('collect', async i => {
        if (claimed) {
            return i.reply({ content: '💨 Too slow — the crate is already open!', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        // Reserve before the first await so interleaved clicks can't double-claim.
        claimed = true;
        const clickedAt = Date.now();
        const filter = { userId: i.user.id, guildId: message.guild.id };
        const name = displayName(i);

        let snapshot;
        try {
            snapshot = await loadClaimant(filter);
        } catch (err) {
            claimed = false;
            console.error('[chatEvent] crate claimant read failed:', err);
            return i.reply({ content: CLAIM_ERROR_NOTICE, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        if (snapshot.economyFrozen) {
            claimed = false;
            return i.reply({ content: FROZEN_CLAIM_NOTICE, flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        collector.stop('claimed');
        // The beat before the reveal: the button goes, the lid comes off.
        const beatStarted = Date.now();
        await i.update({
            embeds: [new EmbedBuilder()
                .setColor(CRATE_COLOR)
                .setTitle('📦 Cracking it open…')
                .setDescription(`**${name}** pries the lid off… 🔧`)],
            components: [],
        }).catch(() => {});

        const { granted, doc } = await grantItemsOrOwe(filter, item.itemId, 1, {
            payoutKey: chatEventPayoutKey('crate', sent.id),
            service:   'chatEventService',
            jobName:   'crate',
            upsert:    true,
        });
        if (granted) {
            // Items don't move the wallet, so the ledger row carries the
            // balance as it stands — not a fabricated zero.
            logTransaction({
                ...filter, type: 'chat_event', amount: 0,
                balance: doc?.balance ?? snapshot.balance ?? 0, note: `Crate drop: ${item.itemId}`,
            });
        }

        const info = describeItem(item.itemId, { shopItems: guildSettings?.shop ?? [] });
        const reveal = new EmbedBuilder()
            .setColor(granted ? (info.color ?? COLORS.SUCCESS) : COLORS.WARN)
            .setTitle('📦 Crate cracked open!')
            .setDescription([
                `**${name}** found ${item.emoji} **${info.name ?? item.name}** inside!`,
                info.lore ? `-# *${info.lore}*` : null,
                '',
                granted ? 'Activate it with `/use`.' : OWED_LINE,
            ].filter(line => line !== null).join('\n'))
            .addFields(
                { name: 'Rarity', value: `${info.rarityEmoji ?? ''} ${info.rarity ?? 'Unknown'}`.trim(), inline: true },
                ...(info.value > 0 ? [{ name: 'Shop value', value: `${currency}${info.value.toLocaleString()}`, inline: true }] : []),
                { name: 'Opened in', value: reactionTime(timing, clickedAt), inline: true },
            )
            .setFooter({ text: 'Keep chatting — more crates are on the way.' });
        const files = botCanAttach(message.channel, message.guild)
            ? await attachItemThumbnail(reveal, item.itemId, message.guild.id, info.name ?? item.name)
            : [];

        const wait = CRATE_REVEAL_BEAT_MS - (Date.now() - beatStarted);
        if (wait > 0) await delay(wait);
        await finish(i, sent, { embeds: [reveal], components: [], files });
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'claimed') {
            sent.edit({
                embeds: [new EmbedBuilder()
                    .setColor(COLORS.NEUTRAL)
                    .setTitle('📦 The crate crumbled to dust…')
                    .setDescription('Nobody opened it in time.')
                    .setFooter({ text: 'Stay alert for the next one!' })],
                components: [],
            }).catch(() => {});
        }
    });
}

// ── Flash trivia ──────────────────────────────────────────────────────────────

/** The answer buttons, disabled, with the right one lit — for a closed round. */
function revealedAnswerRow(baseId, answers, correct) {
    return new ActionRowBuilder().addComponents(
        answers.map((ans, idx) => {
            const button = new ButtonBuilder()
                .setCustomId(`${baseId}_${idx}`)
                .setLabel(String(ans).slice(0, 80))
                .setStyle(ans === correct ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(true);
            if (ans === correct) button.setEmoji('✅');
            return button;
        })
    );
}

async function spawnTrivia(message, guildSettings) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    // Same no-repeat deck /quiz deals from: OpenTDB under a session token,
    // with the offline bank behind it. Medium and hard only — the reward is a
    // flat 1,000 coins, so easy questions would be a giveaway.
    const difficulty = Math.random() < 0.5 ? 'medium' : 'hard';
    const q         = await getQuestion(difficulty);
    const answers   = shuffle([q.correct_answer, ...q.incorrect_answers]);
    const baseId    = `chatev_triv_${message.id}`;

    // While locked, the question is up and the answers are not: the beat is
    // reading time for everyone, not just whoever was already looking.
    const render = armedAt => ({
        embeds: [new EmbedBuilder()
            .setColor(COLORS.RARE)
            .setTitle('⚡ Flash Trivia!')
            .setDescription(
                `**${q.question}**\n\n`
                + `First correct answer wins **${currency}${TRIVIA_REWARD.toLocaleString()}**. One guess each!\n\n`
                + (armedAt == null ? '🔒 Read up — answers unlock in a moment…' : countdownLine(armedAt, 'Closes')),
            )
            .setFooter({ text: [q.category, difficulty].filter(Boolean).join(' · ') })],
        components: [new ActionRowBuilder().addComponents(
            answers.map((ans, idx) =>
                new ButtonBuilder()
                    .setCustomId(`${baseId}_${idx}`)
                    .setLabel(String(ans).slice(0, 80))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(armedAt == null)
            )
        )],
    });

    const { sent, collector, timing } = await postArmed(
        message.channel, render, i => i.customId.startsWith(baseId) && !i.user.bot,
    );
    let solved = false;
    const attempted = new Set();
    let wrongGuesses = 0;

    collector.on('collect', async i => {
        if (solved) {
            return i.reply({ content: '💨 Too slow — already answered!', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        if (attempted.has(i.user.id)) {
            return i.reply({ content: 'You already used your guess!', flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const idx     = Number(i.customId.slice(baseId.length + 1));
        const correct = answers[idx] === q.correct_answer;

        if (!correct) {
            attempted.add(i.user.id);
            wrongGuesses += 1;
            return i.reply({ content: `❌ Not **${answers[idx]}** — better luck next time!`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        // Reserve before the first await so a second correct click can't double-claim.
        solved = true;
        const clickedAt = Date.now();
        const filter = { userId: i.user.id, guildId: message.guild.id };

        let snapshot;
        try {
            snapshot = await loadClaimant(filter);
        } catch (err) {
            solved = false; // their guess is not spent — let them answer again
            console.error('[chatEvent] trivia claimant read failed:', err);
            return i.reply({ content: '⚠️ Something went wrong with the reward — answer again!', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        if (snapshot.economyFrozen) {
            solved = false;
            attempted.add(i.user.id);
            return i.reply({ content: FROZEN_CLAIM_NOTICE, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        attempted.add(i.user.id);

        collector.stop('solved');
        await i.deferUpdate().catch(() => {});

        const prize = await payCoinPrize({
            filter, base: TRIVIA_REWARD, snapshot, kind: 'trivia', eventMessageId: sent.id, note: 'Flash trivia win',
        });

        const lines = [
            `**${q.question}**`,
            '',
            `**${displayName(i)}** nailed it in **${reactionTime(timing, clickedAt)}** — **${q.correct_answer}**! 🧠`,
            wrongGuesses > 0 ? `-# ${wrongGuesses} wrong guess${wrongGuesses === 1 ? '' : 'es'} before them.` : null,
            '',
            prize.credited ? coinPrizeLine(currency, TRIVIA_REWARD, prize) : OWED_LINE,
        ].filter(line => line !== null);

        await finish(i, sent, {
            embeds: [new EmbedBuilder()
                .setColor(prize.credited ? COLORS.SUCCESS : COLORS.WARN)
                .setTitle('⚡ Trivia solved!')
                .setDescription(lines.join('\n'))
                .setFooter({ text: 'Keep chatting — more trivia is on the way.' })],
            components: [revealedAnswerRow(baseId, answers, q.correct_answer)],
        });
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'solved') {
            const tried = wrongGuesses > 0
                ? ` ${wrongGuesses} wrong guess${wrongGuesses === 1 ? '' : 'es'}.`
                : '';
            sent.edit({
                embeds: [new EmbedBuilder()
                    .setColor(COLORS.NEUTRAL)
                    .setTitle('⚡ Trivia expired…')
                    .setDescription(`**${q.question}**\n\nNobody got it.${tried} The answer was **${q.correct_answer}**.`)
                    .setFooter({ text: 'Stay sharp for the next one!' })],
                components: [revealedAnswerRow(baseId, answers, q.correct_answer)],
            }).catch(() => {});
        }
    });
}

module.exports = {
    maybeTriggerChatEvent,
    __test__: {
        guildState, MAX_TRACKED_GUILDS, MIN_MESSAGES_BETWEEN, CRATE_ITEMS, FREQUENCY_PRESETS,
        AUTHOR_COUNT_GAP_MS, SPLIT_SHARES, GOLDEN_MULTIPLIER, rollDropVariant,
        spawnAirdrop, spawnSplitDrop, spawnCrate, spawnTrivia, botCanPost, isExcluded, eventTarget, enabledKinds,
    },
};
