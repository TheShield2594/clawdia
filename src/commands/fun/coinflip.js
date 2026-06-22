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

const HEADS_THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1fa99.png';

// Spinning frame — single rotating coin
const SPIN_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

const MIN_BET            = 10;
const SOLO_RAKE          = 0.05;               // solo flips pay 1.95x on a win (-2.5% EV)
const ACCEPT_TIMEOUT_MS  = 60_000;
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000; // PvP wagers gated like /rob and /gift

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
        .setColor('#f39c12')
        .setTitle('🪙 Coin Flip')
        .setDescription(`${SPIN_FRAMES[frame % SPIN_FRAMES.length]} **Flipping…**${stakeLine ? `\n\n${stakeLine}` : ''}`)
        .setFooter({ text: 'Heads or Tails?' });
}

function resultEmbed(interaction, result) {
    const isHeads = result === 'Heads';
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(HEADS_THUMB)
        .setColor(isHeads ? '#f39c12' : '#95a5a6')
        .setTitle(isHeads ? '🪙 Heads!' : '🪙 Tails!')
        .setDescription(
            isHeads
                ? '👑 **HEADS!** The coin landed face-up.'
                : '🔘 **TAILS!** The coin landed face-down.',
        )
        .addFields(
            { name: '🎲 Result',  value: `**${result}**`, inline: true },
            { name: '📊 Odds',    value: '**50 / 50**',   inline: true },
        )
        .setFooter({ text: 'Feeling lucky? Flip again!' })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Flip a coin — for fun, for coins, or against another member.')
        .addIntegerOption(o =>
            o.setName('bet')
                .setDescription('Coins to wager (omit for a casual flip).')
                .setMinValue(MIN_BET))
        .addUserOption(o =>
            o.setName('opponent')
                .setDescription('Challenge another member — you take Heads, they take Tails. Winner takes the pot.')),
    cooldown: 5,

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.coinflipEnabled === false) {
            return interaction.reply({ content: 'Coinflip is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const bet      = interaction.options.getInteger('bet');
        const opponent = interaction.options.getUser('opponent');

        if (!bet) {
            if (opponent) {
                return interaction.reply({ content: 'Challenging someone requires a `bet` — add one to make it interesting.', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply();
            return playCasualFlip(interaction);
        }

        const maxBet = guildSettings?.economy?.duelMaxBet ?? 10_000;
        if (bet > maxBet) {
            return interaction.reply({ content: `The maximum coinflip wager here is **${maxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }

        if (opponent) return playVersusFlip(interaction, guildSettings, bet, opponent);
        return playSoloFlip(interaction, guildSettings, bet);
    },
};

// ── Casual (no stakes) ────────────────────────────────────────────────────────

async function playCasualFlip(interaction) {
    const delay = ms => new Promise(r => setTimeout(r, ms));

    // 4-frame spin animation
    for (let f = 0; f < 4; f++) {
        await interaction.editReply({ embeds: [spinningEmbed(interaction, f)], components: [] });
        await delay(300);
    }

    const result   = Math.random() < 0.5 ? 'Heads' : 'Tails';
    const replayId = `coinflip_replay_${interaction.id}_${Date.now()}`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(replayId)
            .setLabel('🪙 Flip Again')
            .setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({
        embeds:     [resultEmbed(interaction, result)],
        components: [row],
    });

    const msg = await interaction.fetchReply();
    const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && i.customId === replayId,
        max:    1,
        time:   60_000,
    });

    collector.on('collect', async i => {
        await i.deferUpdate();
        await playCasualFlip(interaction);
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
    });
}

// ── Solo wager (vs the house) ────────────────────────────────────────────────

async function playSoloFlip(interaction, guildSettings, bet) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    const guildId  = interaction.guild.id;
    const call     = Math.random() < 0.5 ? 'Heads' : 'Tails'; // the coin doesn't care which side you call

    const debited = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId, balance: { $gte: bet } },
        { $inc: { balance: -bet } },
        { new: true }
    );
    if (!debited) {
        return interaction.reply({ content: `You don't have **${currency}${bet.toLocaleString()}** to wager.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const stakeLine = `Wager: **${currency}${bet.toLocaleString()}** · You call **${call}**`;
    for (let f = 0; f < 4; f++) {
        await interaction.editReply({ embeds: [spinningEmbed(interaction, f, stakeLine)] });
        await delay(300);
    }

    const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
    const won    = result === call;
    const profit = Math.floor(bet * (1 - SOLO_RAKE));

    let updated = debited;
    if (won) {
        updated = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId },
            { $inc: { balance: bet + profit } },
            { new: true }
        );
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
            ? `You called **${call}** and the coin agreed.\n\n💰 **+${currency}${profit.toLocaleString()}**`
            : `You called **${call}**, the coin said **${result}**.\n\n💸 **-${currency}${bet.toLocaleString()}**`)
        .addFields({ name: '💰 Balance', value: `**${currency}${(updated?.balance ?? 0).toLocaleString()}**`, inline: true })
        .setFooter({ text: won ? 'The house keeps 5% — quit while you\'re ahead?' : 'The coin holds no grudges. Probably.' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ── Versus wager (PvP, escrowed) ─────────────────────────────────────────────

async function playVersusFlip(interaction, guildSettings, bet, opponent) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    const guildId  = interaction.guild.id;

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
        .setColor('#f39c12')
        .setThumbnail(HEADS_THUMB)
        .setTitle('🪙 Coinflip Challenge!')
        .setDescription(
            `**${interaction.member?.displayName ?? interaction.user.username}** challenges ${opponent} to a coinflip!\n\n` +
            `💰 Wager: **${currency}${bet.toLocaleString()}** each — winner takes the pot\n` +
            `👑 ${interaction.user.username} takes **Heads** · 🔘 ${opponent.username} takes **Tails**`
        )
        .setFooter({ text: 'Accept within 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('❌ Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ content: `${opponent}`, embeds: [challengeEmbed], components: [row] });
    const msg = await interaction.fetchReply();

    const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === opponent.id && [acceptId, declineId].includes(i.customId),
        max:    1,
        time:   ACCEPT_TIMEOUT_MS,
    });

    collector.on('collect', async i => {
        if (i.customId === declineId) {
            return i.update({
                content:    null,
                embeds:     [EmbedBuilder.from(challengeEmbed).setColor('#95a5a6').setDescription(`${opponent.username} declined the flip. The coin stays in its pocket.`)],
                components: [],
            }).catch(() => {});
        }

        // Escrow both wagers atomically; refund the challenger if the opponent can't cover
        const challengerDoc = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true }
        );
        if (!challengerDoc) {
            return i.update({
                content:    null,
                embeds:     [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${interaction.user.username} no longer has the wager. Challenge cancelled.`)],
                components: [],
            }).catch(() => {});
        }
        const opponentDoc = await User.findOneAndUpdate(
            { userId: opponent.id, guildId, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true }
        );
        if (!opponentDoc) {
            await User.updateOne({ userId: interaction.user.id, guildId }, { $inc: { balance: bet } });
            return i.update({
                content:    null,
                embeds:     [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${opponent.username} can't cover the wager. Challenge cancelled.`)],
                components: [],
            }).catch(() => {});
        }

        await i.deferUpdate().catch(() => {});
        const delay = ms => new Promise(r => setTimeout(r, ms));
        const stakeLine = `Pot: **${currency}${(bet * 2).toLocaleString()}** · 👑 ${interaction.user.username} = Heads · 🔘 ${opponent.username} = Tails`;
        for (let f = 0; f < 4; f++) {
            await interaction.editReply({ content: null, embeds: [spinningEmbed(interaction, f, stakeLine)], components: [] }).catch(() => {});
            await delay(300);
        }

        const result     = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const winnerUser = result === 'Heads' ? interaction.user : opponent;
        const loserUser  = result === 'Heads' ? opponent : interaction.user;
        const houseCut   = guildSettings?.economy?.duelHouseCut ?? 0.05;
        const pot        = bet * 2;
        const payout     = pot - Math.floor(pot * houseCut);

        const winnerDoc = await User.findOneAndUpdate(
            { userId: winnerUser.id, guildId },
            { $inc: { balance: payout } },
            { new: true }
        );
        const loserDoc = result === 'Heads' ? opponentDoc : challengerDoc;
        logTransaction({ userId: winnerUser.id, guildId, type: 'coinflip', amount: payout - bet, balance: winnerDoc?.balance ?? 0, relatedUserId: loserUser.id, note: `PvP coinflip win (${result})` });
        logTransaction({ userId: loserUser.id,  guildId, type: 'coinflip', amount: -bet, balance: loserDoc?.balance ?? 0, relatedUserId: winnerUser.id, note: `PvP coinflip loss (${result})` });

        const resultEmbedPvp = new EmbedBuilder()
            .setColor('#2ecc71')
            .setThumbnail(HEADS_THUMB)
            .setTitle(result === 'Heads' ? '🪙 HEADS!' : '🪙 TAILS!')
            .setDescription(
                `The coin lands on **${result}**!\n\n` +
                `🏆 **${winnerUser.username}** takes the pot: **+${currency}${(payout - bet).toLocaleString()}**\n` +
                `💸 **${loserUser.username}** loses **${currency}${bet.toLocaleString()}**` +
                (houseCut > 0 ? `\n\n> 🏛️ The house kept ${Math.round(houseCut * 100)}% of the pot.` : '')
            )
            .setTimestamp();

        return interaction.editReply({ content: `${winnerUser}`, embeds: [resultEmbedPvp], components: [] }).catch(() => {});
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            interaction.editReply({
                content:    null,
                embeds:     [EmbedBuilder.from(challengeEmbed).setColor('#95a5a6').setDescription(`${opponent.username} didn't respond. The coin stays in its pocket.`)],
                components: [],
            }).catch(() => {});
        }
    });
}
