const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { placeWager } = require('../../utils/placeWager');
const { confirmBet, confirmThreshold } = require('../../utils/confirmBet');
const { casinoRefusal, replayRefusal, refuseReplay } = require('./betGuard');
const { casinoLuck } = require('../../services/effectsService');
const { randomFrom, SLOTS_LOSE_LINES, SLOTS_WIN_LINES, SLOTS_BIG_WIN_LINES } = require('../../utils/copyLines');
const {
    claimJackpot,
    DEFAULT_SEED: JACKPOT_SEED,
    RANDOM_DROP_RETURN,
} = require('../../services/casinoJackpotService');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
const { delay } = require('../../utils/delay');
const { newHandId, payHand, payoutNote, settledBalance } = require('./payout');
const {
    SYMBOLS,
    HEAT_MAX,
    TRIPLE_WILD_MULT,
    TRIPLE_BOOST_MULT,
    FREE_SPINS,
    LUCKY_CHARM_RESPIN,
    LUCKY_STREAK_REFUND,
    PROGRESSIVE_RETURN,
    JACKPOT_CAP_MULT,
    spin,
    fillerEmoji,
    evaluate,
    isNetLoss,
    odds,
} = require('./slotsReels');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b0.png';

const MIN_BET = 10;
const MAX_BET = 1_000_000_000;

// The reveal. Each reel stops on its own frame; the last one holds longer when
// the first two have set something up (see `teaseFor`).
const FRAME_MS      = 700;
const TEASE_MS      = 1_500;
const CHARM_MS      = 1_200;
const FREE_INTRO_MS = 1_500;
const FREE_SPIN_MS  = 700;

// A win this many times the stake or more is announced in the guild's
// announcement channel, when it has one.
const WIN_ANNOUNCE_MULT = 50;

const REPLAY_WINDOW_MS = 120_000;

// Slots' own colours. The outcome roles come from embedColors; the rest are
// this machine's identity and live here.
const PALETTE = {
    spin:    '#6c5ce7',
    tease:   COLORS.PRIZE,
    lose:    '#4f545c',
    push:    COLORS.NEUTRAL,
    win:     COLORS.SUCCESS,
    big:     '#f5a623',
    mega:    '#ff6b3d',
    epic:    '#e0218a',
    jackpot: '#d63cff',
    free:    '#ff8fc7',
    error:   COLORS.ERROR,
};

// Win tiers, by what the whole spin returned as a multiple of the stake.
const TIERS = [
    { min: 50, key: 'epic', title: '💥 EPIC WIN 💥' },
    { min: 25, key: 'mega', title: '🔥 MEGA WIN 🔥' },
    { min: 10, key: 'big',  title: '✨ BIG WIN ✨' },
];

// ─── Rendering ────────────────────────────────────────────────────────────────

const fmt = n => Math.round(n).toLocaleString();
const signed = n => (n >= 0 ? `+${fmt(n)}` : `−${fmt(Math.abs(n))}`);

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

/**
 * The 3×3 window, payline in the middle. Reels at or past `revealed` are still
 * spinning and show filler; every stopped cell is what the strip really holds.
 */
function gridText(window, revealed = 3) {
    return window.map((row, r) => {
        const cells = row.map((s, reel) => (reel < revealed ? s.emoji : fillerEmoji())).join(' ');
        return r === 1 ? `▶️ ${cells} ◀️` : `▪️ ${cells} ▪️`;
    }).join('\n');
}

function heatText(heat, hot) {
    if (hot) return '🔥 **HOT SPIN**';
    const filled = Math.min(heat, HEAT_MAX);
    return `${'▰'.repeat(filled)}${'▱'.repeat(HEAT_MAX - filled)} ${filled}/${HEAT_MAX}`;
}

function sessionText(session) {
    if (!session.spins) return 'First spin of the session';
    const net = session.returned - session.wagered;
    return `Session · ${session.spins} spin${session.spins === 1 ? '' : 's'} · ` +
        `wagered ${fmt(session.wagered)} · net ${signed(net)}`;
}

/**
 * What the last reel is holding its breath for, once the first two have
 * stopped — or null, and it stops on the ordinary beat. Reads only the two
 * stopped reels: the tease is about what *could* land, and it never lies about
 * what already has.
 */
