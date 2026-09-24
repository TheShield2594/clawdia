'use strict';

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { placeWager } = require('../../utils/placeWager');
const { confirmBet } = require('../../utils/confirmBet');
const { delay } = require('../../utils/delay');
const { casinoRefusal, replayRefusal } = require('./betGuard');
const { randomFrom, BJ_WIN_LINES, BJ_LOSE_LINES, BJ_BUST_LINES, BJ_PUSH_LINES } = require('../../utils/copyLines');
const COLORS = require('../../utils/embedColors');
const {
    buildDeck,
    handTotal,
    totalLabel,
    canDoubleDown,
    canSplitHand,
    dealerPeeks,
    settleHand,
    isNaturalBlackjack,
} = require('./blackjackHands');
const {
    naturalBlackjackCredit,
    blackjackHandCredit,
    evenMoneyCredit,
    insuranceCredit,
    insuranceProfit,
    insuranceCost: halfBet,
} = require('./settlement');
const { ownedBy } = require('../../utils/collectorOwner');
const { newHandId, payHand, payoutNote, settledBalance } = require('./payout');
const { renderTable, shortAmount } = require('./blackjackTable');
const { recordBlackjackRound, statsLine } = require('./blackjackStats');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { getPolicyDecision } = require('../../utils/commandPolicy');

const MIN_BET = 10;
const MAX_BET = 1_000_000_000;

// A turn times out after this long *without a press*, not this long in total:
// the old 60-second total stood a player who was still thinking through a split.
const TURN_IDLE_MS   = 60_000;
const PROMPT_MS      = 15_000;
const REBET_IDLE_MS  = 60_000;
const REVEAL_MS      = 800;
const DEALER_STEP_MS = 900;
// An interaction token edits its reply for fifteen minutes. A rebet that deals
// a new hand near the end of that would lose its table mid-hand — stake taken,
// buttons dead — so the table closes to rebets a little before.
const TABLE_TTL_MS   = 13 * 60_000;

const IMAGE_NAME   = 'blackjack.png';
const FELT         = '#1f7a4d';
const RULES_FOOTER = 'Blackjack pays 3:2 · Dealer stands on soft 17 · Insurance pays 2:1';

const RULES = [
    '**Goal** — finish closer to 21 than the dealer without going over. Face cards are 10; aces are 1 or 11.',
    '**Blackjack** — an ace and a ten-value card on the deal pays **3:2**. Against a dealer ace you may take **even money** (1:1) instead.',
    '**Dealer** — checks for blackjack under an ace or a ten before you act, and stands on all 17s, soft 17 included.',
    '**Hit / Stand** — take another card, or keep what you have. A hand that reaches 21 stands itself.',
    '**Double down** — on a two-card 9, 10 or 11: double the stake, take exactly one card.',
    '**Split** — two cards of the same value (K-Q counts) become two hands, each at the original stake. Split aces take one card each. No re-splitting and no doubling after a split.',
    '**Insurance** — offered when the dealer shows an ace; costs half the stake and pays **2:1** if the dealer has blackjack.',
    `**Timer** — a turn left for ${TURN_IDLE_MS / 1000}s stands automatically; the insurance prompt waits ${PROMPT_MS / 1000}s and is declined if unanswered.`,
];

// ── Presentation ─────────────────────────────────────────────────────────────

/**
 * A card as text, for the embed that sits beside the table image and for any
 * client that has images turned off. U+FE0E asks for the text form of the suit
 * — without it ♥ is a colour emoji on most phones.
 */
const cardText = card => `\`${card.value}${card.suit}︎\``;
/** A hand as text cards, with the hole card shown as `??` while it is face down. */
const handText = (cards, holeHidden = false) =>
    cards.map((c, i) => (holeHidden && i === 1 ? '`??`' : cardText(c))).join(' ');

/** A signed coin amount with the currency: +💰150, −💰50. */
const signed = (currency, n) => `${n >= 0 ? '+' : '−'}${currency}${Math.abs(n).toLocaleString()}`;
/** A signed, abbreviated amount for the table image: +12.5K. */
const signedShort = n => `${n >= 0 ? '+' : '−'}${shortAmount(Math.abs(n))}`;

/** The dealer's total as shown: the up-card while the hole card is hidden, then the full label. */
function dealerLabel(s) {
    if (s.holeHidden) return `showing ${s.dealer[0].value}`;
    return totalLabel(s.dealer);
}

/** A player hand's label; a split hand's two-card 21 is not called blackjack. */
function handLabel(hand) {
    return totalLabel(hand.cards, { natural: !hand.fromSplit });
}

