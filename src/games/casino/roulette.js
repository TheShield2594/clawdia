const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    AttachmentBuilder,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { placeWager } = require('../../utils/placeWager');
const { confirmBet } = require('../../utils/confirmBet');
const { delay } = require('../../utils/delay');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { getPolicyDecision } = require('../../utils/commandPolicy');
const { casinoRefusal, replayRefusal } = require('./betGuard');
const { casinoLuck } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
const { newHandId, payHand, payoutNote, settledBalance } = require('./payout');
const { rouletteSettlement, rouletteCharmSettlement } = require('./settlement');
const {
    WHEEL_ORDER, WHEEL_INDEX, POCKETS, BETS,
    colorOf, pocketEmoji, describeBet, shortBet, betOdds, coveredNumbers, spin, nearMiss, spinFrames, pocketUnderBall,
} = require('./rouletteWheel');
const { renderRouletteTable } = require('./rouletteTable');
const { shortAmount } = require('./tableArt');

const MIN_BET    = 10;
const MAX_BET    = 1_000_000_000;
const IMAGE_NAME = 'roulette.jpg';
const HISTORY_KEPT  = 15;
const REPLAY_WINDOW = 90_000;
const FOOTER = 'European roulette  •  Single zero  •  2.7% house edge';

// ── Text ─────────────────────────────────────────────────────────────────────

function pocketLabel(n) {
    return `${pocketEmoji(n)} ${n}`;
}

/**
 * The seven pockets around `number` in wheel order, the middle one marked —
 * the wheel in words, for when the image cannot be drawn.
 */
function pocketStrip(number) {
    const at = WHEEL_INDEX[number];
    const parts = [];
    for (let offset = -3; offset <= 3; offset++) {
        const n = WHEEL_ORDER[((at + offset) % POCKETS + POCKETS) % POCKETS];
        parts.push(offset === 0 ? `**▶ ${pocketLabel(n)} ◀**` : pocketLabel(n));
    }
    return parts.join('  ');
}