function teaseFor(window) {
    const [a, b] = window[1];
    const wild = s => s.type === 'wild';
    if (wild(a) && wild(b)) return '🃏🃏 **One more Wild for the jackpot…**';
    const scatters = window.flatMap(row => row.slice(0, 2)).filter(s => s.type === 'scatter').length;
    if (scatters >= 2) return '🌸🌸 **Free spins locked in — one more Scatter for 15…**';
    const top = s => s.name === 'Diamond' || s.name === 'Star';
    if ((top(a) || wild(a)) && (top(b) || wild(b)) && (a === b || wild(a) || wild(b))) {
        return `${a.emoji}${b.emoji} **Last reel…**`;
    }
    return null;
}

function statusFields(ctx) {
    return [
        { name: '💸 Bet',         value: `**${fmt(ctx.bet)}**`,      inline: true },
        { name: '🔥 Heat',        value: heatText(ctx.heat, ctx.hot), inline: true },
        { name: '🏦 Progressive', value: `**${fmt(ctx.pool)}**`,     inline: true },
    ];
}

function frameEmbed(ctx, window, { revealed, status, color = PALETTE.spin }) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(ctx.interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🎰 Slots')
        .setDescription(`${status}\n\n${gridText(window, revealed)}`)
        .addFields(statusFields(ctx))
        .setFooter({ text: sessionText(ctx.session) });
}

/** Plays one set of reels to a stop, reel by reel. A Hot Spin's first reel starts stopped. */
async function reveal(surface, ctx, view) {
    const first = ctx.hot ? 1 : 0;
    const lead  = ctx.hot ? '🔥 **Hot Spin!** Reel 1 locked.' : '🎰 **Spinning…**';
    for (let revealed = first; revealed < 3; revealed++) {
        const tease = revealed === 2 ? teaseFor(view.window) : null;
        await surface.edit({
            embeds: [frameEmbed(ctx, view.window, {
                revealed,
                status: tease ?? lead,
                color: tease ? PALETTE.tease : PALETTE.spin,
            })],
            components: [],
        });
        await delay(tease ? TEASE_MS : FRAME_MS);
    }
}

function tierFor(total, bet, jackpotWon) {
    if (jackpotWon) return { key: 'jackpot', title: '🎰 ✨ J A C K P O T ✨ 🎰' };
    const mult = total / bet;
    const tier = TIERS.find(t => mult >= t.min);
    if (tier) return tier;
    if (total > bet)   return { key: 'win',  title: '🎰 Win!' };
    if (total === bet) return { key: 'push', title: '🎰 Money Back' };
    return { key: 'lose', title: '🎰 No Win' };
}

/** The headline for what the payline did. */
function lineHeadline(result) {
    const { outcome, symbol, lineMult, multFactor } = result;
    const boosted = multFactor > 1 ? ` *(⚡ ×${multFactor})*` : '';
    switch (outcome) {
        case 'jackpot': return `🃏🃏🃏 **TRIPLE WILD!** ${TRIPLE_WILD_MULT}× on the line`;
        case 'mult3':   return `⚡⚡⚡ **Triple Boost** — **${TRIPLE_BOOST_MULT}×**`;
        case 'three':   return `${symbol.emoji.repeat(3)} **Three ${symbol.plural}** — **${lineMult}×**${boosted}`;
        case 'pair':    return `${symbol.emoji.repeat(2)} **Pair of ${symbol.plural}** — **${lineMult}×**${boosted}`;
        case 'push':    return '🎯 **Lucky Streak** — your bet came back.';
        default:        return null;
    }
}