const RESULT_TAG = {
    blackjack: { word: 'BLACKJACK', tone: 'gold' },
    evenmoney: { word: 'EVEN MONEY', tone: 'win' },
    win:       { word: 'WIN', tone: 'win' },
    push:      { word: 'PUSH', tone: 'push' },
    lose:      { word: 'LOSE', tone: 'lose' },
    bust:      { word: 'BUST', tone: 'lose' },
};

const RESULT_TEXT = {
    blackjack: '🃏 Blackjack',
    evenmoney: '💵 Even money',
    win:       '✅ Win',
    push:      '🤝 Push',
    lose:      '❌ Lose',
    bust:      '💥 Bust',
};

/** What the canvas draws, from the game's state. */
function tableView(s) {
    const split = s.hands.length > 1;
    return {
        dealer: {
            cards: s.dealer,
            holeHidden: s.holeHidden,
            label: dealerLabel(s),
            tone: !s.holeHidden && handTotal(s.dealer) > 21 ? 'win'
                : !s.holeHidden && isNaturalBlackjack(s.dealer) ? 'lose' : 'info',
        },
        hands: s.hands.map((hand, i) => {
            let tag = null;
            if (hand.result) {
                const { word, tone } = RESULT_TAG[hand.result.outcome];
                const net = hand.result.net;
                tag = { text: split || net === 0 ? `${word}${net ? ` ${signedShort(net)}` : ''}` : signedShort(net), tone };
            } else if (hand.cards.length > 2 && handTotal(hand.cards) > 21) {
                tag = { text: 'BUST', tone: 'lose' };
            }
            return {
                cards: hand.cards,
                label: handLabel(hand),
                bet: hand.bet,
                active: s.phase === 'play' && split && i === s.active,
                tag,
            };
        }),
        banner: s.banner,
    };
}

/** The embed for one moment of the hand: narration, both sides' cards, the stake or the payout, and the record. */
function buildEmbed(interaction, s) {
    const split = s.hands.length > 1;
    const embed = new EmbedBuilder()
        .setAuthor({
            name: interaction.member?.displayName || interaction.user.username,
            iconURL: interaction.user.displayAvatarURL(),
        })
        .setColor(s.color)
        .setTitle(s.title ?? '🃏 Blackjack')
        .setTimestamp();

    const lines = [...s.narration];
    if (s.phase === 'play' && s.deadline) {
        lines.push(`-# ⏱️ Stands automatically <t:${Math.floor(s.deadline / 1000)}:R> · ⓘ Rules for the house rules`);
    }
    if (lines.length) embed.setDescription(lines.join('\n'));

    embed.addFields({ name: `🎩 Dealer · ${dealerLabel(s)}`, value: handText(s.dealer, s.holeHidden), inline: false });

    s.hands.forEach((hand, i) => {
        let name;
        if (!split) name = `🫵 You · ${handLabel(hand)}`;
        else {
            const marker = hand.result ? '' : s.phase === 'play' && i === s.active ? '▶ ' : hand.done ? '✓ ' : '⏳ ';
            name = `${marker}Hand ${i + 1} · ${handLabel(hand)}`;
        }
        const detail = split ? `\n${s.currency}${hand.bet.toLocaleString()}${hand.doubled ? ' (doubled)' : ''}` : '';
        const result = hand.result && split
            ? `\n${RESULT_TEXT[hand.result.outcome]} ${hand.result.net ? signed(s.currency, hand.result.net) : ''}`.trimEnd()
            : '';
        embed.addFields({ name, value: `${handText(hand.cards)}${detail}${result}`, inline: split });
    });

    const staked = s.hands.reduce((sum, h) => sum + h.bet, 0);
    const betValue = [`${s.currency}${staked.toLocaleString()}${!split && s.hands[0].doubled ? ' (doubled)' : ''}`];
    if (s.insurance) betValue.push(`🛡️ ${s.currency}${s.insurance.toLocaleString()} insurance`);

    if (s.payout) {
        const { returned, net } = s.payout;
        const payout = [
            `Staked ${s.currency}${(staked + s.insurance).toLocaleString()}`,
            `Returned ${s.currency}${returned.toLocaleString()}`,
            `**Net ${signed(s.currency, net)}**`,
        ];
        embed.addFields(
            { name: '💰 Payout', value: payout.join('\n'), inline: true },
            { name: '🏦 Balance', value: `${s.currency}${(s.balance ?? 0).toLocaleString()}`, inline: true },
        );
    } else {
        embed.addFields({ name: '🪙 Bet', value: betValue.join('\n'), inline: true });
    }

    const record = statsLine(s.stats);
    embed.setFooter({ text: record ? `${RULES_FOOTER}\n${record}` : RULES_FOOTER });
    return embed;
}

