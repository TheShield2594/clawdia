const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3a1.png';
const MIN_BET = 10;
const MAX_BET = 5000;

const RED_NUMBERS = new Set([
    1, 3, 5, 7, 9, 12, 14, 16, 18,
    19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

function colorOf(n) {
    if (n === 0) return 'green';
    return RED_NUMBERS.has(n) ? 'red' : 'black';
}

function pocketEmoji(n) {
    const c = colorOf(n);
    if (c === 'green') return '🟢';
    if (c === 'red')   return '🔴';
    return '⚫';
}

const BETS = {
    red:    { label: 'Red',              payout: 1,  matches: n => colorOf(n) === 'red'              },
    black:  { label: 'Black',            payout: 1,  matches: n => colorOf(n) === 'black'            },
    odd:    { label: 'Odd',              payout: 1,  matches: n => n !== 0 && n % 2 === 1            },
    even:   { label: 'Even',             payout: 1,  matches: n => n !== 0 && n % 2 === 0            },
    low:    { label: 'Low (1–18)',        payout: 1,  matches: n => n >= 1 && n <= 18                 },
    high:   { label: 'High (19–36)',      payout: 1,  matches: n => n >= 19 && n <= 36                },
    dozen1: { label: '1st Dozen (1–12)',  payout: 2,  matches: n => n >= 1  && n <= 12               },
    dozen2: { label: '2nd Dozen (13–24)', payout: 2,  matches: n => n >= 13 && n <= 24               },
    dozen3: { label: '3rd Dozen (25–36)', payout: 2,  matches: n => n >= 25 && n <= 36               },
    col1:   { label: 'Column 1',          payout: 2,  matches: n => n !== 0 && n % 3 === 1           },
    col2:   { label: 'Column 2',          payout: 2,  matches: n => n !== 0 && n % 3 === 2           },
    col3:   { label: 'Column 3',          payout: 2,  matches: n => n !== 0 && n % 3 === 0           },
    number: { label: 'Straight Number',   payout: 35, matches: (n, target) => n === target           },
};

function spin() { return Math.floor(Math.random() * 37); }

function pocketLabel(n) {
    return `${pocketEmoji(n)} **${n}**`;
}

// Shows 7 surrounding pockets with the current one highlighted
function pocketStrip(currentIndex, highlight = true) {
    const around = 3;
    const parts  = [];
    for (let offset = -around; offset <= around; offset++) {
        const i   = ((currentIndex + offset) % 37 + 37) % 37;
        const lbl = `${pocketEmoji(i)} ${i}`;
        parts.push(offset === 0 && highlight ? `**▶ ${pocketEmoji(i)} ${i} ◀**` : lbl);
    }
    return parts.join('  ');
}

function describeBet(betKey, target) {
    if (betKey === 'number') return `Straight #${target}`;
    return BETS[betKey].label;
}

function betOdds(betKey) {
    const payout = BETS[betKey]?.payout;
    if (!payout) return '';
    return payout === 35 ? '35:1' : `${payout}:1`;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function spinningEmbed(currentIndex, betKey, target, bet, interaction) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#c0392b')
        .setTitle('🎡 Roulette — Spinning…')
        .setDescription(
            `${pocketStrip(currentIndex)}\n\n` +
            `*The wheel is spinning — no more bets!*`,
        )
        .addFields(
            { name: '🎯 Your Bet',  value: `${describeBet(betKey, target)} (${betOdds(betKey)})`, inline: true },
            { name: '💰 Wager',     value: `**${bet.toLocaleString()}** coins`,                    inline: true },
        )
        .setFooter({ text: 'European Roulette  •  Single zero  •  2.7% house edge' });
}

function resultEmbed({ result, won, betKey, target, bet, profit, balance, interaction }) {
    const color    = won ? '#2ecc71' : '#e74c3c';
    const netStr   = profit >= 0 ? `+${profit.toLocaleString()}` : `${profit.toLocaleString()}`;
    const headline = won
        ? `🏆 **Landed on ${pocketLabel(result)}** — your **${describeBet(betKey, target)}** bet wins!`
        : `💀 **Landed on ${pocketLabel(result)}** — your **${describeBet(betKey, target)}** bet loses.`;

    const colorDesc = colorOf(result) === 'green'
        ? '🟢 Zero — all even-money bets lose'
        : colorOf(result) === 'red'
        ? '🔴 Red number'
        : '⚫ Black number';

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(`🎡 Roulette — ${won ? 'Winner!' : 'No Luck'}`)
        .setDescription(`${pocketStrip(result)}\n\n${headline}\n*${colorDesc}*`)
        .addFields(
            { name: '🎯 Bet',      value: `${describeBet(betKey, target)} (${betOdds(betKey)})`, inline: true  },
            { name: '💰 Wager',    value: `${bet.toLocaleString()} coins`,                        inline: true  },
            { name: '​',           value: '​',                                                     inline: false },
            { name: '📊 Net',      value: `**${netStr}** coins`,                                  inline: true  },
            { name: '💰 Balance',  value: `**${balance.toLocaleString()}** coins`,                inline: true  },
        )
        .setFooter({ text: 'European Roulette  •  Straight number pays 35:1' })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roulette')
        .setDescription('Bet on Red/Black, Odd/Even, dozens, columns, or a specific number.')
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
                .setDescription(`Coins to wager (${MIN_BET.toLocaleString()}–${MAX_BET.toLocaleString()})`)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)
                .setRequired(true))
        .addIntegerOption(opt =>
            opt.setName('number')
                .setDescription('Required when betting "Straight Number" — choose 0–36.')
                .setMinValue(0)
                .setMaxValue(36)
                .setRequired(false)),
    cooldown: 5,

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        }

        const betKey = interaction.options.getString('bet');
        const bet    = interaction.options.getInteger('amount');
        const target = interaction.options.getInteger('number');

        if (betKey === 'number' && target === null) {
            return interaction.reply({
                content: 'You must provide a `number` (0–36) when betting on a straight number.',
                ephemeral: true,
            });
        }

        await interaction.deferReply();
        await playRoulette(interaction, betKey, bet, target);
    },
};