function resultEmbed(ctx, view, spinOutcome) {
    const {
        result, linePay, pot, freeTotal, freeRuns, freeSpins, balance, notes, jackpotWon, charm,
    } = spinOutcome;
    const total = linePay + pot + freeTotal;
    const tier  = tierFor(total, ctx.bet, jackpotWon);

    const lines = [gridText(view.window), ''];
    const headline = lineHeadline(result);
    if (headline) lines.push(headline);
    if (freeSpins) {
        const n = view.scatterCount;
        lines.push(`🌸 **${n} Scatters** — ${freeSpins.spins} free spins${freeSpins.mult > 1 ? ` at **${freeSpins.mult}×**` : ''}!`);
    }
    if (!headline && !freeSpins) lines.push(`💨 *${randomFrom(SLOTS_LOSE_LINES)}*`);
    else if (total > ctx.bet) lines.push(`*${randomFrom(total >= 10 * ctx.bet ? SLOTS_BIG_WIN_LINES : SLOTS_WIN_LINES)}*`);

    const details = [];
    if (ctx.hot)  details.push('🔥 Hot Spin — reel 1 landed a high-value symbol');
    if (charm)    details.push('🍀 Lucky Charm — a second spin');
    if (result.wildCount > 0 && ['three', 'pair', 'mult3'].includes(result.outcome)) details.push('🃏 A Wild completed the line');
    if (jackpotWon) details.push(`🏆 Progressive pot: **+${fmt(pot)}**`);
    if (freeRuns.length) {
        const wins = freeRuns.filter(r => r.pay > 0);
        details.push(`🌸 Free spins: **+${fmt(freeTotal)}** (${wins.length} of ${freeRuns.length} hit)`);
    }
    if (details.length) lines.push('', ...details.map(d => `> ${d}`));

    const description = lines.join('\n') + notes.join('');

    return new EmbedBuilder()
        .setAuthor(embedAuthor(ctx.interaction))
        .setThumbnail(THUMB)
        .setColor(PALETTE[tier.key])
        .setTitle(tier.title)
        .setDescription(description)
        .addFields(
            { name: '💸 Bet',         value: `**${fmt(ctx.bet)}**`,                inline: true },
            { name: '🏆 Won',         value: `**${fmt(total)}**`,                  inline: true },
            { name: '📊 Net',         value: `**${signed(total - ctx.bet)}**`,     inline: true },
            { name: '💰 Balance',     value: `**${fmt(balance)}**`,                inline: true },
            { name: '🔥 Heat',        value: heatText(ctx.heatAfter, false),       inline: true },
            { name: '🏦 Progressive', value: `**${fmt(ctx.pool)}**`,               inline: true },
        )
        .setFooter({ text: `${sessionText(ctx.session)} · 📊 Paytable for the odds` })
        .setTimestamp();
}

function freeSpinFrame(ctx, run, index, count, runningTotal, mult) {
    const headline = lineHeadline(run.result);
    return new EmbedBuilder()
        .setAuthor(embedAuthor(ctx.interaction))
        .setThumbnail(THUMB)
        .setColor(PALETTE.free)
        .setTitle(`🌸 Free Spin ${index + 1} of ${count}${mult > 1 ? ` · ${mult}×` : ''}`)
        .setDescription(`${gridText(run.view.window)}\n\n${run.pay > 0 ? `${headline} → **+${fmt(run.pay)}**` : '*No win*'}`)
        .addFields({ name: '🎁 Free spin total', value: `**+${fmt(runningTotal)}**`, inline: true })
        .setFooter({ text: sessionText(ctx.session) });
}

/**
 * The channel-wide announcement of a Triple Wild.
 *
 * `delivery` is the claim's outcome, so the channel hears the same thing the
 * winner does: a pot that has not arrived is not announced as paid (#873).
 *
 * @param {object} interaction  the spin, for the winner's name and avatar
 * @param {number} wonAmount    what the spin won in all — line pay and pot
 * @param {number} newPool      what the pool holds after the claim
 * @param {object} [delivery]   `{ credited, owed }` from the claim
 */
function jackpotBroadcastEmbed(interaction, wonAmount, newPool, delivery = {}) {
    const { credited = true, owed = false } = delivery;
    const wonLine = credited
        ? `💰 Won **${wonAmount.toLocaleString()}** coins`
        : `💰 Won **${wonAmount.toLocaleString()}** coins — not delivered yet\n` +
          (owed ? '📝 Recorded for an admin to settle' : '⚠️ Could not be recorded — tell an admin');

    return new EmbedBuilder()
        .setColor(PALETTE.jackpot)
        .setTitle('🎰 ✨ J A C K P O T ✨ 🎰')
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .setDescription(
            `${interaction.user} just hit **TRIPLE WILD** 🃏🃏🃏 on the slots!\n\n` +
            `${wonLine}\n` +
            `🏦 Progressive now: **${newPool.toLocaleString()}** coins\n\n` +
            '> Think you can be next? `/casino slots`'
        )
        .setTimestamp();
}