/** The table image described in words, for screen readers. */
function altText(s) {
    const cards = cs => cs.map(c => `${c.value}${c.suit}`).join(' ');
    const dealer = s.holeHidden ? `${cards([s.dealer[0]])} and a face-down card` : cards(s.dealer);
    const hands = s.hands.map((h, i) =>
        `${s.hands.length > 1 ? `hand ${i + 1}` : 'your hand'} ${cards(h.cards)} (${handLabel(h)})`).join('; ');
    return `Blackjack table. Dealer: ${dealer} (${dealerLabel(s)}). ${hands}.${s.banner ? ` ${s.banner.text}.` : ''}`.slice(0, 1024);
}

let renderFailureLogged = false;

/**
 * The whole message for one moment of the hand: embed, buttons and the table
 * image. The image is a nicety — if it cannot be drawn the hand is still fully
 * playable from the embed, so a render failure is logged once and dropped.
 */
async function buildPayload(interaction, s, components) {
    const embed = buildEmbed(interaction, s);
    // `attachments: []` replaces the previous frame's image rather than
    // stacking a new one beside it.
    const payload = { embeds: [embed], components, attachments: [] };
    try {
        const png = await renderTable(tableView(s));
        embed.setImage(`attachment://${IMAGE_NAME}`);
        payload.files = [new AttachmentBuilder(png, { name: IMAGE_NAME, description: altText(s) })];
    } catch (err) {
        if (!renderFailureLogged) {
            renderFailureLogged = true;
            console.error('[blackjack] table render failed; continuing without the image:', err);
        }
    }
    return payload;
}

/** A button with its emoji set as an emoji rather than typed into the label. */
function button(customId, label, style, emoji, disabled = false) {
    const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
    if (emoji) b.setEmoji(emoji);
    return b;
}

/**
 * The gates the dispatcher applies to a typed `/casino blackjack`, applied to a
 * Rebet press: the server's command policy, then the command's cooldown — the
 * same bucket, with the guild's per-role overrides — so a button is never a way
 * round a limit an admin set. The economy freeze needs no check here; it rides
 * placeWager's own filter. Returns a refusal to show, or null to deal.
 */
async function rebetGateRefusal(press, interaction, claimCooldown) {
    let guildSettings;
    try {
        guildSettings = await getGuildSettings(interaction.guild.id);
    } catch {
        return 'Could not load server settings. Try again in a moment.';
    }
    // What the dispatcher would have seen had the player typed the command.
    const asCommand = {
        user:      press.user,
        member:    press.member ?? interaction.member,
        guild:     interaction.guild,
        channelId: press.channelId ?? interaction.channelId,
        commandName: 'casino',
        options: { getSubcommand: () => 'blackjack', getSubcommandGroup: () => null },
    };
    const policy = getPolicyDecision(asCommand, guildSettings, 'casino');
    if (!policy.allowed) return policy.reason;
    // The dispatcher hands the claim down: the cooldown belongs to the
    // /casino command, which lives a layer above this game.
    return claimCooldown ? claimCooldown(asCommand, guildSettings) : null;
}

// ── The table message ────────────────────────────────────────────────────────

/**
 * Where the hand is drawn.
 *
 * A bet under the confirmation threshold plays on the command's own reply. A
 * bet over it has already spent that reply on the private "are you sure?"
 * prompt, and used to play the whole hand inside it — so the biggest hands at
 * the table were the ones nobody else could see. Those now deal onto a public
 * follow-up, and every later edit names that message.
 */
function createTable(interaction, alreadyReplied) {
    let message = null;
    let viaFollowUp = false;
    return {
        get message() { return message; },
        async show(payload) {
            if (!message) {
                if (alreadyReplied) {
                    message = await interaction.followUp(payload);
                    viaFollowUp = true;
                } else {
                    await interaction.reply(payload);
                    message = await interaction.fetchReply();
                }
                return message;
            }
            return interaction.editReply(viaFollowUp ? { ...payload, message } : payload);
        },
    };
}

// ── One hand ─────────────────────────────────────────────────────────────────

/**
 * Deals and plays one hand on `ctx.table`, whose opening stake `ctx.bet` has
 * already been taken. Returns once the hand is waiting on the player — the rest
 * runs from button collectors — or once it has settled outright.
 */
