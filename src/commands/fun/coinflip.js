const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const Guild = require('../../models/Guild');
const User  = require('../../models/User');
const { logTransaction } = require('../../utils/logTransaction');
const { createReplaySession, replayButtonRow } = require('../../utils/replaySession');
const { refundWager } = require('../../utils/refundWager');
const { delay } = require('../../utils/delay');
const COLORS = require('../../utils/embedColors');
const { rejectOtherUser } = require('../../utils/collectorOwner');

const HEADS_THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1fa99.png';

// Spinning frame — single rotating coin
const SPIN_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const SPIN_MS     = 300;

const MIN_BET            = 10;
const SOLO_RAKE          = 0.05;               // solo flips pay 1.95x on a win (-2.5% EV)
const ACCEPT_TIMEOUT_MS  = 60_000;
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000; // PvP wagers gated like /rob and /gift

const HEADS = 'Heads';
const TAILS = 'Tails';

const flip  = () => (Math.random() < 0.5 ? HEADS : TAILS);
const other = side => (side === HEADS ? TAILS : HEADS);
const pip   = side => (side === HEADS ? '👑' : '🔘');

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function spinningEmbed(interaction, frame, stakeLine = null) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(HEADS_THUMB)
        .setColor(COLORS.WARN)
        .setTitle('🪙 Coin Flip')
        .setDescription(`${SPIN_FRAMES[frame % SPIN_FRAMES.length]} **Flipping…**${stakeLine ? `\n\n${stakeLine}` : ''}`)
        .setFooter({ text: 'Heads or Tails?' });
}

// Cosmetic frames: a transient edit failure here shouldn't abort a flip whose
// wager has already been debited.
async function spin(interaction, stakeLine = null) {
    for (let f = 0; f < 4; f++) {
        await interaction.editReply({
            embeds:     [spinningEmbed(interaction, f, stakeLine)],
            components: [],
        }).catch(() => {});
        await delay(SPIN_MS);
    }
}

function resultEmbed(interaction, result, call = null) {
    const isHeads = result === HEADS;
    const called  = call ? result === call : null;

    const embed = new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(HEADS_THUMB)
        .setColor(called === null ? (isHeads ? '#f39c12' : '#95a5a6') : (called ? '#2ecc71' : '#e74c3c'))
        .setTitle(isHeads ? '🪙 Heads!' : '🪙 Tails!')
        .setDescription(
            isHeads
                ? '👑 **HEADS!** The coin landed face-up.'
                : '🔘 **TAILS!** The coin landed face-down.',
        )
        .addFields(
            { name: '🎲 Result', value: `**${result}**`, inline: true },
            { name: '📊 Odds',   value: '**50 / 50**',   inline: true },
        )
        .setTimestamp();

    if (call) {
        embed.addFields({ name: '🗣️ Your Call', value: `${pip(call)} **${call}**`, inline: true });
        embed.setFooter({ text: called ? 'Called it. Flip again?' : 'Not your side this time. Flip again?' });
    } else {
        embed.setFooter({ text: 'Feeling lucky? Flip again!' });
    }

    return embed;
}

const refund = (userId, guildId, amount, note) =>
    refundWager({ userId, guildId, amount, type: 'coinflip', note });

// Take both wagers before the coin is flipped, and leave no coins stranded if
// that can't be completed: a side that can't cover it, or a write that fails
// outright, puts back whatever was already taken.
async function escrowWagers(guildId, challengerId, opponentId, bet) {
    let challengerHeld = false;

    try {
        const challengerDoc = await User.findOneAndUpdate(
            { userId: challengerId, guildId, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true }
        );
        if (!challengerDoc) return { ok: false, short: 'challenger' };
        challengerHeld = true;

        const opponentDoc = await User.findOneAndUpdate(
            { userId: opponentId, guildId, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true }
        );
        if (!opponentDoc) {
            await refund(challengerId, guildId, bet, 'PvP coinflip — opponent short, wager returned');
            return { ok: false, short: 'opponent' };
        }

        return { ok: true, challengerDoc, opponentDoc };
    } catch (error) {
        if (challengerHeld) {
            await refund(challengerId, guildId, bet, 'PvP coinflip — escrow failed, wager returned');
            // Reported so the caller can tell the challenger their coins came
            // back, rather than leaving them to assume the worst.
            return { ok: false, error, refunded: 'challenger' };
        }
        return { ok: false, error };
    }
}