function paytableEmbed() {
    const o = odds();
    const oneIn = key => {
        const p = o.lines.get(key);
        return p ? ` · 1 in ${fmt(1 / p)}` : '';
    };
    const regulars = SYMBOLS.filter(s => s.type === 'regular').reverse();
    const threes = regulars.map(s => `${s.emoji.repeat(3)} **${s.three}×**${oneIn(`three:${s.name}`)}`);
    const pairs  = regulars.filter(s => s.pair > 0).map(s => `${s.emoji.repeat(2)} **${s.pair}×**${oneIn(`pair:${s.name}`)}`);
    const pct = x => `${(x * 100).toFixed(1)}%`;
    const total = o.reelReturn + PROGRESSIVE_RETURN + RANDOM_DROP_RETURN;

    return new EmbedBuilder()
        .setColor(PALETTE.spin)
        .setThumbnail(THUMB)
        .setTitle('🎰 Slots — Paytable')
        .setDescription(
            'Wins pay on the **middle line** ▶️ ◀️, as a multiple of your bet.\n' +
            '🃏 **Wild** stands in for any symbol except 🌸. Every ⚡ **Boost** on the line doubles a line win.\n\n' +
            `🃏🃏🃏 **${TRIPLE_WILD_MULT}×** + the progressive pot, up to **${JACKPOT_CAP_MULT}×** your bet${oneIn('jackpot')}\n` +
            `⚡⚡⚡ **${TRIPLE_BOOST_MULT}×** (Wilds count)${oneIn('mult3')}\n` +
            `${threes.join('\n')}\n${pairs.join('\n')}`
        )
        .addFields(
            {
                name: '🌸 Free Spins',
                value: `2 Scatters anywhere in the window: **${FREE_SPINS[2].spins} free spins**. ` +
                    `3 Scatters: **${FREE_SPINS[3].spins}** at **${FREE_SPINS[3].mult}×**. ` +
                    `About 1 in ${fmt(1 / o.freeSpinRate)} spins.`,
            },
            {
                name: '🔥 Heat',
                value: `Every paid spin fills the meter. At ${HEAT_MAX}, your next spin is a **Hot Spin**: reel 1 lands a 🔔, 💎 or 🌟.`,
            },
            {
                name: '🍀 Luck items',
                value: `Lucky Charm re-spins ${pct(LUCKY_CHARM_RESPIN)} of losing spins; Lucky Streak refunds ${pct(LUCKY_STREAK_REFUND)} of them (bets up to 25,000). Coin boosters don't apply to slots.`,
            },
            {
                name: '📊 The math',
                value: `Return to player **${pct(total)}**: ${pct(o.reelReturn)} from the reels and features, ` +
                    `up to ${pct(PROGRESSIVE_RETURN)} from Triple Wild pots and ${pct(RANDOM_DROP_RETURN)} from random pool drops. ` +
                    `A line win lands on **${pct(o.hitRate)}** of spins, and every one pays more than the bet.`,
            },
        )
        .setFooter({ text: 'The window shows the real reel strips — what sits above and below the line is what was there.' });
}

/**
 * The buttons under a result. Spin repeats the bet; ½, 2× and Max spin again
 * at half, double, or the most this player can stake without a confirmation.
 * Each is disabled when that spin could not go ahead — the wallet cannot cover
 * it, it is over the guild's limit, or (2× and Max) it would step past the
 * large-bet confirmation a typed command would have asked for.
 */
function stakeOptions(bet, balance, guildSettings) {
    const limit = guildSettings?.economy?.casinoMaxBet > 0 ? guildSettings.economy.casinoMaxBet : MAX_BET;
    // The most a raise button may stake: the guild's limit, the wallet, and the
    // largest bet a typed command would take without asking to confirm.
    const ceiling = Math.floor(Math.min(limit, balance, confirmThreshold(guildSettings, balance), MAX_BET));
    return {
        limit,
        ceiling,
        half:   Math.max(MIN_BET, Math.floor(bet / 2)),
        double: Math.min(MAX_BET, bet * 2),
        max:    ceiling,
    };
}

