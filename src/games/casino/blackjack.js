const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier } = require('../../services/effectsService');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;
const MAX_BET = 5000;

const SUITS  = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const value of VALUES) deck.push({ suit, value });
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardValue(card) {
    if (['J', 'Q', 'K'].includes(card.value)) return 10;
    if (card.value === 'A') return 11;
    return parseInt(card.value, 10);
}

function handTotal(hand) {
    let total = hand.reduce((sum, c) => sum + cardValue(c), 0);
    let aces  = hand.filter(c => c.value === 'A').length;
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}

function displayHand(hand, hideSecond = false) {
    return hand.map((c, i) => (hideSecond && i === 1) ? '🂠' : `${c.value}${c.suit}`).join('  ');
}

function canDoubleDown(hand) {
    const total = handTotal(hand);
    return hand.length === 2 && (total === 9 || total === 10 || total === 11);
}

function canSplitHand(hand) {
    return hand.length === 2 && cardValue(hand[0]) === cardValue(hand[1]);
}

function buildEmbed(interaction, playerHand, dealerHand, bet, currency, status, color, hideDealer, splitState = null) {
    const dealerShown = hideDealer ? cardValue(dealerHand[0]) : handTotal(dealerHand);

    const embed = new EmbedBuilder()
        .setAuthor({
            name: interaction.member?.displayName || interaction.user.username,
            iconURL: interaction.user.displayAvatarURL(),
        })
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🃏 Blackjack')
        .addFields({ name: `Dealer's Hand (${dealerShown})`, value: displayHand(dealerHand, hideDealer), inline: false })
        .setFooter({ text: 'Blackjack pays 3:2 · Dealer stands on 17' })
        .setTimestamp();

    if (splitState) {
        const { splitHands, splitBets, currentSplitHand, splitHandDone } = splitState;
        for (let h = 0; h < 2; h++) {
            const total = handTotal(splitHands[h]);
            let indicator;
            if (splitHandDone[h])          indicator = '✓ ';
            else if (h === currentSplitHand) indicator = '▶ ';
            else                            indicator = '⏳ ';
            embed.addFields({ name: `${indicator}Hand ${h + 1} (${total})`, value: displayHand(splitHands[h]), inline: true });
        }
        embed.addFields(
            { name: 'Bet per Hand', value: `${currency}${splitBets[0].toLocaleString()}`, inline: true },
            { name: 'Status', value: status, inline: false },
        );
    } else {
        embed.addFields(
            { name: `Your Hand (${handTotal(playerHand)})`, value: displayHand(playerHand), inline: false },
            { name: 'Bet', value: `${currency}${bet.toLocaleString()}`, inline: true },
            { name: 'Status', value: status, inline: true },
        );
    }

    return embed;
}

function buildButtons(gameId, disabled = false, opts = {}) {
    const {
        canDouble = false, doubleCost = 0,
        canSplit = false,  splitCost  = 0,
        canInsurance = false, insuranceCost = 0,
    } = opts;

    const buttons = [
        new ButtonBuilder().setCustomId(`bj_hit_${gameId}`).setLabel('Hit').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`bj_stand_${gameId}`).setLabel('Stand').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ];

    if (!disabled) {
        if (canDouble)    buttons.push(new ButtonBuilder().setCustomId(`bj_double_${gameId}`).setLabel(`Double Down (${doubleCost.toLocaleString()})`).setStyle(ButtonStyle.Success));
        if (canSplit)     buttons.push(new ButtonBuilder().setCustomId(`bj_split_${gameId}`).setLabel(`Split (${splitCost.toLocaleString()})`).setStyle(ButtonStyle.Success));
        if (canInsurance) buttons.push(new ButtonBuilder().setCustomId(`bj_insurance_${gameId}`).setLabel(`Insurance (${insuranceCost.toLocaleString()})`).setStyle(ButtonStyle.Danger));
    }

    return new ActionRowBuilder().addComponents(buttons);
}

