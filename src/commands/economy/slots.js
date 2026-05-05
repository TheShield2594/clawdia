const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../models/User');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b0.png';

const SYMBOLS = [
    { emoji: '🍒', name: 'Cherry',   type: 'regular',    weight: 28, payout: 2  },
    { emoji: '🍋', name: 'Lemon',    type: 'regular',    weight: 22, payout: 3  },
    { emoji: '🍇', name: 'Grape',    type: 'regular',    weight: 18, payout: 5  },
    { emoji: '🔔', name: 'Bell',     type: 'regular',    weight: 12, payout: 8  },
    { emoji: '💎', name: 'Diamond',  type: 'regular',    weight: 8,  payout: 15 },
    { emoji: '🌟', name: 'Star',     type: 'regular',    weight: 5,  payout: 25 },
    { emoji: '🃏', name: 'Wild',     type: 'wild',       weight: 4              },
    { emoji: '⚡', name: '2x Boost', type: 'multiplier', weight: 3, multiplier: 2 },
];

const TOTAL_WEIGHT  = SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
const SPIN_POOL     = SYMBOLS.filter(s => s.type === 'regular' || s.type === 'wild');
const JACKPOT_MULTI = 50;

function spinReel() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (const s of SYMBOLS) {
        r -= s.weight;
        if (r <= 0) return s;
    }
    return SYMBOLS[0];
}

function randomEmoji() {
    return SPIN_POOL[Math.floor(Math.random() * SPIN_POOL.length)].emoji;
}

function reelDisplay(reels, revealed) {
    return reels.map((s, i) => i < revealed ? s.emoji : randomEmoji()).join('  ┃  ');
}

function evaluate(reels, bet) {
    const regulars   = reels.filter(s => s.type === 'regular');
    const wilds      = reels.filter(s => s.type === 'wild');
    const mults      = reels.filter(s => s.type === 'multiplier');
    const wildCount  = wilds.length;
    const multFactor = mults.reduce((acc, m) => acc * m.multiplier, 1);

    if (wildCount === 3)
        return { payout: bet * JACKPOT_MULTI, outcome: 'jackpot', symbol: null, wildCount, multFactor };
    if (mults.length === 3)
        return { payout: bet * 4, outcome: 'mult3', symbol: null, wildCount, multFactor };

    if (regulars.length > 0) {
        const freq = {};
        for (const s of regulars) freq[s.name] = (freq[s.name] || 0) + 1;
        const [topName, topCount] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
        const effective = topCount + wildCount;
        const sym = SYMBOLS.find(s => s.name === topName);

        if (effective >= 3)
            return { payout: bet * sym.payout * multFactor, outcome: 'three', symbol: sym, wildCount, multFactor };
        if (effective === 2)
            return { payout: Math.floor(bet * sym.payout * 0.5 * multFactor), outcome: 'two', symbol: sym, wildCount, multFactor };
    }

    return { payout: 0, outcome: 'lose', symbol: null, wildCount, multFactor };
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function spinEmbed(display, bet, stage, interaction) {
    const statuses = [
        '🎰 **Spinning all reels…**',
        '🔒 **First reel locked!** Spinning remaining…',
        '🔒🔒 **Two reels locked!** Last one spinning…',
    ];
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#FFD700')
        .setTitle('🎰 Slot Machine')
        .setDescription(`${statuses[stage]}\n\n> **[ ${display} ]**`)
        .addFields(
            { name: '💰 Bet', value: `**${bet.toLocaleString()}** coins`, inline: true },
            { name: '🎲 Status', value: `Reel ${stage}/3 locked`, inline: true },
        );
}

function resultEmbed(reels, result, bet, balance, interaction) {
    const { payout, outcome, symbol, wildCount, multFactor } = result;
    const display = reels.map(s => s.emoji).join('  ┃  ');
    const net     = payout - bet;
    const netStr  = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

    const cfg = {
        jackpot: { color: '#FF00FF', title: '🎰 ✨ J A C K P O T ✨ 🎰', line: '🃏🃏🃏 **TRIPLE WILD — JACKPOT!** 🎉🎊🎉\n*The reels went absolutely wild!*' },
        mult3:   { color: '#00FFFF', title: '🎰 ⚡ Triple Boost! ⚡',     line: '⚡⚡⚡ **TRIPLE MULTIPLIER BONUS!**\n*Electrifying win!*' },
        three:   { color: '#00FF00', title: `🎰 🏆 Three ${symbol?.name ?? ''}s!`, line: `${symbol?.emoji.repeat(3)} **THREE OF A KIND!**\n*${symbol?.name} power!*` },
        two:     { color: '#FFAA00', title: '🎰 Two of a Kind',           line: `${symbol?.emoji.repeat(2)} **Two ${symbol?.name ?? ''}s** — partial win!` },
        lose:    { color: '#FF4444', title: '🎰 No Match',                line: '💨 *No matching symbols — better luck next time!*' },
    };
    const { color, title, line } = cfg[outcome] ?? cfg.lose;

    let extras = '';
    if (wildCount > 0 && outcome !== 'jackpot') extras += '\n> 🃏 *Wild card assisted!*';
    if (multFactor > 1 && outcome !== 'mult3')  extras += `\n> ⚡ *${multFactor}x Boost applied!*`;

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(title)
        .setDescription(`> **[ ${display} ]**\n\n${line}${extras}`)
        .addFields(
            { name: '💸 Bet',                                value: `${bet.toLocaleString()} coins`,    inline: true },
            { name: payout > 0 ? '🏆 Payout' : '💀 Lost',   value: payout > 0 ? `${payout.toLocaleString()} coins` : `${bet.toLocaleString()} coins`, inline: true },
            { name: '📊 Net',                                value: `**${netStr}** coins`,              inline: true },
            { name: '💰 Balance',                            value: `**${balance.toLocaleString()}** coins` },
        )
        .setFooter({ text: '🃏 Wild substitutes for any symbol  •  ⚡ Boost multiplies your win' })
        .setTimestamp();
}

function paytableEmbed() {
    return new EmbedBuilder()
        .setColor('#FFD700')
        .setThumbnail(THUMB)
        .setTitle('🎰 Slot Machine — Paytable')
        .setDescription('Match **3 symbols** (or **2 + a Wild 🃏**) to win!\n⚡ Boost on any reel multiplies your payout.\n​')
        .addFields(
            { name: '🍒 Cherry',   value: '**2×** your bet',   inline: true },
            { name: '🍋 Lemon',    value: '**3×** your bet',   inline: true },
            { name: '🍇 Grape',    value: '**5×** your bet',   inline: true },
            { name: '🔔 Bell',     value: '**8×** your bet',   inline: true },
            { name: '💎 Diamond',  value: '**15×** your bet',  inline: true },
            { name: '🌟 Star',     value: '**25×** your bet',  inline: true },
            { name: '​', value: '​', inline: false },
            { name: '🃏🃏🃏 Triple Wild', value: '🏆 **JACKPOT — 50× bet**', inline: true },
            { name: '⚡⚡⚡ Triple Boost', value: '**4× bet**', inline: true },
            { name: 'Two of a Kind', value: 'Half of the 3-of-a-kind payout', inline: false },
        )
        .setFooter({ text: 'Two-of-a-kind pays 50% of the three-of-a-kind rate for that symbol' });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('slots')
        .setDescription('Spin the slot machine and try your luck!')
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription('Amount of coins to bet (10–5,000)')
                .setMinValue(10)
                .setMaxValue(5000)
                .setRequired(true)),
    cooldown: 5,
    async execute(interaction) {
        const bet = interaction.options.getInteger('bet');
        await interaction.deferReply();
        await playSlots(interaction, bet);
    },
};