async function playRoulette(interaction, betKey, bet, target) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
    let debited = null;
    let settled = false;

    try {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false) {
            return interaction.editReply({ content: 'Economy games are disabled in this server.' });
        }

        await User.findOneAndUpdate(
            userFilter,
            { $setOnInsert: { ...userFilter, balance: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        debited = await User.findOneAndUpdate(
            { ...userFilter, balance: { $gte: bet } },
            { $inc: { balance: -bet } },
            { new: true },
        );

        if (!debited) {
            return interaction.editReply({
                content: `❌ Not enough coins to wager **${bet.toLocaleString()}**.`,
            });
        }

        const result   = spin();
        const betDef   = BETS[betKey];
        const won      = betDef.matches(result, target);
        const profit   = won ? bet * betDef.payout : -bet;
        const credit   = won ? bet + profit : 0;
        const delay    = ms => new Promise(r => setTimeout(r, ms));

        // Spinning animation
        const totalSteps = 37 + result;

        await interaction.editReply({
            embeds: [spinningEmbed(0, betKey, target, bet, interaction)],
        }).catch(() => {});

        for (let step = 1; step <= totalSteps; step++) {
            const remaining = totalSteps - step;
            const shouldDraw = remaining < 8 || step % 4 === 0;
            if (!shouldDraw) continue;

            const wait = 120 + Math.max(0, 12 - remaining) * 35;
            await delay(wait);
            await interaction.editReply({
                embeds: [spinningEmbed(step % 37, betKey, target, bet, interaction)],
            }).catch(() => {});
        }

        let updated = debited;
        if (credit > 0) {
            updated = await User.findOneAndUpdate(
                userFilter,
                { $inc: { balance: credit } },
                { new: true },
            );
        }
        settled = true;

        const replayId = `roulette_replay_${interaction.id}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(replayId).setLabel('🎡 Spin Again').setStyle(ButtonStyle.Primary),
        );

        await interaction.editReply({
            embeds: [resultEmbed({ result, won, betKey, target, bet, profit, balance: updated.balance, interaction })],
            components: [row],
        });

        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === replayId,
            max: 1,
            time: 60_000,
        });
        collector.on('collect', async i => {
            await i.deferUpdate();
            await playRoulette(interaction, betKey, bet, target);
        });
        collector.on('end', (_, reason) => {
            if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
        });

    } catch (err) {
        console.error('[Roulette] error:', err);
        if (debited && !settled) {
            await User.findOneAndUpdate(userFilter, { $inc: { balance: bet } }).catch(e =>
                console.error('[Roulette] rollback failed:', e));
        }
        await interaction.editReply({
            content: 'Something went wrong. Your wager has been refunded — please try again.',
            components: [],
        }).catch(() => {});
    }
}