async function playHand(ctx) {
    const { interaction, table, bet, currency } = ctx;
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    const handId = newHandId();
    const gameId = `${interaction.user.id}_${Date.now()}`;
    const cid = action => `bj_${action}_${gameId}`;
    const rulesId = cid('rules');

    const deck = buildDeck();
    const s = {
        currency,
        dealer: [],
        hands: [],
        active: 0,
        holeHidden: true,
        phase: 'deal',
        insurance: 0,
        narration: [],
        title: null,
        color: FELT,
        banner: null,
        payout: null,
        balance: null,
        stats: null,
        deadline: null,
    };
    // Off the end of the deck: player, player, dealer up-card, dealer hole card.
    const opening = [deck.pop(), deck.pop()];
    s.dealer = [deck.pop(), deck.pop()];
    s.hands = [{ cards: opening, bet, done: false, doubled: false, fromSplit: false, result: null }];

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        ctx.releaseLock?.();
    };

    const render = async components => {
        try {
            const shown = await table.show(await buildPayload(interaction, s, components));
            openRules();
            return shown;
        } catch (err) {
            console.error('[blackjack] could not update the table:', err);
            return null;
        }
    };

    const rulesButton = (disabled = false) => button(rulesId, 'Rules', ButtonStyle.Secondary, 'ℹ️', disabled);
    const hand = () => s.hands[s.active];
    const canDouble = () => s.hands.length === 1 && canDoubleDown(hand().cards);
    const canSplit  = () => s.hands.length === 1 && canSplitHand(hand().cards);

    /** Hit and Stand always, Double and Split only when legal — or all greyed while the dealer plays. */
    const playRow = (disabled = false) => {
        const row = new ActionRowBuilder().addComponents(
            button(cid('hit'), 'Hit', ButtonStyle.Primary, '🎯', disabled),
            button(cid('stand'), 'Stand', ButtonStyle.Secondary, '✋', disabled),
        );
        if (!disabled && canDouble()) row.addComponents(button(cid('double'), 'Double', ButtonStyle.Success, '⚡'));
        if (!disabled && canSplit())  row.addComponents(button(cid('split'), 'Split', ButtonStyle.Success, '✂️'));
        row.addComponents(rulesButton(disabled));
        return [row];
    };

    const showRules = press => press.reply({
        embeds: [new EmbedBuilder().setColor(FELT).setTitle('🃏 House rules').setDescription(RULES.join('\n\n'))],
        flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    /** The owner's buttons, which answer only the owner. */
    const ownerFilter = ids => ownedBy(interaction.user.id, i => ids.includes(i.customId), "This isn't your hand.");

    /**
     * Rules answers anyone at the table, so it has a collector of its own, open
     * for the life of the hand. Sharing the turn collector would let a
     * bystander's press reset that collector's idle timer, and with it keep an
     * abandoned hand — and the player's casino lock — from ever auto-standing.
     * The ceiling is a backstop for a hand that never reaches its Rebet window,
     * whose end is what normally closes this.
     */
    let rulesCollector = null;
    const openRules = () => {
        if (rulesCollector || !table.message) return;
        rulesCollector = table.message.createMessageComponentCollector({
            filter: i => i.customId === rulesId,
            time: TABLE_TTL_MS,
        });
        rulesCollector.on('collect', showRules);
    };
    const closeRules = () => rulesCollector?.stop('closed');

    // ── Settlement ───────────────────────────────────────────────────────────

    let settling = null;
    /** Runs the settlement exactly once, however many paths reach for it. */
    const settleOnce = opts => {
        settling ??= settle(opts)
            .catch(err => console.error('[blackjack] settlement failed:', err))
            .finally(release);
        return settling;
    };

    /**
     * Everything after the last decision: the dealer's turn, the payout, the
     * record and the result screen.
     *
     * @param {object} opts
     * @param {'natural'|'evenmoney'|'dealer-natural'|'played'} opts.kind
     * @param {boolean} [opts.timedOut]
     */
    async function settle({ kind, timedOut = false }) {
        s.phase = 'settle';
        s.deadline = null;
        const liveHands = s.hands.filter(h => handTotal(h.cards) <= 21);

        if (kind === 'played') {
            // What the last press did stays on screen above the dealer's turn.
            if (timedOut) s.narration = ['⏱️ Time\'s up — standing on what you have.'];
            s.holeHidden = false;
            s.narration.push(`Dealer turns over ${cardText(s.dealer[1])} · **${totalLabel(s.dealer)}**`);
            // Nothing left to beat: every hand busted, so the dealer does not draw.
            if (liveHands.length) {
                await render(playRow(true));
                await delay(REVEAL_MS);
                while (handTotal(s.dealer) < 17) {
                    const card = deck.pop();
                    s.dealer.push(card);
                    s.narration.push(`Dealer draws ${cardText(card)} · **${totalLabel(s.dealer)}**`);
                    await render(playRow(true));
                    await delay(DEALER_STEP_MS);
                }
            }
        } else {
            s.holeHidden = false;
        }

        // Table odds and nothing on top (#873, pass 26). Blackjack returns
        // about 99.9% under basic strategy, so there is no room for a coin
        // booster (a 2× one paid back 146%) or a luck save (the charm's 20%
        // and the streak's 25% loss-to-push paid 111%). With neither, the
        // settlement reads nothing from the database before it pays.

        const dealerTotal   = handTotal(s.dealer);
        const dealerNatural = isNaturalBlackjack(s.dealer);
        let credit = 0;

        for (const h of s.hands) {
            let outcome;
            let handCredit;
            if (kind === 'natural') {
                outcome = dealerNatural ? 'push' : 'blackjack';
                handCredit = dealerNatural ? h.bet : naturalBlackjackCredit(h.bet);
            } else if (kind === 'evenmoney') {
                outcome = 'evenmoney';
                handCredit = evenMoneyCredit(h.bet);
            } else {
                outcome = settleHand(handTotal(h.cards), dealerTotal, { dealerNatural });
                handCredit = blackjackHandCredit(outcome, h.bet);
            }
            h.result = { outcome, net: handCredit - h.bet };
            credit += handCredit;
        }

        let insuranceLine = null;
        if (s.insurance) {
            if (dealerNatural) {
                credit += insuranceCredit(s.insurance);
                insuranceLine = `🛡️ Insurance pays ${signed(currency, insuranceProfit(s.insurance))}`;
            } else {
                insuranceLine = `🛡️ Insurance lost (${signed(currency, -s.insurance)})`;
            }
        }

        const staked = s.hands.reduce((sum, h) => sum + h.bet, 0) + s.insurance;
        const net = credit - staked;

        const phase = { natural: dealerNatural ? 'natural-push' : 'natural', evenmoney: 'even-money', 'dealer-natural': 'peek-insurance', played: 'settle' }[kind];
        const paid = await payHand(userFilter, credit, { game: 'blackjack', handId, phase });
        s.balance = await settledBalance(userFilter, paid.balance);
        s.payout = { returned: credit, net };
        s.stats = await recordBlackjackRound(userFilter, { net, natural: kind === 'natural' || kind === 'evenmoney' });

        headline(kind, net, dealerTotal, dealerNatural);
        if (insuranceLine) s.narration.push(insuranceLine);
        const note = payoutNote(paid).trim();
        if (note) s.narration.push(note);

        release();
        await render(rebetRows());
        openRebet();
    }

    /** The title, colour, banner and closing lines for a settled hand. */
    function headline(kind, net, dealerTotal, dealerNatural) {
        const split = s.hands.length > 1;
        const outcome = s.hands[0].result.outcome;
        const lines = [...s.narration];
        const amount = net ? ` ${signed(currency, net)}` : '';
        let title, color, banner, copy;

        if (kind === 'natural' && dealerNatural) {
            title = '🤝 Push — both have blackjack'; color = COLORS.WARN; banner = { text: 'PUSH', tone: 'push' };
            copy = 'Two naturals. Your stake comes back.';
        } else if (kind === 'natural') {
            title = `🃏 Blackjack!${amount}`; color = COLORS.PRIZE; banner = { text: 'BLACKJACK!', tone: 'gold' };
            copy = 'Perfect hand. Pays 3:2.';
        } else if (kind === 'evenmoney') {
            title = `💵 Even money${amount}`; color = COLORS.SUCCESS; banner = { text: 'EVEN MONEY', tone: 'win' };
            copy = 'Guaranteed 1:1, whatever the dealer had.';
            lines.push(`Dealer had ${handText(s.dealer)} · **${totalLabel(s.dealer)}**`);
        } else if (kind === 'dealer-natural') {
            title = '🏠 Dealer blackjack'; color = COLORS.ERROR; banner = { text: 'DEALER BLACKJACK', tone: 'lose' };
            copy = `The dealer turns over ${cardText(s.dealer[1])}. Blackjack — the hand is over before it starts.`;
        } else if (split) {
            color = net > 0 ? COLORS.SUCCESS : net === 0 ? COLORS.WARN : COLORS.ERROR;
            title = net > 0 ? `✅ Split — you come out ahead${amount}` : net === 0 ? '🤝 Split — you break even' : `❌ Split — the dealer takes it${amount}`;
            banner = dealerTotal > 21 ? { text: 'DEALER BUSTS', tone: 'win' }
                : { text: net > 0 ? 'YOU WIN' : net === 0 ? 'EVEN' : 'DEALER WINS', tone: net > 0 ? 'win' : net === 0 ? 'push' : 'lose' };
            copy = s.hands.map((h, i) => `Hand ${i + 1}: ${RESULT_TEXT[h.result.outcome]}${h.result.net ? ` ${signed(currency, h.result.net)}` : ''}`).join('\n');
        } else if (outcome === 'bust') {
            title = `💥 Bust${amount}`; color = COLORS.ERROR; banner = { text: 'BUST', tone: 'lose' };
            copy = randomFrom(BJ_BUST_LINES);
        } else if (outcome === 'win') {
            title = `✅ You win${amount}`; color = COLORS.SUCCESS;
            banner = dealerTotal > 21 ? { text: 'DEALER BUSTS', tone: 'win' } : { text: 'YOU WIN', tone: 'win' };
            copy = randomFrom(BJ_WIN_LINES);
        } else if (outcome === 'push') {
            title = '🤝 Push'; color = COLORS.WARN; banner = { text: 'PUSH', tone: 'push' };
            copy = randomFrom(BJ_PUSH_LINES);
        } else {
            title = `❌ Dealer wins${amount}`; color = COLORS.ERROR; banner = { text: 'DEALER WINS', tone: 'lose' };
            copy = randomFrom(BJ_LOSE_LINES);
        }

        s.title = title;
        s.color = color;
        s.banner = banner;
        s.narration = lines.length ? [...lines, ''] : [];
        s.narration.push(...copy.split('\n').map(line => `> ${line}`));
    }

    // ── Rebet ────────────────────────────────────────────────────────────────

    const rebetAmounts = () => {
        const amounts = [{ key: 'rebet', amount: bet, label: `Rebet ${shortAmount(bet)}`, emoji: '🔁', style: ButtonStyle.Primary }];
        if (bet * 2 <= MAX_BET) amounts.push({ key: 'rebet2', amount: bet * 2, label: `2× · ${shortAmount(bet * 2)}`, emoji: '⏫', style: ButtonStyle.Secondary });
        const half = Math.floor(bet / 2);
        if (half >= MIN_BET) amounts.push({ key: 'rebethalf', amount: half, label: `½ · ${shortAmount(half)}`, emoji: '⏬', style: ButtonStyle.Secondary });
        return amounts;
    };

    const rebetRows = () => [new ActionRowBuilder().addComponents(
        ...rebetAmounts().map(r => button(cid(r.key), r.label, r.style, r.emoji)),
        rulesButton(),
    )];

    function openRebet() {
        const message = table.message;
        if (!message) return;
        const amounts = rebetAmounts();
        const ids = amounts.map(r => cid(r.key));
        let taken = false;
        const collector = message.createMessageComponentCollector({ filter: ownerFilter(ids), idle: REBET_IDLE_MS });

        collector.on('collect', async press => {
            if (taken) return press.deferUpdate().catch(() => {});
            taken = true;
            const next = amounts.find(r => cid(r.key) === press.customId).amount;

            const age = Date.now() - (interaction.createdTimestamp ?? Date.now());
            if (age > TABLE_TTL_MS) {
                collector.stop('expired');
                return press.reply({ content: '🃏 This table has closed — run `/casino blackjack` to deal a fresh one.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }

            // A new hand answers to the settings as they are now, not as they
            // were when the first one was typed.
            const refused = await replayRefusal(interaction.guild.id, next);
            if (refused) {
                collector.stop('refused');
                return press.reply({ content: refused, flags: MessageFlags.Ephemeral }).catch(() => {});
            }

            const gated = await rebetGateRefusal(press, interaction, ctx.claimCooldown);
            if (gated) {
                taken = false;
                return press.reply({ content: gated, flags: MessageFlags.Ephemeral }).catch(() => {});
            }

            const debited = await placeWager(userFilter, next, { onWager: ctx.onWager });
            if (!debited) {
                taken = false;
                return press.reply({ content: `❌ Not enough ${currency} for a ${currency}${next.toLocaleString()} hand.`, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            await press.deferUpdate().catch(() => {});
            collector.stop('rebet');
            // The casino lock belongs to the command, and the command's hand is
            // over; a rebet is covered by placeWager's atomic debit, as every
            // other game's replay is.
            await playHand({ ...ctx, bet: next, user: debited, releaseLock: null });
        });

        collector.on('end', (_, reason) => {
            closeRules();
            if (reason === 'rebet') return;
            table.show({ components: [] }).catch(() => {});
        });
    }

    // ── The deal ─────────────────────────────────────────────────────────────

    const up = s.dealer[0];
    const playerNatural = isNaturalBlackjack(opening);
    let insuranceShort = false;

    // Insurance — or even money, for a player holding blackjack — is offered on
    // every ace, before the dealer peeks. Offered only when the dealer *had*
    // blackjack, the prompt itself told the player the hole card (#873).
    if (up.value === 'A') {
        const cost = halfBet(bet);
        const offer = playerNatural ? 'evenmoney' : cost > 0 ? 'insurance' : null;
        if (offer) {
            const [yes, no] = offer === 'evenmoney' ? ['evenmoney', 'noeven'] : ['insurance', 'noins'];
            s.phase = 'prompt';
            s.narration = offer === 'evenmoney'
                ? ['🃏 **Blackjack!** Dealer shows an Ace.', `Take **even money** now (${signed(currency, bet)}, guaranteed), or play on for 3:2 and risk a push?`]
                : [`🛡️ Insurance? (${currency}${cost.toLocaleString()}) — Dealer shows an Ace`, '-# Pays 2:1 if the dealer has blackjack.'];
            const row = new ActionRowBuilder().addComponents(
                offer === 'evenmoney'
                    ? button(cid(yes), 'Even Money', ButtonStyle.Success, '💵')
                    : button(cid(yes), `Insurance (${shortAmount(cost)})`, ButtonStyle.Primary, '🛡️'),
                button(cid(no), offer === 'evenmoney' ? 'Play for 3:2' : 'No Insurance', ButtonStyle.Secondary),
                rulesButton(),
            );
            await render([row]);

            let answer = null;
            if (table.message) {
                try {
                    const press = await table.message.awaitMessageComponent({
                        filter: ownerFilter([cid(yes), cid(no)]),
                        time: PROMPT_MS,
                    });
                    await press.deferUpdate().catch(() => {});
                    answer = press.customId;
                } catch {
                    // Unanswered: declined.
                }
            }

            s.narration = [];
            if (answer === cid('evenmoney')) {
                await settleOnce({ kind: 'evenmoney' });
                return;
            }
            if (answer === cid('insurance')) {
                const paid = await placeWager(userFilter, cost);
                if (paid) s.insurance = cost;
                else insuranceShort = true;
            }
        }
    }

    // The peek, and the naturals it settles.
    const dealerNatural = dealerPeeks(up) && isNaturalBlackjack(s.dealer);
    if (playerNatural) {
        s.narration = [];
        await settleOnce({ kind: 'natural' });
        return;
    }
    if (dealerNatural) {
        if (insuranceShort) s.narration = ['⚠️ Not enough balance for insurance'];
        else s.narration = [];
        await settleOnce({ kind: 'dealer-natural' });
        return;
    }

    // ── The player's turn ────────────────────────────────────────────────────

    s.phase = 'play';
    s.narration = [];
    if (dealerPeeks(up)) s.narration.push(`🔍 Dealer checks under the ${up.value === 'A' ? 'ace' : 'ten'} — no blackjack.`);
    if (s.insurance) s.narration.push('🛡️ No dealer blackjack — insurance lost · Your turn');
    else if (insuranceShort) s.narration.push('⚠️ Not enough balance for insurance · Your turn');
    else s.narration.push('🎲 Your turn');
    s.deadline = Date.now() + TURN_IDLE_MS;
    await render(playRow());

    if (!table.message) {
        // The table never reached Discord. The stake is taken, so the hand is
        // stood and settled rather than abandoned.
        await settleOnce({ kind: 'played', timedOut: true });
        return;
    }

    const actionIds = ['hit', 'stand', 'double', 'split'].map(cid);
    const collector = table.message.createMessageComponentCollector({
        filter: ownerFilter(actionIds),
        idle: TURN_IDLE_MS,
    });

    // Presses are handled one at a time. discord.js does not wait for one
    // `collect` handler before starting the next, so a double-click on Double
    // used to run two double-downs side by side — two stakes taken, one paid —
    // and a Hit racing a Stand could add a card mid-settlement.
    let busy = false;

    collector.on('collect', async press => {
        if (busy || s.phase !== 'play') return press.deferUpdate().catch(() => {});
        busy = true;
        try {
            await press.deferUpdate().catch(() => {});
            await act(press.customId);
        } catch (err) {
            console.error('[blackjack] action failed:', err);
        } finally {
            busy = false;
        }
    });

    collector.on('end', (_, reason) => {
        if (reason === 'done' || s.phase !== 'play') return;
        for (const h of s.hands) h.done = true;
        settleOnce({ kind: 'played', timedOut: true });
    });

    /** Moves play to the next unfinished hand; false once there is none. */
    function advance() {
        const next = s.hands.findIndex(h => !h.done);
        if (next === -1) return false;
        s.active = next;
        return true;
    }

    /** A hand that reaches 21 has nothing left to decide, so it stands itself. */
    function finishIfDone(h) {
        const total = handTotal(h.cards);
        if (total >= 21) h.done = true;
        return total;
    }

    /** Applies one of the owner's actions to the hand in play, then moves play on or settles. */
    async function act(customId) {
        const h = hand();
        const prefix = s.hands.length > 1 ? `Hand ${s.active + 1}: ` : '';
        s.narration = [];

        if (customId === cid('hit')) {
            const card = deck.pop();
            h.cards.push(card);
            const total = finishIfDone(h);
            s.narration.push(`${prefix}You draw ${cardText(card)} · **${handLabel(h)}**${total > 21 ? ' 💥' : total === 21 ? ' — standing on 21' : ''}`);
        } else if (customId === cid('stand')) {
            h.done = true;
            s.narration.push(`${prefix}You stand on **${handLabel(h)}**`);
        } else if (customId === cid('double')) {
            if (!canDouble()) return render(playRow());
            const paid = await placeWager(userFilter, h.bet);
            if (!paid) {
                s.narration.push('⚠️ Not enough balance for double down · Your turn');
                s.deadline = Date.now() + TURN_IDLE_MS;
                return render(playRow());
            }
            h.bet *= 2;
            h.doubled = true;
            const card = deck.pop();
            h.cards.push(card);
            h.done = true;
            s.narration.push(`⚡ Doubled to ${currency}${h.bet.toLocaleString()} — one card: ${cardText(card)} · **${handLabel(h)}**`);
        } else if (customId === cid('split')) {
            if (!canSplit()) return render(playRow());
            const paid = await placeWager(userFilter, bet);
            if (!paid) {
                s.narration.push('⚠️ Not enough balance for split · Your turn');
                s.deadline = Date.now() + TURN_IDLE_MS;
                return render(playRow());
            }
            const [a, b] = h.cards;
            s.hands = [
                { cards: [a, deck.pop()], bet, done: false, doubled: false, fromSplit: true, result: null },
                { cards: [b, deck.pop()], bet, done: false, doubled: false, fromSplit: true, result: null },
            ];
            if (a.value === 'A') {
                s.hands.forEach(sh => { sh.done = true; });
                s.narration.push('✂️ Split aces — one card each.');
            } else {
                s.hands.forEach(finishIfDone);
                s.narration.push(`✂️ Split into two hands of ${currency}${bet.toLocaleString()}.`);
            }
        } else {
            return undefined;
        }

        if (!advance()) {
            collector.stop('done');
            return settleOnce({ kind: 'played' });
        }
        s.narration.push(s.hands.length > 1 ? `▶ Playing Hand ${s.active + 1}` : '🎲 Your turn');
        s.deadline = Date.now() + TURN_IDLE_MS;
        return render(playRow());
    }
}

// ── The command ──────────────────────────────────────────────────────────────

module.exports = {
    name: 'blackjack',
    description: 'Play blackjack against the dealer',
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (min ${MIN_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)),

    async execute(interaction, { releaseLock, onWager, claimCooldown } = {}) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const currency = guildSettings?.economy?.currency || '💰';
        const bet      = interaction.options.getInteger('bet');
        const refusal  = casinoRefusal(guildSettings, bet);
        if (refusal) {
            releaseLock?.();
            return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
        }

        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });

        if (user.balance < bet) {
            releaseLock?.();
            return interaction.reply({ content: `You don't have enough ${currency}. Your balance: **${currency}${user.balance.toLocaleString()}**`, flags: MessageFlags.Ephemeral });
        }

        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, user.balance, 'Blackjack', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }

        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

        // The opening wager, and the only debit of this hand that reports one:
        // insurance, a split and a double down below are all further money on
        // the same hand, not another game played.
        const debited = await placeWager(userFilter, bet, { onWager });
        if (!debited) {
            releaseLock?.();
            const content = `❌ Not enough ${currency}! Your balance may have changed.`;
            // After a confirmation prompt the interaction has already been
            // answered, and a second reply() throws.
            return alreadyReplied
                ? interaction.editReply({ content, embeds: [], components: [] })
                : interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }

        const table = createTable(interaction, alreadyReplied);
        return playHand({ interaction, table, bet, currency, user: debited, guildSettings, releaseLock, onWager, claimCooldown });
    },
};