// A rejected write is not proof the write never landed — a timeout can arrive
// after the server applied it. Refunding on that assumption would pay the pot
// out twice, so the payout is checked before anything is compensated. The
// balance the escrow already observed is what makes the check possible.
async function payoutState(userId, guildId, balanceBeforePayout, payout) {
    if (!Number.isFinite(balanceBeforePayout)) return 'unknown';

    try {
        const doc = await User.findOne({ userId, guildId });
        if (!doc) return 'unknown';
        if (doc.balance === balanceBeforePayout + payout) return 'applied';
        if (doc.balance === balanceBeforePayout) return 'not-applied';
        return 'unknown'; // something else moved the balance; don't guess
    } catch (error) {
        console.error('[coinflip] could not verify the payout:', error);
        return 'unknown';
    }
}

module.exports = {
    __test__: { escrowWagers, payoutState, refund, flip, other, pip },

    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Flip a coin — for fun, for coins, or against another member.')
        .addStringOption(o =>
            o.setName('side')
                .setDescription('Call it. Omit and the coin picks your side for you.')
                .addChoices(
                    { name: '👑 Heads', value: HEADS },
                    { name: '🔘 Tails', value: TAILS },
                ))
        .addIntegerOption(o =>
            o.setName('bet')
                .setDescription('Coins to wager (omit for a casual flip).')
                .setMinValue(MIN_BET))
        .addUserOption(o =>
            o.setName('opponent')
                .setDescription('Challenge another member — you take your side, they take the other. Winner takes the pot.')),
    cooldown: 5,

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.coinflipEnabled === false) {
            return interaction.reply({ content: 'Coinflip is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const bet      = interaction.options.getInteger('bet');
        const opponent = interaction.options.getUser('opponent');
        const side     = interaction.options.getString('side');

        if (!bet) {
            if (opponent) {
                return interaction.reply({ content: 'Challenging someone requires a `bet` — add one to make it interesting.', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply();
            return playCasualFlip(interaction, side);
        }

        const maxBet = guildSettings?.economy?.duelMaxBet ?? 10_000;
        if (bet > maxBet) {
            return interaction.reply({ content: `The maximum coinflip wager here is **${maxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }

        if (opponent) return playVersusFlip(interaction, guildSettings, bet, opponent, side ?? HEADS);
        return playSoloFlip(interaction, guildSettings, bet, side);
    },
};

// ── Casual (no stakes) ────────────────────────────────────────────────────────

async function playCasualFlip(interaction, call) {
    const replayId = `coinflip_replay_${interaction.id}`;
    let session    = null;

    async function render() {
        await spin(interaction);
        return interaction.editReply({
            embeds:     [resultEmbed(interaction, flip(), call)],
            components: session?.ended ? [] : [replayButtonRow(replayId, { emoji: '🪙', label: 'Flip Again' })],
        });
    }

    const message = await render();

    session = createReplaySession({
        interaction,
        message,
        customIds: [replayId],
        label:     'coinflip',
        claim:     `That coin is ${interaction.user}'s — run \`/coinflip\` to flip your own.`,
        async onCollect(button) {
            await button.deferUpdate();
            await render();
        },
    });
}


// ── Solo wager (vs the house) ────────────────────────────────────────────────

async function playSoloFlip(interaction, guildSettings, bet, side) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    const guildId  = interaction.guild.id;
    // The coin doesn't care which side you call, so an uncalled flip is settled
    // on a side picked for the player — same odds, one less decision.
    const call = side ?? flip();

    const debited = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId, balance: { $gte: bet } },
        { $inc: { balance: -bet } },
        { new: true }
    );
    if (!debited) {
        return interaction.reply({ content: `You don't have **${currency}${bet.toLocaleString()}** to wager.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    // The rake is disclosed up front here rather than only in the footer of a
    // win: the player is watching the animation with the bet already placed.
    await spin(
        interaction,
        `Wager: **${currency}${bet.toLocaleString()}** · You call ${pip(call)} **${call}** · pays **${(2 - SOLO_RAKE).toFixed(2)}x**`,
    );

    const result = flip();
    const won    = result === call;
    const profit = Math.floor(bet * (1 - SOLO_RAKE));

    let updated = debited;
    if (won) {
        try {
            updated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId },
                { $inc: { balance: bet + profit } },
                { new: true }
            );
        } catch (error) {
            // The stake is already gone and the win can't be paid. Give it back
            // rather than let a database hiccup pocket the wager.
            console.error('[coinflip] solo payout failed, returning the stake:', error);
            await refund(interaction.user.id, guildId, bet, 'Solo coinflip — payout failed, stake returned');
            return interaction.editReply({
                content:    `The coin came up **${result}** and you called it — but the payout failed, so your **${currency}${bet.toLocaleString()}** has been returned. Try again in a moment.`,
                embeds:     [],
                components: [],
            }).catch(() => {});
        }
    }

    logTransaction({
        userId:  interaction.user.id,
        guildId,
        type:    'coinflip',
        amount:  won ? profit : -bet,
        balance: updated?.balance ?? 0,
        note:    `Solo coinflip — called ${call}, landed ${result}`,
    });

    const embed = new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(HEADS_THUMB)
        .setColor(won ? '#2ecc71' : '#e74c3c')
        .setTitle(won ? `🪙 ${result}! You called it!` : `🪙 ${result}. Not your side.`)
        .setDescription(won
            ? `You called ${pip(call)} **${call}** and the coin agreed.\n\n💰 **+${currency}${profit.toLocaleString()}**`
            : `You called ${pip(call)} **${call}**, the coin said **${result}**.\n\n💸 **-${currency}${bet.toLocaleString()}**`)
        .addFields({ name: '💰 Balance', value: `**${currency}${(updated?.balance ?? 0).toLocaleString()}**`, inline: true })
        .setFooter({ text: won ? 'The house keeps 5% — quit while you\'re ahead?' : 'The coin holds no grudges. Probably.' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ── Versus wager (PvP, escrowed) ─────────────────────────────────────────────

async function playVersusFlip(interaction, guildSettings, bet, opponent, challengerSide) {
    const currency       = guildSettings?.economy?.currency ?? '💰';
    const guildId        = interaction.guild.id;
    const opponentSide   = other(challengerSide);

    if (opponent.id === interaction.user.id) {
        return interaction.reply({ content: 'Flipping a coin against yourself is called "thinking". Pick someone else.', flags: MessageFlags.Ephemeral });
    }
    if (opponent.bot) {
        return interaction.reply({ content: "Bots don't carry pocket change.", flags: MessageFlags.Ephemeral });
    }
    if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS
        || Date.now() - opponent.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
        return interaction.reply({ content: 'Both accounts must be at least 7 days old for wagered flips.', flags: MessageFlags.Ephemeral });
    }

    const acceptId  = `cfv_accept_${interaction.id}`;
    const declineId = `cfv_decline_${interaction.id}`;

    const challengeEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setThumbnail(HEADS_THUMB)
        .setTitle('🪙 Coinflip Challenge!')
        .setDescription(
            `**${interaction.member?.displayName ?? interaction.user.username}** challenges ${opponent} to a coinflip!\n\n` +
            `💰 Wager: **${currency}${bet.toLocaleString()}** each — winner takes the pot\n` +
            `${pip(challengerSide)} ${interaction.user.username} takes **${challengerSide}** · ${pip(opponentSide)} ${opponent.username} takes **${opponentSide}**`
        )
        .setFooter({ text: `${opponent.username} has 60 seconds to accept — ${interaction.user.username} can call it off with Decline` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('❌ Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ content: `${opponent}`, embeds: [challengeEmbed], components: [row] });
    const message = await interaction.fetchReply();

    const settle = (color, text) => interaction.editReply({
        content:    null,
        embeds:     [EmbedBuilder.from(challengeEmbed).setColor(color).setDescription(text)],
        components: [],
    }).catch(() => {});

    const collector = message.createMessageComponentCollector({
        filter: i => {
            if (![acceptId, declineId].includes(i.customId)) return false;
            // Decline doubles as the challenger's cancel — misfiring a
            // challenge at the wrong member otherwise leaves it live for the
            // full minute. Accept is the opponent's alone. Everyone else, and
            // the challenger reaching for Accept, is told so rather than left
            // looking at a click that failed.
            const allowed = i.customId === declineId ? [opponent.id, interaction.user.id] : [opponent.id];
            return !rejectOtherUser(i, allowed, i.user.id === interaction.user.id
                ? `Only ${opponent} can accept — press Decline to call it off.`
                : `That challenge is between ${interaction.user} and ${opponent}.`);
        },
        max:    1,
        time:   ACCEPT_TIMEOUT_MS,
    });

    collector.on('collect', async i => {
        // This runs long after execute() resolved, so the command dispatcher's
        // error handling no longer covers it. Anything thrown below would be an
        // unhandled rejection — with both wagers sitting in escrow.
        let challengerEscrowed = false;
        let opponentEscrowed   = false;
        let escrowRefunded     = null;

        try {
            if (i.customId === declineId) {
                await i.deferUpdate().catch(() => {});
                return await settle('#95a5a6', i.user.id === interaction.user.id
                    ? `${interaction.user.username} called off the challenge. The coin stays in its pocket.`
                    : `${opponent.username} declined the flip. The coin stays in its pocket.`);
            }

            await i.deferUpdate().catch(() => {});

            const escrow = await escrowWagers(guildId, interaction.user.id, opponent.id, bet);
            if (!escrow.ok) {
                if (escrow.short === 'challenger') {
                    return await settle('#e74c3c', `${interaction.user.username} no longer has the wager. Challenge cancelled.`);
                }
                if (escrow.short === 'opponent') {
                    return await settle('#e74c3c', `${opponent.username} can't cover the wager. Challenge cancelled.`);
                }
                escrowRefunded = escrow.refunded ?? null;
                throw escrow.error;
            }
            const { challengerDoc, opponentDoc } = escrow;
            challengerEscrowed = true;
            opponentEscrowed   = true;

            const stakeLine = `Pot: **${currency}${(bet * 2).toLocaleString()}** · ${pip(challengerSide)} ${interaction.user.username} = ${challengerSide} · ${pip(opponentSide)} ${opponent.username} = ${opponentSide}`;
            await spin(interaction, stakeLine);

            const result     = flip();
            const winnerUser = result === challengerSide ? interaction.user : opponent;
            const loserUser  = result === challengerSide ? opponent : interaction.user;
            const houseCut   = guildSettings?.economy?.duelHouseCut ?? 0.05;
            const pot        = bet * 2;
            const payout     = pot - Math.floor(pot * houseCut);

            const winnerBefore = (winnerUser.id === interaction.user.id ? challengerDoc : opponentDoc)?.balance;

            let winnerDoc = null;
            try {
                winnerDoc = await User.findOneAndUpdate(
                    { userId: winnerUser.id, guildId },
                    { $inc: { balance: payout } },
                    { new: true }
                );
            } catch (error) {
                const state = await payoutState(winnerUser.id, guildId, winnerBefore, payout);

                if (state === 'not-applied') throw error; // stakes are still ours to return

                // Either the pot was paid despite the error, or we can't tell.
                // Both stakes are off the table either way — returning them on
                // a maybe would mint the pot a second time.
                challengerEscrowed = false;
                opponentEscrowed   = false;

                if (state !== 'applied') {
                    console.error('[coinflip] payout outcome unresolved, wagers left in place for reconciliation:', {
                        guildId, winnerId: winnerUser.id, loserId: loserUser.id, bet, payout, error,
                    });
                    throw error;
                }

                winnerDoc = { balance: winnerBefore + payout };
            }

            // Past this point the pot has been paid out; neither stake is ours
            // to return any more.
            challengerEscrowed = false;
            opponentEscrowed   = false;

            const loserDoc = result === challengerSide ? opponentDoc : challengerDoc;
            logTransaction({ userId: winnerUser.id, guildId, type: 'coinflip', amount: payout - bet, balance: winnerDoc?.balance ?? 0, relatedUserId: loserUser.id, note: `PvP coinflip win (${result})` });
            logTransaction({ userId: loserUser.id,  guildId, type: 'coinflip', amount: -bet, balance: loserDoc?.balance ?? 0, relatedUserId: winnerUser.id, note: `PvP coinflip loss (${result})` });

            const resultEmbedPvp = new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setThumbnail(HEADS_THUMB)
                .setTitle(result === HEADS ? '🪙 HEADS!' : '🪙 TAILS!')
                .setDescription(
                    `The coin lands on **${result}**!\n\n` +
                    `🏆 **${winnerUser.username}** takes the pot: **+${currency}${(payout - bet).toLocaleString()}**\n` +
                    `💸 **${loserUser.username}** loses **${currency}${bet.toLocaleString()}**` +
                    (houseCut > 0 ? `\n\n> 🏛️ The house kept ${Math.round(houseCut * 100)}% of the pot.` : '')
                )
                .setTimestamp();

            return await interaction.editReply({ content: `${winnerUser}`, embeds: [resultEmbedPvp], components: [] }).catch(() => {});
        } catch (error) {
            console.error('[coinflip] versus handler error:', error);

            if (challengerEscrowed) await refund(interaction.user.id, guildId, bet, 'PvP coinflip — flip failed, wager returned');
            if (opponentEscrowed)   await refund(opponent.id, guildId, bet, 'PvP coinflip — flip failed, wager returned');

            // Say exactly which coins moved back. "Both wagers returned" when
            // only one was is worse than saying nothing.
            const returnedBoth = challengerEscrowed && opponentEscrowed;
            const returnedOne  = challengerEscrowed || opponentEscrowed || escrowRefunded;

            let note;
            if (returnedBoth)     note = ' Both wagers have been returned.';
            else if (returnedOne) note = ` ${interaction.user.username}'s wager has been returned.`;
            else                  note = ' The wagers are being reconciled from the transaction log.';

            await settle('#e74c3c', `The flip failed to resolve.${note}`);
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            settle('#95a5a6', `${opponent.username} didn't respond. The coin stays in its pocket.`);
        }
    });
}
