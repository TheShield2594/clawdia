const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');

const SYMBOLS = [
    { emoji: '🍒', name: 'Cherry',   type: 'regular',    weight: 28, payout: 2  },
    { emoji: '🍋', name: 'Lemon',    type: 'regular',    weight: 22, payout: 3  },
    { emoji: '🍇', name: 'Grape',    type: 'regular',    weight: 18, payout: 5  },
    { emoji: '🔔', name: 'Bell',     type: 'regular',    weight: 12, payout: 8  },
    { emoji: '💎', name: 'Diamond',  type: 'regular',    weight: 8,  payout: 15 },
    { emoji: '🌟', name: 'Star',     type: 'regular',    weight: 5,  payout: 25 },
    { emoji: '🃏', name: 'Wild',     type: 'wild',       weight: 4              },
    { emoji: '⚡', name: '2x Boost', type: 'multiplier', weight: 3,  multiplier: 2 },
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

// Builds the reel display; reels 0..revealed-1 show their actual emoji,
// the rest show a random spinning symbol.
function reelDisplay(reels, revealed) {
    return reels.map((s, i) => (i < revealed ? s.emoji : randomEmoji())).join(' ┃ ');
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

function spinEmbed(display, bet, stage, username) {
    const status = ['🎰 Reels spinning…', '⏳ First reel locked!', '⏳ Second reel locked!'];
    return new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎰 Slot Machine')
        .setDescription(`**[ ${display} ]**\n\n${status[stage]}`)
        .addFields({ name: '💰 Bet', value: `${bet.toLocaleString()} coins`, inline: true })
        .setFooter({ text: `Player: ${username}` });
}

function resultEmbed(reels, result, bet, balance, username) {
    const { payout, outcome, symbol, wildCount, multFactor } = result;
    const display = reels.map(s => s.emoji).join(' ┃ ');
    const net     = payout - bet;
    const netStr  = net >= 0 ? `+${net.toLocaleString()}` : `${net.toLocaleString()}`;

    const cfg = {
        jackpot: { color: '#FF00FF', title: '🎰 ★ JACKPOT ★ 🎰',  line: '🃏🃏🃏 **TRIPLE WILD — JACKPOT!** 🎉' },
        mult3:   { color: '#00FFFF', title: '🎰 Triple Boost!',    line: '⚡⚡⚡ **Triple Multiplier Bonus!**'    },
        three:   { color: '#00FF00', title: '🎰 Three of a Kind!', line: `${symbol.emoji.repeat(3)} **Three ${symbol.name}s!**` },
        two:     { color: '#FFAA00', title: '🎰 Two of a Kind!',   line: `${symbol.emoji.repeat(2)} **Two ${symbol.name}s!**`   },
        lose:    { color: '#FF4444', title: '🎰 No Match',         line: '❌ Better luck next time!'                             },
    };
    const { color, title, line } = cfg[outcome] ?? cfg.lose;

    let desc = `**[ ${display} ]**\n\n${line}`;
    if (wildCount > 0 && outcome !== 'jackpot') desc += '  *(🃏 Wild helped!)*';
    if (multFactor > 1 && outcome !== 'mult3')  desc += `  *(⚡ ${multFactor}x Boost!)*`;

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(desc)
        .addFields(
            { name: '💸 Bet',                                     value: `${bet.toLocaleString()} coins`,    inline: true },
            { name: payout > 0 ? '🏆 Won' : '💀 Lost',           value: payout > 0 ? `${payout.toLocaleString()} coins` : `${bet.toLocaleString()} coins`, inline: true },
            { name: '📊 Net',                                     value: `${netStr} coins`,                  inline: true },
            { name: '💰 Balance',                                  value: `${balance.toLocaleString()} coins`              },
        )
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
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

        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

        try {
            await User.findOneAndUpdate(
                userFilter,
                { $setOnInsert: { ...userFilter, balance: 0 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            // Determine result before touching the balance so the outcome is fixed
            // regardless of whether subsequent DB/Discord calls succeed.
            const reels  = [spinReel(), spinReel(), spinReel()];
            const result = evaluate(reels, bet);
            const net    = result.payout - bet;

            // Atomic: debit bet and credit payout in one step; only proceeds if the
            // balance covers the wager.
            const user = await User.findOneAndUpdate(
                { ...userFilter, balance: { $gte: bet } },
                { $inc: { balance: net } },
                { new: true }
            );

            if (!user) {
                const fresh = await User.findOne(userFilter);
                return interaction.editReply({
                    content: `You don't have enough coins! Wallet: **${(fresh?.balance ?? 0).toLocaleString()}** coins.`,
                });
            }

            const delay = ms => new Promise(r => setTimeout(r, ms));
            const u = interaction.user.username;

            // Sequential reel-stop animation
            await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 0), bet, 0, u)] });
            await delay(800);
            await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 1), bet, 1, u)] });
            await delay(800);
            await interaction.editReply({ embeds: [spinEmbed(reelDisplay(reels, 2), bet, 2, u)] });
            await delay(800);
            await interaction.editReply({ embeds: [resultEmbed(reels, result, bet, user.balance, u)] });

        } catch (err) {
            console.error('Slots error:', err);
            await interaction.editReply({ content: 'An error occurred while playing slots. Please try again.' });
        }
    },
};