function controls(ids, bet, balance, stakes) {
    const { limit, ceiling, half, double, max } = stakes;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ids.replay).setLabel(`🎰 Spin · ${fmt(bet)}`)
            .setStyle(ButtonStyle.Primary).setDisabled(bet > balance || bet > limit),
        new ButtonBuilder().setCustomId(ids.half).setLabel(`½ · ${fmt(half)}`)
            .setStyle(ButtonStyle.Secondary).setDisabled(half >= bet || half > balance),
        new ButtonBuilder().setCustomId(ids.double).setLabel(`2× · ${fmt(double)}`)
            .setStyle(ButtonStyle.Secondary).setDisabled(double <= bet || double > ceiling),
        // Max never lowers the stake: after a confirmed large bet the ceiling
        // can sit below it, and "Max" spinning for less would read as a lie.
        new ButtonBuilder().setCustomId(ids.max).setLabel(`Max · ${fmt(Math.max(max, MIN_BET))}`)
            .setStyle(ButtonStyle.Secondary).setDisabled(max <= bet || max < MIN_BET),
        new ButtonBuilder().setCustomId(ids.paytable).setLabel('📊 Paytable')
            .setStyle(ButtonStyle.Secondary),
    );
}

// ─── Where a spin renders ─────────────────────────────────────────────────────
//
// The first spin edits the command's reply. Every replay edits through the
// button press that asked for it instead: a press carries its own token, good
// for fifteen minutes from the press, where the command's own expires fifteen
// minutes after it was typed. Chaining replays through the command's token
// broke a long session at that mark — the coins moved and the message stopped
// updating.
//
// A bet that needed the large-bet confirmation plays in a public follow-up: the
// confirmation itself is ephemeral, and playing into it hid the biggest bets
// from the channel.

function replySurface(interaction) {
    return {
        edit:   payload => interaction.editReply(payload),
        fetch:  () => interaction.fetchReply(),
        notice: content => interaction.editReply({ content, embeds: [], components: [] }),
    };
}

function followUpSurface(interaction) {
    let message = null;
    return {
        async edit(payload) {
            if (!message) {
                // A new message cannot be sent with empty content; an edit can clear it.
                const { content, ...rest } = payload;
                message = await interaction.followUp(content ? payload : rest);
                return message;
            }
            return interaction.editReply({ ...payload, message });
        },
        fetch:  async () => message,
        // The confirmation is still the command's reply, and it is private.
        notice: content => interaction.editReply({ content, embeds: [], components: [] }),
    };
}

function pressSurface(press) {
    return {
        edit:   payload => press.editReply(payload),
        fetch:  async () => (await press.fetchReply?.()) ?? press.message,
        notice: async content => {
            await press.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
            await press.editReply({ components: [] }).catch(() => {});
        },
    };
}

const newSession = () => ({ spins: 0, wagered: 0, returned: 0 });

// ─── The command ──────────────────────────────────────────────────────────────

module.exports = {
    name: 'slots',
    description: 'Spin the slot machine and try your luck!',
    cooldown: 5,
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount of coins to bet (min ${MIN_BET})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true)),
    async execute(interaction, { releaseLock, onWager } = {}) {
        const bet           = interaction.options.getInteger('bet');
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const refusal = casinoRefusal(guildSettings, bet);
        if (refusal) {
            releaseLock?.();
            return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
        }
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const wallet = user?.balance ?? 0;
        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, wallet, 'Slots', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }
        if (!alreadyReplied) await interaction.deferReply();
        const surface = alreadyReplied ? followUpSurface(interaction) : replySurface(interaction);
        await playSlots({ interaction, bet, surface, releaseLock, onWager, session: newSession() });
    },
};

// ─── One spin ─────────────────────────────────────────────────────────────────

/**
 * Plays one paid spin: stake, reels, every payout settled, and only then the
 * show. Nothing the player watches can change what they were paid — a crash
 * mid-reveal leaves a settled hand, not a lost one.
 *
 * releaseLock is called once the spin has settled. A replay starts a brand-new
 * hand with its own atomic debit, so it does not need the lock re-held.
 */