function historyText(history) {
    if (!history?.length) return '';
    return [...history].reverse().slice(0, 12).map(pocketLabel).join('  ');
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

const signed = n => `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString()}`;

/**
 * How a spin came out, in the three shapes it can take. Shared by the embed
 * and the banner on the image so the two never disagree.
 */
function outcomeOf({ won, charmSaved, betKey }) {
    if (won) return betKey === 'number' ? 'jackpot' : 'win';
    return charmSaved ? 'charm' : 'loss';
}

function bannerFor(outcome, profit, credit) {
    if (outcome === 'jackpot') return { text: `STRAIGHT UP!  ${signed(profit)}`, tone: 'gold' };
    if (outcome === 'win')     return { text: `WIN  ${signed(profit)}`,         tone: 'win' };
    if (outcome === 'charm')   return { text: `LUCKY CHARM  +${credit.toLocaleString()} BACK`, tone: 'gold' };
    return { text: `LOSS  ${signed(profit)}`, tone: 'lose' };
}

function spinningEmbed({ interaction, betKey, target, bet, withImage, strip }) {
    const embed = new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setColor(COLORS.PRIZE)
        .setTitle('🎡 Roulette')
        .setDescription(
            (withImage ? '' : `${strip}\n\n`) +
            `*The ball is in play — no more bets.*\n` +
            `🎯 **${describeBet(betKey, target)}** (${betOdds(betKey)})  ·  💰 **${bet.toLocaleString()}**`,
        )
        .setFooter({ text: FOOTER });
    if (withImage) embed.setImage(`attachment://${IMAGE_NAME}`);
    return embed;
}

function resultEmbed({ interaction, spinState, balance, history, note, withImage }) {
    const { result, betKey, target, bet, profit, credit, outcome } = spinState;
    const betText = `**${describeBet(betKey, target)}**`;
    const lines = [];
    if (outcome === 'jackpot') lines.push(`💎 **Straight up!** ${betText} hits for **${signed(profit)}** coins.`);
    else if (outcome === 'win') lines.push(`🏆 ${betText} wins — **${signed(profit)}** coins.`);
    else if (outcome === 'charm') lines.push(`🍀 ${betText} loses, but your **Lucky Charm** hands back **${credit.toLocaleString()}** — net **${signed(profit)}**.`);
    else lines.push(`💀 ${betText} loses — **${signed(profit)}** coins.`);

    const close = nearMiss(result, betKey, target);
    if (close !== null) lines.push(`😮 So close — **${close}** sits right next to **${result}** on the wheel.`);
    if (result === 0 && outcome !== 'jackpot') lines.push('🟢 *Zero — every outside bet loses.*');
    if (note) lines.push(note.trim());
    if (!withImage) {
        lines.unshift(pocketStrip(result), '');
        const recent = historyText(history);
        if (recent) lines.push('', `📊 Recent: ${recent}`);
    }

    const color = outcome === 'jackpot' ? COLORS.PRIZE
        : outcome === 'win' ? COLORS.SUCCESS
        : outcome === 'charm' ? COLORS.WARN
        : COLORS.ERROR;

    const embed = new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setColor(color)
        .setTitle(`🎡 Roulette — ${pocketLabel(result)}`)
        .setDescription(lines.join('\n'))
        .addFields(
            { name: '🎯 Bet',     value: `${describeBet(betKey, target)} · ${betOdds(betKey)} · ${bet.toLocaleString()}`, inline: true },
            { name: '💰 Balance', value: `${balance.toLocaleString()} coins`, inline: true },
        )
        .setFooter({ text: FOOTER })
        .setTimestamp();
    if (withImage) embed.setImage(`attachment://${IMAGE_NAME}`);
    return embed;
}

/** The image described in words, for screen readers. */
function altText({ result, betKey, target, outcome }) {
    if (result === null) return `Roulette wheel spinning. Bet: ${describeBet(betKey, target)}.`;
    return `Roulette wheel. The ball landed on ${result} ${colorOf(result)}. Bet: ${describeBet(betKey, target)} — ${outcome === 'loss' ? 'lost' : outcome === 'charm' ? 'lost, Lucky Charm refund' : 'won'}.`;
}

let renderFailureLogged = false;

/**
 * The table image as an attachment, or null when it can't be drawn. The image
 * is a nicety: the embed says everything in words too, so a render failure is
 * logged once and the game plays on without it.
 */
async function tableImage(view, alt) {
    try {
        const jpg = await renderRouletteTable(view);
        return new AttachmentBuilder(jpg, { name: IMAGE_NAME, description: alt.slice(0, 1024) });
    } catch (err) {
        if (!renderFailureLogged) {
            renderFailureLogged = true;
            console.error('[roulette] table render failed; continuing without the image:', err);
        }
        return null;
    }
}

// ── Where the spin is drawn ──────────────────────────────────────────────────

/**
 * The message a spin plays on.
 *
 * `ix` is the interaction that started this spin — the command, or the button
 * press that asked for another. It has already been acknowledged: deferred
 * (a command's reply, or the press's own message) or answered with the private
 * "are you sure?" prompt for a large bet.
 *
 * In the second case the reply is that private prompt, and the game used to
 * spin inside it — so the biggest bets at the table were the ones nobody else
 * could see. Those now open a public follow-up, and every later edit names it.
 *
 * Every spin edits through its own interaction, not the original command's, so
 * a long run of "Spin Again" never outlives the fifteen-minute token that edits
 * a reply.
 */
function createSurface(ix, prompted) {
    let message = null;
    return {
        async show(payload) {
            if (prompted && !message) {
                message = await ix.followUp(payload);
                return message;
            }
            const shown = await ix.editReply(message ? { ...payload, message } : payload);
            message ??= shown;
            return shown;
        },
    };
}

// ── The next spin ────────────────────────────────────────────────────────────

/** The bets offered in the "change bet" menu: everything the table takes. */
function rebetMenu(customId, betKey, target) {
    const options = Object.entries(BETS)
        .filter(([key]) => key !== 'number' || target !== null)
        .map(([key, def]) => ({
            label: key === 'number' ? `Straight #${target} (35:1)` : `${def.label} (${def.payout}:1)`,
            value: key,
            default: key === betKey,
        }));
    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('🎯 Change bet and spin…')
        .addOptions(options);
}

function replayRows(ids, { betKey, target, bet }) {
    const buttons = [
        new ButtonBuilder().setCustomId(ids.replay).setLabel(`Spin Again · ${shortAmount(bet)}`).setEmoji('🎡').setStyle(ButtonStyle.Primary),
    ];
    if (Math.floor(bet / 2) >= MIN_BET) {
        buttons.push(new ButtonBuilder().setCustomId(ids.half).setLabel(`½ · ${shortAmount(Math.floor(bet / 2))}`).setStyle(ButtonStyle.Secondary));
    }
    if (bet * 2 <= MAX_BET) {
        buttons.push(new ButtonBuilder().setCustomId(ids.double).setLabel(`2× · ${shortAmount(bet * 2)}`).setStyle(ButtonStyle.Secondary));
    }
    return [
        new ActionRowBuilder().addComponents(buttons),
        new ActionRowBuilder().addComponents(rebetMenu(ids.rebet, betKey, target)),
    ];
}

/**
 * The gates the dispatcher applies to a typed `/casino roulette`, applied to a
 * replay press: the server's command policy, then the command's cooldown, so
 * a button is never a way round a limit an admin set. Returns a refusal to
 * show, or null to spin.
 */
async function replayGateRefusal(press, interaction, claimCooldown) {
    let settings;
    try {
        settings = await getGuildSettings(interaction.guild.id);
    } catch {
        return 'Could not load server settings. Try again in a moment.';
    }
    const asCommand = {
        user:      press.user,
        member:    press.member ?? interaction.member,
        guild:     interaction.guild,
        channelId: press.channelId ?? interaction.channelId,
        commandName: 'casino',
        options: { getSubcommand: () => 'roulette', getSubcommandGroup: () => null },
    };
    const policy = getPolicyDecision(asCommand, settings, 'casino');
    if (!policy.allowed) return policy.reason;
    return claimCooldown ? claimCooldown(asCommand, settings) : null;
}

// ── The command ──────────────────────────────────────────────────────────────

module.exports = {
    name: 'roulette',
    description: 'Bet on Red/Black, Odd/Even, dozens, columns, or a specific number.',
    cooldown: 5,
    configure: sub => sub
        .addStringOption(opt =>
            opt.setName('bet')
                .setDescription('What to bet on')
                .setRequired(true)
                .addChoices(
                    { name: 'Red (1:1)',               value: 'red'    },
                    { name: 'Black (1:1)',              value: 'black'  },
                    { name: 'Odd (1:1)',                value: 'odd'    },
                    { name: 'Even (1:1)',               value: 'even'   },
                    { name: 'Low 1–18 (1:1)',           value: 'low'    },
                    { name: 'High 19–36 (1:1)',         value: 'high'   },
                    { name: '1st Dozen 1–12 (2:1)',     value: 'dozen1' },
                    { name: '2nd Dozen 13–24 (2:1)',    value: 'dozen2' },
                    { name: '3rd Dozen 25–36 (2:1)',    value: 'dozen3' },
                    { name: 'Column 1 (2:1)',           value: 'col1'   },
                    { name: 'Column 2 (2:1)',           value: 'col2'   },
                    { name: 'Column 3 (2:1)',           value: 'col3'   },
                    { name: 'Straight Number (35:1)',   value: 'number' },
                ))
        .addIntegerOption(opt =>
            opt.setName('amount')
                .setDescription(`Coins to wager (min ${MIN_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true))
        .addIntegerOption(opt =>
            opt.setName('number')
                .setDescription('Required when betting "Straight Number" — choose 0–36.')
                .setMinValue(0)
                .setMaxValue(36)
                .setRequired(false)),

    async execute(interaction, { releaseLock, onWager, claimCooldown } = {}) {
        if (!interaction.guild) {
            releaseLock?.();
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const betKey = interaction.options.getString('bet');
        const bet    = interaction.options.getInteger('amount');
        const target = interaction.options.getInteger('number');

        if (betKey === 'number' && target === null) {
            releaseLock?.();
            return interaction.reply({
                content: 'You must provide a `number` (0–36) when betting on a straight number.',
                flags: MessageFlags.Ephemeral,
            });
        }
        // A number on any other bet used to be dropped without a word, and the
        // player who typed `bet:Red number:17` thought they were on 17.
        if (betKey !== 'number' && target !== null) {
            releaseLock?.();
            return interaction.reply({
                content: `\`number\` only applies to a **Straight Number** bet. Pick \`bet: Straight Number\` to play #${target}, or leave \`number\` out to play ${BETS[betKey].label}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const refusal = casinoRefusal(guildSettings, bet);
        if (refusal) {
            releaseLock?.();
            return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
        }
        const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        const wallet = user?.balance ?? 0;
        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, wallet, 'Roulette', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }
        if (!alreadyReplied) await interaction.deferReply();

        await playRoulette({
            interaction,
            surface: createSurface(interaction, alreadyReplied),
            betKey, bet, target, guildSettings,
            releaseLock, onWager, claimCooldown,
        });
    },
};

// ── One spin ─────────────────────────────────────────────────────────────────

/**
 * Takes the stake, decides and pays the spin, then shows it.
 *
 * The coins settle *before* the wheel is drawn. The result is decided the
 * moment the ball is thrown, so there is nothing for the animation to wait
 * for — and paying afterwards meant a restart during the five seconds of
 * spinning took the stake and paid nothing, winners included.
 *
 * `releaseLock` is the command's casino lock, released once the spin has been
 * shown. A replay passes none: it is a new hand with its own atomic debit.
 */
async function playRoulette(ctx) {
    const { interaction, surface, betKey, bet, target, releaseLock, onWager } = ctx;
    const handId = newHandId();
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let debited = null;
    let settled = false;
    let spinState = null;
    let balance = null;
    let history = [];

    try {
        await User.findOneAndUpdate(
            userFilter,
            { $setOnInsert: { ...userFilter, balance: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        debited = await placeWager(userFilter, bet, { onWager });
        if (!debited) {
            releaseLock?.();
            return surface.show({
                content: `❌ Not enough coins to wager **${bet.toLocaleString()}**.`,
                embeds: [], components: [], attachments: [],
            });
        }

        // ── Decide and pay ──
        const betDef = BETS[betKey];
        const result = spin();
        const won = betDef.matches(result, target);
        // Lucky Charm: a slice of a lost stake back, sometimes. Never a second
        // spin — see rouletteCharmSettlement for why. How often is CASINO_LUCK's.
        const { charm } = casinoLuck('roulette', debited, bet);
        const charmSaved = !won && charm > 0 && Math.random() < charm;
        const { profit, credit } = charmSaved
            ? rouletteCharmSettlement(bet)
            : rouletteSettlement(bet, betDef.payout, won);

        const paid = await payHand(userFilter, credit, { game: 'roulette', handId, phase: 'settle' });
        settled = true;
        spinState = { result, won, charmSaved, betKey, target, bet, profit, credit, outcome: outcomeOf({ won, charmSaved, betKey }), note: payoutNote(paid) };
        balance = await settledBalance(userFilter, paid.balance);

        // The server's table history, this spin included. Read back in the same
        // round trip that writes it.
        const guildDoc = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $push: { 'casinoStats.rouletteHistory': { $each: [result], $slice: -HISTORY_KEPT } } },
            { new: true, projection: { casinoStats: 1 } },
        ).catch(() => null);
        history = guildDoc?.casinoStats?.rouletteHistory ?? [result];
        const before = history.slice(0, -1);

        // ── The spin ──
        const frames = spinFrames(result);
        const covered = coveredNumbers(betKey, target);
        const view = (frame, final) => ({
            frame,
            result: final ? result : null,
            betLabel: shortBet(betKey, target),
            odds: betOdds(betKey),
            bet,
            covered,
            history: final ? history : before,
            banner: final ? bannerFor(spinState.outcome, profit, credit) : null,
        });
        const framePayload = async i => {
            const final = i === frames.length - 1;
            const image = await tableImage(view(frames[i], final), altText({ ...spinState, result: final ? result : null }));
            if (final) return image;
            // Without an image, the frames still turn: a strip of pockets
            // around wherever the ball is passing.
            return {
                embeds: [spinningEmbed({ interaction, betKey, target, bet, withImage: !!image, strip: pocketStrip(pocketUnderBall(frames[i])) })],
                files: image ? [image] : [],
                attachments: [],
                // Also clears the last spin's buttons off a replayed message, so
                // nobody can press a button no collector is listening to.
                components: [],
                content: null,
            };
        };

        let next = framePayload(0);
        for (let i = 0; i < frames.length - 1; i++) {
            const payload = await next;
            await surface.show(payload).catch(() => {});
            next = framePayload(i + 1);
            await delay(frames[i].holdMs);
        }
        const finalImage = await next;

        // ── The result ──
        const nonce = `${interaction.id}_${Date.now()}`;
        const ids = {
            replay: `roulette_replay_${nonce}`,
            half:   `roulette_half_${nonce}`,
            double: `roulette_double_${nonce}`,
            rebet:  `roulette_rebet_${nonce}`,
        };
        const msg = await surface.show({
            content: null,
            embeds: [resultEmbed({ interaction, spinState, balance, history, note: spinState.note, withImage: !!finalImage })],
            files: finalImage ? [finalImage] : [],
            attachments: [],
            components: replayRows(ids, spinState),
        });
        releaseLock?.();

        armReplay(ctx, msg, surface, ids);
    } catch (err) {
        console.error('[Roulette] error:', err);
        releaseLock?.();
        if (settled) {
            // The coins are right; only the showing failed. Say what happened
            // in words rather than "something went wrong" over a paid spin.
            await surface.show({
                content: null,
                embeds: [resultEmbed({ interaction, spinState, balance: balance ?? 0, history, note: spinState.note, withImage: false })],
                files: [], attachments: [], components: [],
            }).catch(() => {});
            return;
        }
        const rolled = debited
            ? await payHand(userFilter, bet, { game: 'roulette', handId, phase: 'rollback' })
            : null;
        const outcome = !debited ? 'No wager was taken.'
            : rolled.credited ? 'Your wager has been refunded — please try again.' : 'Your wager could not be refunded.';
        await surface.show({
            content: `Something went wrong. ${outcome}${rolled ? payoutNote(rolled) : ''}`,
            embeds: [], files: [], attachments: [], components: [],
        }).catch(() => {});
    }
}

/**
 * Listens on a result for the next spin: the same bet again, half or double
 * it, or a different bet from the menu.
 */
function armReplay(ctx, msg, surface, ids) {
    const { interaction, betKey, bet, onWager, claimCooldown } = ctx;
    if (!msg?.createMessageComponentCollector) return;

    const known = new Set(Object.values(ids));
    const collector = msg.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, i => known.has(i.customId), "This isn't your spin."),
        time: REPLAY_WINDOW,
    });
    // One press at a time: a second press while the first is still asking
    // "are you sure?" would stake twice.
    let busy = false;

    collector.on('collect', async i => {
        if (busy) return i.deferUpdate().catch(() => {});
        busy = true;
        try {
            const nextBet = i.customId === ids.half ? Math.floor(bet / 2)
                : i.customId === ids.double ? bet * 2
                : bet;
            const nextKey = i.customId === ids.rebet ? (i.values?.[0] ?? betKey) : betKey;

            // A new spin is a new hand, so it answers to the settings as they
            // are now, not as they were when the first one was typed.
            const refused = await replayRefusal(interaction.guild.id, nextBet);
            if (refused) {
                collector.stop('refused');
                return i.reply({ content: refused, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            const gated = await replayGateRefusal(i, interaction, claimCooldown);
            if (gated) {
                busy = false;
                return i.reply({ content: gated, flags: MessageFlags.Ephemeral }).catch(() => {});
            }

            const user   = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const wallet = user?.balance ?? 0;
            // Said privately, and before anything is staked: overwriting the
            // result with "not enough coins" lost the spin the player was
            // looking at.
            if (wallet < nextBet) {
                busy = false;
                return i.reply({ content: `❌ Not enough coins to wager **${nextBet.toLocaleString()}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            const settings = await getGuildSettings(interaction.guild.id).catch(() => ctx.guildSettings);

            // Confirm against the press, which is unacknowledged and can carry
            // the prompt. Cancelling leaves the buttons live for another go.
            const { shouldProceed, alreadyReplied } = await confirmBet(i, nextBet, wallet, 'Roulette', settings);
            if (!shouldProceed) { busy = false; return; }
            if (!alreadyReplied) await i.deferUpdate().catch(() => {});
            collector.stop('replayed');

            // A confirmed replay plays on a new public message, so the old one
            // keeps its result but loses its buttons.
            if (alreadyReplied) await surface.show({ components: [] }).catch(() => {});

            await playRoulette({
                ...ctx,
                surface: createSurface(i, alreadyReplied),
                betKey: nextKey,
                bet: nextBet,
                guildSettings: settings,
                releaseLock: null,
                onWager,
            });
        } catch (err) {
            console.error('[Roulette] replay error:', err);
            busy = false;
        }
    });
    collector.on('end', (_, reason) => {
        if (reason === 'replayed') return;
        surface.show({ components: [] }).catch(() => {});
    });
}

module.exports.__test = { pocketStrip, outcomeOf, bannerFor, resultEmbed, createSurface, MIN_BET, MAX_BET };