async function playSlots(interaction, bet) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    try {
        await User.findOneAndUpdate(
            userFilter,
            { $setOnInsert: { ...userFilter, balance: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const reels  = [spinReel(), spinReel(), spinReel()];
        const result = evaluate(reels, bet);
        const net    = result.payout - bet;

        const user = await User.findOneAndUpdate(
            { ...userFilter, balance: { $gte: bet } },
            { $inc: { balance: net } },
            { new: true }
        );

        if (!user) {
            const fresh = await User.findOne(userFilter);
            return interaction.editReply({
                content: `❌ Not enough coins! Your balance: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                embeds: [], components: [],
            });
        }

        const delay = ms => new Promise(r => setTimeout(r, ms));

        await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 0), bet, 0, interaction)], components: [] });
        await delay(800);
        await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 1), bet, 1, interaction)] });
        await delay(800);
        await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 2), bet, 2, interaction)] });
        await delay(800);

        const replayId   = `slots_replay_${interaction.id}_${Date.now()}`;
        const paytableId = `slots_pay_${interaction.id}_${Date.now()}`;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('🎰 Spin Again').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(paytableId).setLabel('📊 Paytable').setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({
            embeds: [resultEmbed(reels, result, bet, user.balance, interaction)],
            components: [row],
        });

        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && [replayId, paytableId].includes(i.customId),
            time: 60_000,
        });

        collector.on('collect', async i => {
            if (i.customId === paytableId) {
                await i.reply({ embeds: [paytableEmbed()], ephemeral: true });
                return;
            }
            collector.stop('replay');
            await i.deferUpdate();
            await playSlots(interaction, bet);
        });

        collector.on('end', (_, reason) => {
            if (reason !== 'replay') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Slots] error:', err);
        await interaction.editReply({ content: 'An error occurred while playing slots. Please try again.', components: [] }).catch(() => {});
    }
}