module.exports = {
    name: 'blackjack',
    description: 'Play blackjack against the dealer',
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (${MIN_BET}–${MAX_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(MAX_BET)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false || guildSettings?.economy?.blackjackEnabled === false) {
            return interaction.reply({ content: 'Blackjack is disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const bet      = interaction.options.getInteger('bet');

        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });

        if (user.balance < bet) {
            return interaction.reply({ content: `You don't have enough ${currency}. Your balance: **${currency}${user.balance.toLocaleString()}**`, ephemeral: true });
        }

        if (!await confirmBet(interaction, bet, user.balance, 'Blackjack', guildSettings)) return;

        user.balance -= bet;
        user.lifetimeGambled = (user.lifetimeGambled || 0) + bet;
        await user.save();

        const deck       = buildDeck();
        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];
        const gameId     = `${interaction.user.id}_${Date.now()}`;

        // Natural blackjack check
        if (handTotal(playerHand) === 21) {
            if (handTotal(dealerHand) === 21) {
                user.balance += bet;
                await user.save();
                const embed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, '🤝 Push — both got blackjack', '#f39c12', false);
                return interaction.reply({ embeds: [embed], components: [buildButtons(gameId, true)] });
            }
            const bjCoinMult   = getCoinMultiplier(user);
            const bjServerMult = getServerCoinMultiplier(guildSettings);
            const payout = Math.round(Math.floor(bet * 1.5) * bjCoinMult * bjServerMult);
            user.balance += bet + payout;
            await user.save();
            const boostNote = (bjCoinMult * bjServerMult) > 1.0 ? ` *(🚀 ${(bjCoinMult * bjServerMult).toFixed(1)}x)*` : '';
            const embed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, `🎉 Blackjack! +${currency}${payout.toLocaleString()}${boostNote}`, '#2ecc71', false);
            return interaction.reply({ embeds: [embed], components: [buildButtons(gameId, true)] });
        }

        const dealerShowsAce  = dealerHand[0].value === 'A';
        const insuranceCost   = Math.floor(bet / 2);

        // Mutable game state
        let insuranceBet      = 0;
        let activeBet         = bet;
        let doubleAvailable   = canDoubleDown(playerHand);
        let splitAvailable    = canSplitHand(playerHand);
        let insuranceAvailable = dealerShowsAce && insuranceCost > 0;
        let splitActive       = false;
        let splitHands        = null;
        let splitBets         = null;
        let currentSplitHand  = 0;
        let splitHandDone     = [false, false];

        function currentOpts() {
            if (splitActive) return {};
            return {
                canDouble: doubleAvailable, doubleCost: bet,
                canSplit: splitAvailable,   splitCost: bet,
                canInsurance: insuranceAvailable, insuranceCost,
            };
        }

        await interaction.reply({
            embeds:     [buildEmbed(interaction, playerHand, dealerHand, bet, currency, '🎲 Your turn', '#5865F2', true)],
            components: [buildButtons(gameId, false, currentOpts())],
        });

        const msg       = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && [
                `bj_hit_${gameId}`, `bj_stand_${gameId}`, `bj_double_${gameId}`,
                `bj_split_${gameId}`, `bj_insurance_${gameId}`,
            ].includes(i.customId),
            time: 60_000,
        });

        collector.on('collect', async i => {
            await i.deferUpdate();

            // ── Insurance ──────────────────────────────────────────────────────────
            if (i.customId === `bj_insurance_${gameId}`) {
                insuranceAvailable = false;
                const updated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: insuranceCost } },
                    { $inc: { balance: -insuranceCost, lifetimeGambled: insuranceCost } },
                    { new: true },
                );
                if (updated) insuranceBet = insuranceCost;
                const statusMsg = updated
                    ? `🛡️ Insurance taken (${currency}${insuranceCost.toLocaleString()}) · Your turn`
                    : `⚠️ Not enough balance for insurance · Your turn`;
                const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, statusMsg, '#5865F2', true);
                return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false, currentOpts())] });
            }

            // ── Double Down ────────────────────────────────────────────────────────
            if (i.customId === `bj_double_${gameId}`) {
                doubleAvailable = false;
                splitAvailable  = false;
                const updated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: bet } },
                    { $inc: { balance: -bet, lifetimeGambled: bet } },
                    { new: true },
                );
                if (!updated) {
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `⚠️ Not enough balance for double down · Your turn`, '#5865F2', true);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false, currentOpts())] });
                }
                activeBet = bet * 2;
                playerHand.push(deck.pop());
                const total = handTotal(playerHand);
                if (total > 21) {
                    collector.stop('bust');
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `💥 Bust! -${currency}${activeBet.toLocaleString()}`, '#e74c3c', false);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] });
                }
                const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `📊 Doubled to ${currency}${activeBet.toLocaleString()} — dealer reveals...`, '#5865F2', true);
                await interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] });
                collector.stop('stand');
                return;
            }

            // ── Split ──────────────────────────────────────────────────────────────
            if (i.customId === `bj_split_${gameId}`) {
                doubleAvailable = false;
                splitAvailable  = false;
                const updated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: bet } },
                    { $inc: { balance: -bet, lifetimeGambled: bet } },
                    { new: true },
                );
                if (!updated) {
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `⚠️ Not enough balance for split · Your turn`, '#5865F2', true);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false, currentOpts())] });
                }

                const isAceSplit = playerHand[0].value === 'A';
                splitHands       = [[playerHand[0], deck.pop()], [playerHand[1], deck.pop()]];
                splitBets        = [bet, bet];
                currentSplitHand = 0;
                splitHandDone    = [false, false];
                splitActive      = true;

                if (isAceSplit) {
                    splitHandDone = [true, true];
                    const splitState = { splitHands, splitBets, currentSplitHand: -1, splitHandDone };
                    const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '🎲 Split aces — dealer reveals...', '#5865F2', true, splitState);
                    await interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] });
                    collector.stop('split_done');
                    return;
                }

                const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '▶ Playing Hand 1', '#5865F2', true, splitState);
                return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false)] });
            }

            // ── Hit ────────────────────────────────────────────────────────────────
            if (i.customId === `bj_hit_${gameId}`) {
                if (splitActive) {
                    splitHands[currentSplitHand].push(deck.pop());
                    const total = handTotal(splitHands[currentSplitHand]);

                    if (total > 21 || total === 21) {
                        splitHandDone[currentSplitHand] = true;
                        if (currentSplitHand === 0) {
                            currentSplitHand = 1;
                            const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                            const label = total > 21 ? '💥 Hand 1 bust! ▶ Playing Hand 2' : '✓ Hand 1 at 21 · ▶ Playing Hand 2';
                            const embed = buildEmbed(interaction, null, dealerHand, bet, currency, label, '#5865F2', true, splitState);
                            return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false)] });
                        } else {
                            const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                            const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '🎲 Both hands done — dealer reveals...', '#5865F2', true, splitState);
                            await interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] });
                            collector.stop('split_done');
                            return;
                        }
                    }

                    const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                    const embed = buildEmbed(interaction, null, dealerHand, bet, currency, `▶ Playing Hand ${currentSplitHand + 1}`, '#5865F2', true, splitState);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false)] });
                }

                // Normal hit
                playerHand.push(deck.pop());
                const total = handTotal(playerHand);

                if (total > 21) {
                    collector.stop('bust');
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `💥 Bust! -${currency}${activeBet.toLocaleString()}`, '#e74c3c', false);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] });
                }

                doubleAvailable = false;
                splitAvailable  = false;

                if (total === 21) {
                    collector.stop('stand');
                } else {
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, '🎲 Your turn', '#5865F2', true);
                    return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false, currentOpts())] });
                }
            }

            // ── Stand ──────────────────────────────────────────────────────────────
            if (i.customId === `bj_stand_${gameId}`) {
                if (splitActive) {
                    splitHandDone[currentSplitHand] = true;
                    if (currentSplitHand === 0) {
                        currentSplitHand = 1;
                        const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                        const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '✓ Hand 1 done · ▶ Playing Hand 2', '#5865F2', true, splitState);
                        return interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, false)] });
                    } else {
                        const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                        const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '🎲 Both hands done — dealer reveals...', '#5865F2', true, splitState);
                        await interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] });
                        collector.stop('split_done');
                        return;
                    }
                }
                collector.stop('stand');
            }
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'bust') return;

            while (handTotal(dealerHand) < 17) dealerHand.push(deck.pop());
            const dealerTotal = handTotal(dealerHand);

            const [freshUser_raw, freshGuild] = await Promise.all([
                User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
                Guild.findOne({ guildId: interaction.guild.id }),
            ]);
            const freshUser = freshUser_raw ?? user;

            const luckyActive      = hasEffect(freshUser, 'lucky_charm');
            const luckyStreakBonus = getLuckyStreakBonus(freshUser);
            const coinMult         = getCoinMultiplier(freshUser);
            const serverMult       = getServerCoinMultiplier(freshGuild);
            const totalCoinMult    = coinMult * serverMult;

            let totalCredit = 0;
            let color, status;

            if (splitActive) {
                const handResults = [];
                for (let h = 0; h < 2; h++) {
                    const hTotal = handTotal(splitHands[h]);
                    const hBet   = splitBets[h];

                    if (hTotal > 21) {
                        handResults.push(`Hand ${h + 1}: 💥 Bust (-${currency}${hBet.toLocaleString()})`);
                    } else if (dealerTotal > 21 || hTotal > dealerTotal) {
                        const netProfit = Math.round(hBet * totalCoinMult);
                        totalCredit += hBet + netProfit;
                        const boostNote = totalCoinMult > 1.0 ? ` *(🚀 ${totalCoinMult.toFixed(1)}x)*` : '';
                        handResults.push(`Hand ${h + 1}: ✅ Win (+${currency}${netProfit.toLocaleString()}${boostNote})`);
                    } else if (hTotal === dealerTotal) {
                        totalCredit += hBet;
                        handResults.push(`Hand ${h + 1}: 🤝 Push`);
                    } else if (luckyActive && Math.random() < 0.20) {
                        totalCredit += hBet;
                        handResults.push(`Hand ${h + 1}: 🍀 Lucky Push`);
                    } else if (luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
                        totalCredit += hBet;
                        handResults.push(`Hand ${h + 1}: 🎯 Lucky Push`);
                    } else {
                        handResults.push(`Hand ${h + 1}: ❌ Loss (-${currency}${hBet.toLocaleString()})`);
                    }
                }
                const net = totalCredit - (splitBets[0] + splitBets[1]);
                color  = net > 0 ? '#2ecc71' : net === 0 ? '#f39c12' : '#e74c3c';
                status = handResults.join('\n');
            } else {
                const playerTotal = handTotal(playerHand);

                if (dealerTotal > 21 || playerTotal > dealerTotal) {
                    const netProfit = Math.round(activeBet * totalCoinMult);
                    totalCredit = activeBet + netProfit;
                    const boostNote = totalCoinMult > 1.0 ? ` *(🚀 ${totalCoinMult.toFixed(1)}x)*` : '';
                    status = `✅ You win! +${currency}${netProfit.toLocaleString()}${boostNote}`;
                    color  = '#2ecc71';
                } else if (playerTotal === dealerTotal) {
                    totalCredit = activeBet;
                    status = `🤝 Push — bet returned`;
                    color  = '#f39c12';
                } else if (luckyActive && Math.random() < 0.20) {
                    totalCredit = activeBet;
                    status = `🍀 Lucky Charm! Push — bet returned (${currency}${activeBet.toLocaleString()})`;
                    color  = '#f39c12';
                } else if (luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
                    totalCredit = activeBet;
                    status = `🎯 Lucky Streak! Push — bet returned (${currency}${activeBet.toLocaleString()})`;
                    color  = '#f39c12';
                } else {
                    status = `❌ Dealer wins. -${currency}${activeBet.toLocaleString()}`;
                    color  = '#e74c3c';
                }
            }

            // Resolve insurance (only pays on dealer natural blackjack)
            if (insuranceBet > 0) {
                const dealerNaturalBJ = handTotal(dealerHand.slice(0, 2)) === 21;
                if (dealerNaturalBJ) {
                    totalCredit += insuranceBet * 3; // return bet + 2:1 payout
                    status += `\n🛡️ Insurance paid! +${currency}${(insuranceBet * 2).toLocaleString()}`;
                } else {
                    status += `\n🛡️ Insurance lost (-${currency}${insuranceBet.toLocaleString()})`;
                }
            }

            freshUser.balance += totalCredit;
            await freshUser.save();

            if (splitActive) {
                const splitState = { splitHands, splitBets, currentSplitHand: -1, splitHandDone: [true, true] };
                const embed = buildEmbed(interaction, null, dealerHand, bet, currency, status, color, false, splitState);
                await interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] }).catch(() => {});
            } else {
                const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, status, color, false);
                await interaction.editReply({ embeds: [embed], components: [buildButtons(gameId, true)] }).catch(() => {});
            }
        });
    },
};
