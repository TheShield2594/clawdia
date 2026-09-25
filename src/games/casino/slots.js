const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    AttachmentBuilder,
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
const { paytableImage, paytableAltText } = require('./slotsPaytableCard');
const { renderMachine } = require('./slotsTable');
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
const IMAGE_NAME = 'slots.jpg';

const MIN_BET = 10;
const MAX_BET = 1_000_000_000;

// The reveal. Each reel stops on its own frame; the last one holds longer when
// the first two have set something up (see `teaseFor`).
const FRAME_MS      = 700;
const TEASE_MS      = 1_500;
const CHARM_MS      = 1_200;
const FREE_INTRO_MS = 1_500;
const FREE_BATCH_MS = 1_200;

// Free spins play out on one image, a tile per spin, filled in this many
// edits whatever the count: fifteen spins at an edit each ran into Discord's
// edit rate limit, and uploaded fifteen images to say one thing.
const FREE_BATCHES = 3;

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
    if (wild(a) && wild(b)) return { status: '🃏🃏 **One more Wild for the jackpot…**', pill: 'ONE MORE WILD FOR THE JACKPOT' };
    const scatters = window.flatMap(row => row.slice(0, 2)).filter(s => s.type === 'scatter').length;
    if (scatters >= 2) {
        return {
            status: `🌸🌸 **Free spins locked in — one more Scatter for ${FREE_SPINS[3].spins}…**`,
            pill:   `ONE MORE SCATTER FOR ${FREE_SPINS[3].spins} FREE SPINS`,
        };
    }
    const top = s => s.name === 'Diamond' || s.name === 'Star';
    if ((top(a) || wild(a)) && (top(b) || wild(b)) && (a === b || wild(a) || wild(b))) {
        const target = wild(a) ? b : a;
        return {
            status: `${a.emoji}${b.emoji} **Last reel…**`,
            pill:   wild(target) ? 'LAST REEL…' : `ONE MORE ${target.name.toUpperCase()} FOR ${target.three}×`,
        };
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

/**
 * A reel frame. With the machine image beside it the image shows the reels, so
 * the text grid is only drawn when the image could not be.
 */
function frameEmbed(ctx, window, { revealed, status, color = PALETTE.spin, withImage = false }) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(ctx.interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🎰 Slots')
        .setDescription(withImage ? status : `${status}\n\n${gridText(window, revealed)}`)
        .addFields(statusFields(ctx))
        .setFooter({ text: sessionText(ctx.session) });
}

/** Plays one set of reels to a stop, reel by reel. A Hot Spin's first reel starts stopped. */
async function reveal(surface, ctx, view) {
    const first = ctx.hot ? 1 : 0;
    const lead  = ctx.hot ? '🔥 **Hot Spin!** Reel 1 locked.' : '🎰 **Spinning…**';
    for (let revealed = first; revealed < 3; revealed++) {
        const tease = revealed === 2 ? teaseFor(view.window) : null;
        const machine = {
            ...machineBase(ctx),
            reels:  reelsView(view.window, {
                revealed,
                glow: { 0: ctx.hot ? 'hot' : undefined, 2: tease ? 'gold' : undefined },
            }),
            tag:    tease ? { text: tease.pill, tone: 'gold' }
                : ctx.hot ? { text: 'HOT SPIN · REEL 1 LOCKED', tone: 'hot' } : null,
            status: tease ? null : 'SPINNING…',
        };
        await surface.edit(await machinePayload(
            machine,
            revealAltText(ctx, view.window, revealed, machine.tag),
            withImage => frameEmbed(ctx, view.window, {
                revealed,
                status: tease?.status ?? lead,
                color: tease ? PALETTE.tease : PALETTE.spin,
                withImage,
            }),
        ));
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

function resultEmbed(ctx, view, spinOutcome, withImage = false) {
    const {
        result, linePay, pot, freeTotal, freeRuns, freeSpins, balance, notes, jackpotWon, charm,
    } = spinOutcome;
    const total = linePay + pot + freeTotal;
    const tier  = tierFor(total, ctx.bet, jackpotWon);

    const lines = withImage ? [] : [gridText(view.window), ''];
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

/**
 * The free spins played so far, `played` of them. The image carries every
 * spin's line; the text lists the ones that paid, and without the image, every
 * line in a row of its own.
 */
function freeSpinsEmbed(ctx, runs, played, runningTotal, mult, withImage = false) {
    const lines = runs.slice(0, played).map((run, i) => {
        const pay = run.pay > 0 ? `${lineHeadline(run.result)} → **+${fmt(run.pay)}**` : null;
        if (withImage) return pay && `\`${i + 1}\` ${pay}`;
        return `\`${i + 1}\` ${run.view.line.map(s => s.emoji).join(' ')}  ${pay ?? '*no win*'}`;
    }).filter(Boolean);
    return new EmbedBuilder()
        .setAuthor(embedAuthor(ctx.interaction))
        .setThumbnail(THUMB)
        .setColor(PALETTE.free)
        .setTitle(`🌸 Free Spins · ${played} of ${runs.length}${mult > 1 ? ` · ${mult}×` : ''}`)
        .setDescription(lines.length ? lines.join('\n') : '*No wins yet…*')
        .addFields({ name: '🎁 Free spin total', value: `**+${fmt(runningTotal)}**`, inline: true })
        .setFooter({ text: sessionText(ctx.session) });
}

// ─── The machine image ────────────────────────────────────────────────────────
//
// Every frame carries a picture of the machine (slotsTable.js) beside its
// embed, the way blackjack carries its table. The embed keeps the numbers —
// line, payout, balance, session — and the attachment gets alt text saying
// what the reels show.

const artName = symbol => symbol.name.toLowerCase();

/** The status row every frame shares. */
function machineBase(ctx) {
    return { bet: ctx.bet, pot: ctx.pool, heat: ctx.heat, heatMax: HEAT_MAX, hot: ctx.hot };
}

/**
 * The three reels of a window for the image. Reels at or past `revealed` are
 * still spinning. `hits` are `[row, reel]` cells to outline; `glow` is by reel.
 */
function reelsView(window, { revealed = 3, hits = [], glow = {} } = {}) {
    return [0, 1, 2].map(reel => ({
        cells: reel < revealed ? window.map(row => artName(row[reel])) : null,
        glow:  glow[reel],
        hits:  hits.filter(([, c]) => c === reel).map(([r]) => r),
    }));
}

/** The payline cells a line win used: every cell of a three, the pair's own and its helpers. */
function lineCells(result, line) {
    switch (result.outcome) {
        case 'jackpot':
        case 'mult3':
        case 'three':
            return [0, 1, 2];
        case 'pair':
            // The pair's own symbols, and the Wilds and Boosts that helped it.
            return line.map((s, i) => (s === result.symbol || s.type === 'wild' || s.type === 'multiplier' ? i : -1))
                .filter(i => i >= 0);
        default:
            return [];
    }
}

/** The line win as a pill, in the image's capitals. */
function lineTag(result, jackpotWon) {
    const { outcome, symbol, lineMult, multFactor } = result;
    const boosted = multFactor > 1 ? ` · BOOST ×${multFactor}` : '';
    switch (outcome) {
        case 'jackpot': return { text: `TRIPLE WILD · ${TRIPLE_WILD_MULT}×${jackpotWon ? ' + THE POT' : ''}`, tone: 'gold' };
        case 'mult3':   return { text: `TRIPLE BOOST · ${TRIPLE_BOOST_MULT}×`, tone: 'win' };
        case 'three':   return { text: `THREE ${symbol.plural.toUpperCase()} · ${lineMult}×${boosted}`, tone: 'win' };
        case 'pair':    return { text: `PAIR OF ${symbol.plural.toUpperCase()} · ${lineMult}×${boosted}`, tone: 'win' };
        case 'push':    return { text: 'LUCKY STREAK · BET BACK', tone: 'push' };
        default:        return null;
    }
}

/** The result banner by win tier, with what the spin made over its stake. */
function tierBanner(tier, net) {
    switch (tier.key) {
        case 'jackpot': return { text: `JACKPOT  +${fmt(net)}`, tone: 'gold' };
        case 'epic':    return { text: `EPIC WIN  +${fmt(net)}`, tone: 'gold' };
        case 'mega':    return { text: `MEGA WIN  +${fmt(net)}`, tone: 'gold' };
        case 'big':     return { text: `BIG WIN  +${fmt(net)}`, tone: 'gold' };
        case 'win':     return { text: `WIN  +${fmt(net)}`, tone: 'win' };
        case 'push':    return { text: 'MONEY BACK', tone: 'push' };
        default:        return { text: 'NO WIN', tone: 'lose' };
    }
}

const freeAward = (spins, mult) => `${spins} FREE SPINS${mult > 1 ? ` AT ${mult}×` : ''}`;

/** A settled spin's window, its winning cells outlined — the Scatters too, when they paid. */
function resultReels(view, result) {
    const hits = lineCells(result, view.line).map(reel => [1, reel]);
    if (result.freeSpins) {
        view.window.forEach((row, r) => row.forEach((s, c) => { if (s.type === 'scatter') hits.push([r, c]); }));
    }
    const glow = result.outcome === 'jackpot' ? { 0: 'gold', 1: 'gold', 2: 'gold' } : {};
    return reelsView(view.window, { hits, glow });
}

/** The free-spin strip: a tile for each spin played, an empty one for each to come. */
function stripView(runs, played) {
    return runs.map((run, i) => (i < played ? { cells: run.view.line.map(artName), pay: run.pay } : null));
}

const names = symbols => symbols.map(s => s.name).join(', ');

function revealAltText(ctx, window, revealed, tag) {
    const reels = [0, 1, 2].map(reel => (reel < revealed
        ? `reel ${reel + 1} stopped on ${window[1][reel].name}`
        : `reel ${reel + 1} spinning`));
    return `Slot machine, bet ${fmt(ctx.bet)}: ${reels.join(', ')}.${tag ? ` ${tag.text}.` : ''}`;
}

function resultAltText(ctx, view, tag, banner) {
    return `Slot machine, bet ${fmt(ctx.bet)}. Payline: ${names(view.line)}. ` +
        `Above it: ${names(view.window[0])}. Below it: ${names(view.window[2])}.` +
        `${tag ? ` ${tag.text}.` : ''} ${banner.text}.`;
}

function stripAltText(runs, played, tag, banner) {
    const spins = runs.slice(0, played)
        .map((run, i) => `${i + 1}: ${names(run.view.line)}, ${run.pay > 0 ? `+${fmt(run.pay)}` : 'no win'}`);
    return `Free spins, ${played} of ${runs.length} played. ${spins.join('; ')}.` +
        `${tag ? ` ${tag.text}.` : ''} ${banner.text}.`;
}

let renderFailureLogged = false;

/**
 * One frame's message: the embed, the machine image and the buttons. The image
 * is a nicety — the embed says everything in words too — so a render failure is
 * logged once and the spin plays on in text. `embedFor(withImage)` builds the
 * embed, told whether the image made it, so it can draw the text grid in its
 * place.
 */
async function machinePayload(view, alt, embedFor, components = []) {
    let image = null;
    try {
        image = new AttachmentBuilder(await renderMachine(view), { name: IMAGE_NAME, description: alt.slice(0, 1024) });
    } catch (err) {
        if (!renderFailureLogged) {
            renderFailureLogged = true;
            console.error('[Slots] machine render failed; continuing without the image:', err);
        }
    }
    const embed = embedFor(Boolean(image));
    if (image) embed.setImage(`attachment://${IMAGE_NAME}`);
    // `attachments: []` replaces the last frame's image rather than stacking
    // a new one beside it.
    return { embeds: [embed], components, files: image ? [image] : [], attachments: [] };
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
 * Answers the Paytable button, privately, with the paytable image. Deferred
 * first: the first render in a process takes around a second, and a press must
 * be answered within three. A render that fails sends the text paytable instead.
 */
async function showPaytable(press) {
    await press.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    let payload;
    try {
        const image = new AttachmentBuilder(await paytableImage(), {
            name: 'slots-paytable.png',
            description: paytableAltText().slice(0, 1024),
        });
        payload = { files: [image] };
    } catch (err) {
        console.error('[Slots] paytable render failed:', err);
        payload = { embeds: [paytableEmbed()] };
    }
    await press.editReply(payload).catch(() => {});
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
            const tag = { text: 'LUCKY CHARM · SECOND CHANCE', tone: 'gold' };
            await surface.edit(await machinePayload(
                { ...machineBase(frameCtx), reels: reelsView(firstView.window), tag },
                `Slot machine, bet ${fmt(bet)}. Payline: ${names(firstView.line)}. ${tag.text}.`,
                withImage => frameEmbed(frameCtx, firstView.window, {
                    revealed: 3,
                    status: '🍀 **Lucky Charm!** Second chance…',
                    color: PALETTE.tease,
                    withImage,
                }),
            ));
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

        const resultBase = { ...machineBase(show), heat: heatAfter, hot: false };
        const total  = linePay + pot + freeTotal;
        const banner = tierBanner(tierFor(total, bet, jackpotWon), total - bet);
        const scatterTag = freeSpins && { text: `${view.scatterCount} SCATTERS · ${freeAward(freeSpins.spins, freeSpins.mult)}`, tone: 'gold' };
        const line = lineTag(result, jackpotWon) ?? scatterTag;

        if (freeSpins) {
            // The spin that won them, with the scatters in view, then the spins.
            const introCtx = { ...show, session: sessionBefore };
            const introBanner = { text: `FREE SPINS × ${freeSpins.spins}${freeSpins.mult > 1 ? ` AT ${freeSpins.mult}×` : ''}`, tone: 'gold' };
            await surface.edit(await machinePayload(
                { ...resultBase, reels: resultReels(view, result), tag: line, banner: introBanner },
                resultAltText(introCtx, view, line, introBanner),
                withImage => resultEmbed(introCtx, view, { ...outcome, freeTotal: 0, freeRuns: [], balance: lineBalance }, withImage)
                    .setColor(PALETTE.free)
                    .setTitle(`🌸 FREE SPINS × ${freeSpins.spins}${freeSpins.mult > 1 ? ` at ${freeSpins.mult}×` : ''}`),
            ));
            await delay(FREE_INTRO_MS);
            // A few tiles at a time, not an edit per spin.
            const step = Math.ceil(freeRuns.length / FREE_BATCHES);
            for (let shown = 0; shown < freeRuns.length; shown += step) {
                const upto = Math.min(shown + step, freeRuns.length);
                const running = freeRuns.slice(0, upto).reduce((sum, run) => sum + run.pay, 0);
                const tag = { text: `FREE SPIN ${upto} OF ${freeRuns.length}${freeSpins.mult > 1 ? ` · ${freeSpins.mult}×` : ''}`, tone: 'info' };
                const runningBanner = { text: `FREE SPINS  +${fmt(running)}`, tone: running > 0 ? 'gold' : 'info' };
                await surface.edit(await machinePayload(
                    { ...resultBase, free: stripView(freeRuns, upto), tag, banner: runningBanner },
                    stripAltText(freeRuns, upto, tag, runningBanner),
                    withImage => freeSpinsEmbed(frameCtx, freeRuns, upto, running, freeSpins.mult, withImage),
                ));
                await delay(FREE_BATCH_MS);
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
        // After free spins the last picture is the finished strip, under the
        // whole spin's banner; the line that won them was shown on the intro.
        const hitCount = freeRuns.filter(run => run.pay > 0).length;
        const finalView = freeSpins
            ? {
                ...resultBase,
                free:   stripView(freeRuns, freeRuns.length),
                tag:    { text: `${hitCount} OF ${freeRuns.length} FREE SPINS HIT · +${fmt(freeTotal)}`, tone: freeTotal > 0 ? 'win' : 'info' },
                banner,
            }
            : { ...resultBase, reels: resultReels(view, result), tag: line, banner };
        const finalAlt = freeSpins
            ? `Payline: ${names(view.line)}.${line ? ` ${line.text}.` : ''} ${stripAltText(freeRuns, freeRuns.length, finalView.tag, banner)}`
            : resultAltText(show, view, line, banner);
        await surface.edit(await machinePayload(
            finalView,
            finalAlt,
            withImage => resultEmbed(show, view, outcome, withImage),
            [controls(ids, bet, balanceAfter, stakes)],
        ));

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
        const won = linePay + freeTotal;
        const announceChannelId = guildSettings?.economy?.announcementChannelId ?? null;
        if (!jackpotWon && won >= WIN_ANNOUNCE_MULT * bet && announceChannelId && announceChannelId !== interaction.channelId) {
            // A pair also carries a symbol, so name the three only when it was one.
            const what = freeTotal > 0 ? 'free-spin run'
                : result.outcome === 'three' ? `Three ${result.symbol.plural}`
                : 'win';
            const bigWinEmbed = new EmbedBuilder()
                .setColor(PALETTE.epic)
                .setDescription(`🎰 ${interaction.user} just hit a **${Math.floor(won / bet)}× ${what}** on slots for **${fmt(won)} coins**!`)
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
                await showPaytable(i);
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
            attachments: [],
            embeds: [new EmbedBuilder()
                .setColor(PALETTE.error)
                .setTitle('🎰 Slots hit a snag')
                .setDescription(`An error occurred while playing slots. ${outcome}${rolled ? payoutNote(rolled) : ''}`)],
            components: [],
        }).catch(() => {});
    }
}