async function playSlots(ctx) {
    const { interaction, bet, surface, releaseLock, onWager, session } = ctx;
    const handId = newHandId();
    let settled  = false;
    // Hoisted so the rollback below can tell "the spin errored" from "the spin
    // errored before the stake was ever taken" — refunding the second mints
    // coins that were never debited.
    let debited  = null;
    const userFilter  = { userId: interaction.user.id, guildId: interaction.guild.id };
    const guildFilter = { guildId: interaction.guild.id };
    try {
        const [userDoc, guildSettings] = await Promise.all([
            User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ),
            Guild.findOne(guildFilter),
        ]);

        const luck = casinoLuck('slots', userDoc, bet);

        // ── Debit the bet FIRST, before any pool or meter writes ────────────
        debited = await placeWager(userFilter, bet, { onWager });
        if (!debited) {
            releaseLock?.();
            const fresh = await User.findOne(userFilter);
            return surface.notice(`❌ Not enough coins for a **${fmt(bet)}** spin! Your balance: **${fmt(fresh?.balance ?? 0)}** coins.`);
        }

        // ── Heat meter ──────────────────────────────────────────────────────
        //
        // A full meter is claimed, not read: the claim zeroes it in the same
        // write that proves it was full, so two spins in flight at once — a
        // replay does not hold the casino lock — cannot both spend it. The one
        // that loses the claim spins cold and counts toward the next meter. A
        // spin that is not hot adds its one with `$inc` for the same reason.
        const heatBefore = userDoc.casinoStats?.slotsHeat ?? 0;
        const hot = heatBefore >= HEAT_MAX
            && Boolean(await User.findOneAndUpdate(
                { ...userFilter, 'casinoStats.slotsHeat': { $gte: HEAT_MAX } },
                { $set: { 'casinoStats.slotsHeat': 0 } },
                { projection: { _id: 1 } },
            ).catch(() => null));
        if (!hot) {
            await User.updateOne(userFilter, { $inc: { 'casinoStats.slotsHeat': 1 } }).catch(() => {});
        }
        const heatAfter = hot ? 0 : Math.min(HEAT_MAX, heatBefore + 1);

        // ── The reels ───────────────────────────────────────────────────────
        const firstView = spin({ hot });
        let view   = firstView;
        let result = evaluate(view.line, bet, { scatterCount: view.scatterCount });
        let charm  = false;

        // Lucky Charm: a losing spin sometimes gets a second one. A Hot Spin's
        // second spin keeps the reel it was locked to.
        if (isNetLoss(result, bet) && luck.charm > 0 && Math.random() < luck.charm) {
            view   = spin({ lock: hot ? firstView.stops[0] : null });
            result = evaluate(view.line, bet, { scatterCount: view.scatterCount });
            charm  = true;
        }
        // Lucky Streak: a spin that is still a loss is sometimes refunded.
        if (isNetLoss(result, bet) && luck.streak > 0 && Math.random() < luck.streak) {
            result = { ...result, outcome: 'push', payout: bet };
        }

        // ── Progressive pot (bet already charged) ───────────────────────────
        //
        // A Triple Wild pays TRIPLE_WILD_MULT on the line like any line win,
        // and claims the pool on top — up to JACKPOT_CAP_MULT × the bet, which
        // is what keeps a minimum bet from winning what a maximum one does.
        // casinoJackpotService credits the pot itself under its own payout key,
        // so it never passes through payHand below; a claim that has not been
        // credited is being recovered under that key, and paying anything in
        // its place would pay it twice (#873).
        const jackpotPool = guildSettings?.casinoJackpot?.pool ?? JACKPOT_SEED;
        let pot = 0;
        let jackpotWon = false;
        let jackpotDelivery = {};
        let newPool = null;
        const notes = [];

        if (result.outcome === 'jackpot') {
            const claim = await claimJackpot({
                guildId:  interaction.guild.id,
                userId:   interaction.user.id,
                username: interaction.user.username,
                maxWin:   bet * JACKPOT_CAP_MULT,
                note:     'Progressive jackpot win — slots Triple Wild',
            });
            newPool = claim.newPool;
            if (claim.claimed) {
                jackpotWon = true;
                pot = claim.wonAmount;
                jackpotDelivery = { credited: claim.credited, owed: claim.owed };
                if (!claim.credited) {
                    notes.push(claim.owed
                        ? '\n⚠️ The progressive pot could not be paid out just now — it has been recorded and an admin can settle it.'
                        : '\n⚠️ The progressive pot could not be paid out just now, and could not be recorded either — please tell an admin.');
                }
            } else {
                // No guild document, so no pool. The line pay still stands.
                console.error(`[Slots] no jackpot pool to claim for ${interaction.user.id} — paying the line only`);
            }
        }

        // ── Free spins, played now and paid with the rest ───────────────────
        const freeSpins = result.freeSpins;
        const freeRuns  = [];
        let freeTotal   = 0;
        if (freeSpins) {
            for (let n = 0; n < freeSpins.spins; n++) {
                const freeView   = spin();
                const freeResult = evaluate(freeView.line, bet, { freeSpin: true });
                const pay = Math.floor(freeResult.payout * freeSpins.mult);
                freeTotal += pay;
                freeRuns.push({ view: freeView, result: freeResult, pay });
            }
        }

        // ── Settle ──────────────────────────────────────────────────────────
        //
        // No coin booster. A booster multiplies the profit on a win, and slots'
        // wins pay several times the stake, so a 2× booster turned a 94% machine
        // into one that paid back about 169%.
        const linePay = result.payout;
        const paid = await payHand(userFilter, linePay, { game: 'slots', handId, phase: 'settle' });
        let balanceAfter = await settledBalance(userFilter, paid.balance);
        // What the free-spin intro shows: the balance before the free spins it
        // is about to play have been counted.
        const lineBalance = balanceAfter;
        notes.push(payoutNote(paid));
        if (freeTotal > 0) {
            const freePaid = await payHand(userFilter, freeTotal, { game: 'slots', handId, phase: 'free-spins' });
            balanceAfter = await settledBalance(userFilter, freePaid.balance);
            notes.push(payoutNote(freePaid));
        }
        settled = true;
        releaseLock?.();

        session.spins    += 1;
        session.wagered  += bet;
        session.returned += linePay + freeTotal + pot;

        // ── The show ────────────────────────────────────────────────────────
        const show = { ...ctx, hot, heat: hot ? HEAT_MAX : heatAfter, heatAfter, pool: jackpotPool };
        const sessionBefore = { spins: session.spins - 1, wagered: session.wagered - bet, returned: session.returned - (linePay + freeTotal + pot) };
        const frameCtx = { ...show, session: sessionBefore };

        if (charm) {
            await reveal(surface, frameCtx, firstView);
            await surface.edit({
                embeds: [frameEmbed(frameCtx, firstView.window, {
                    revealed: 3,
                    status: '🍀 **Lucky Charm!** Second chance…',
                    color: PALETTE.tease,
                })],
                components: [],
            });
            await delay(CHARM_MS);
        }
        await reveal(surface, frameCtx, view);

        // The pool after this spin: the claim's own figure on a Triple Wild,
        // otherwise a fresh read — this spin's contribution was fired from
        // placeWager and the reels have been turning since the snapshot.
        if (newPool === null) {
            const fresh = await Guild.findOne(guildFilter, 'casinoJackpot').lean().catch(() => null);
            newPool = fresh?.casinoJackpot?.pool ?? jackpotPool;
        }
        show.pool = newPool;

        const outcome = {
            result, linePay, pot, freeTotal, freeRuns, freeSpins, balance: balanceAfter, notes, jackpotWon, charm,
        };

        if (freeSpins) {
            // The spin that won them, with the scatters in view, then the spins.
            await surface.edit({
                embeds: [resultEmbed({ ...show, session: sessionBefore }, view, { ...outcome, freeTotal: 0, freeRuns: [], balance: lineBalance })
                    .setColor(PALETTE.free)
                    .setTitle(`🌸 FREE SPINS × ${freeSpins.spins}${freeSpins.mult > 1 ? ` at ${freeSpins.mult}×` : ''}`)],
                components: [],
            });
            await delay(FREE_INTRO_MS);
            let running = 0;
            for (const [index, run] of freeRuns.entries()) {
                running += run.pay;
                await surface.edit({ embeds: [freeSpinFrame(frameCtx, run, index, freeRuns.length, running, freeSpins.mult)], components: [] });
                await delay(FREE_SPIN_MS);
            }
        }

        const stamp = Date.now();
        const ids = {
            replay:   `slots_replay_${interaction.id}_${stamp}`,
            half:     `slots_half_${interaction.id}_${stamp}`,
            double:   `slots_double_${interaction.id}_${stamp}`,
            max:      `slots_max_${interaction.id}_${stamp}`,
            paytable: `slots_pay_${interaction.id}_${stamp}`,
        };
        const stakes = stakeOptions(bet, balanceAfter, guildSettings);
        await surface.edit({
            embeds: [resultEmbed(show, view, outcome)],
            components: [controls(ids, bet, balanceAfter, stakes)],
        });

        // The channel hears about a Triple Wild after the winner has seen it land.
        if (jackpotWon && (guildSettings?.slots?.announceJackpot ?? true)) {
            const pingHere      = guildSettings?.slots?.jackpotPingHere ?? false;
            const jackpotChanId = guildSettings?.slots?.jackpotChannelId ?? null;
            const targetChannel = jackpotChanId
                ? (interaction.guild?.channels?.cache?.get(jackpotChanId) ?? interaction.channel)
                : interaction.channel;
            await targetChannel?.send({
                content: pingHere ? '@here' : undefined,
                // The client default never parses @here; this opt-in is the one place it should.
                allowedMentions: pingHere ? { parse: ['everyone'] } : { parse: [] },
                embeds: [jackpotBroadcastEmbed(interaction, linePay + pot, newPool, jackpotDelivery)],
            }).catch(err => console.error(`[Slots] jackpot broadcast failed — channel:${targetChannel?.id} interaction:${interaction.id}`, err));
        }

        // ── Big win announcement ────────────────────────────────────────────
        // The whole spin counts — a free-spin run is as much a win as a line.
        const total = linePay + freeTotal;
        const announceChannelId = guildSettings?.economy?.announcementChannelId ?? null;
        if (!jackpotWon && total >= WIN_ANNOUNCE_MULT * bet && announceChannelId && announceChannelId !== interaction.channelId) {
            const what = result.symbol ? `Three ${result.symbol.plural}` : freeSpins ? 'free-spin run' : 'win';
            const bigWinEmbed = new EmbedBuilder()
                .setColor(PALETTE.epic)
                .setDescription(`🎰 ${interaction.user} just hit a **${Math.floor(total / bet)}× ${what}** on slots for **${fmt(total)} coins**!`)
                .setTimestamp();
            const ch = interaction.guild?.channels?.cache?.get(announceChannelId);
            if (ch?.isTextBased?.()) ch.send({ embeds: [bigWinEmbed] }).catch(() => {});
        }

        const msg = await surface.fetch();
        const collector = msg.createMessageComponentCollector({
            filter: ownedBy(
                interaction.user.id,
                i => Object.values(ids).includes(i.customId),
                "This isn't your spin — run `/casino slots` for your own.",
            ),
            time: REPLAY_WINDOW_MS,
        });

        collector.on('collect', async i => {
            if (i.customId === ids.paytable) {
                await i.reply({ embeds: [paytableEmbed()], flags: MessageFlags.Ephemeral }).catch(() => {});
                return;
            }
            // The stake the button showed, not one worked out again at press time.
            const nextBet = i.customId === ids.half ? stakes.half
                : i.customId === ids.double ? stakes.double
                : i.customId === ids.max ? stakes.max
                : bet;
            // A new spin is a new hand, so it answers to the settings as they
            // are now, not as they were when the first one was typed.
            const refused = await replayRefusal(interaction.guild.id, nextBet);
            if (refused) {
                collector.stop('refused');
                return refuseReplay(i, { editReply: payload => surface.edit(payload) }, refused);
            }
            collector.stop('replay');
            await i.deferUpdate().catch(() => {});
            await playSlots({ ...ctx, bet: nextBet, surface: pressSurface(i), releaseLock: null });
        });

        collector.on('end', (_, reason) => {
            if (reason !== 'replay') surface.edit({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Slots] error:', err);
        releaseLock?.();
        const rolled = debited && !settled
            ? await payHand(userFilter, bet, { game: 'slots', handId, phase: 'rollback' })
            : null;
        const outcome = !debited ? 'No wager was taken.'
            : settled ? 'Your spin had already been settled — check your balance.'
            : rolled.credited ? 'Your wager was refunded — please try again.' : 'Your wager could not be refunded.';
        await surface.edit({
            content: '',
            embeds: [new EmbedBuilder()
                .setColor(PALETTE.error)
                .setTitle('🎰 Slots hit a snag')
                .setDescription(`An error occurred while playing slots. ${outcome}${rolled ? payoutNote(rolled) : ''}`)],
            components: [],
        }).catch(() => {});
    }
}
