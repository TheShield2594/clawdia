const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const User  = require('../../models/User');
const { placeWager } = require('../../utils/placeWager');
const Guild = require('../../models/Guild');
const { confirmBet } = require('../../utils/confirmBet');
const { hasEffect, getCoinMultiplier, getLuckyStreakBonus, getServerCoinMultiplier, luckySaveEligible } = require('../../services/effectsService');
const { randomFrom, BJ_WIN_LINES, BJ_LOSE_LINES, BJ_BUST_LINES, BJ_PUSH_LINES } = require('../../utils/copyLines');
const COLORS = require('../../utils/embedColors');

const THUMB   = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f0cf.png';
const MIN_BET = 10;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    // Render cards as ASCII art boxes inside a monospace code block
    const cards = hand.map((c, i) => {
        if (hideSecond && i === 1) return ['┌───┐', '│ ? │', '│ ? │', '└───┘'];
        const v = String(c.value).padEnd(2);
        return ['┌───┐', `│${v} │`, `│ ${c.suit} │`, '└───┘'];
    });
    const rows = [0, 1, 2, 3].map(r => cards.map(c => c[r]).join(' ')).join('\n');
    return `\`\`\`\n${rows}\n\`\`\``;
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
        canDouble = false,
        canSplit = false,
        canInsurance = false,
    } = opts;

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bj_hit_${gameId}`).setLabel('🎯 Hit').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`bj_stand_${gameId}`).setLabel('✋ Stand').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );

    const extraButtons = [];
    if (!disabled) {
        if (canDouble)    extraButtons.push(new ButtonBuilder().setCustomId(`bj_double_${gameId}`).setLabel('⚡ Double Down').setStyle(ButtonStyle.Success));
        if (canSplit)     extraButtons.push(new ButtonBuilder().setCustomId(`bj_split_${gameId}`).setLabel('🃏 Split').setStyle(ButtonStyle.Success));
        if (canInsurance) extraButtons.push(new ButtonBuilder().setCustomId(`bj_insurance_${gameId}`).setLabel('🛡️ Insurance').setStyle(ButtonStyle.Danger));
    }

    if (extraButtons.length > 0) {
        return [row1, new ActionRowBuilder().addComponents(extraButtons)];
    }
    return [row1];
}

function buildDealerRevealEmbed(interaction, dealerHand, playerHand, splitHands, _currency, _bet) {
    const dealerStr = displayHand(dealerHand);
    const dealerVal = handTotal(dealerHand);

    const embed = new EmbedBuilder()
        .setAuthor({ name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setThumbnail(THUMB)
        .setColor(COLORS.INFO)
        .setTitle('🃏 Blackjack — Dealer\'s Turn')
        .setDescription('Dealer flips the hole card…')
        .addFields({ name: `Dealer (${dealerVal})`, value: dealerStr, inline: false })
        .setFooter({ text: 'Blackjack pays 3:2 · Dealer stands on 17' })
        .setTimestamp();

    if (splitHands) {
        embed.addFields(
            { name: `Hand 1 (${handTotal(splitHands[0])})`, value: displayHand(splitHands[0]), inline: true },
            { name: `Hand 2 (${handTotal(splitHands[1])})`, value: displayHand(splitHands[1]), inline: true },
        );
    } else if (playerHand) {
        embed.addFields({ name: `Your Hand (${handTotal(playerHand)})`, value: displayHand(playerHand), inline: false });
    }

    return embed;
}

function buildFinalEmbed(interaction, dealerHand, playerHand, splitHands, currency, bet, statusLine, description, color, balanceAfter) {
    const dealerStr  = displayHand(dealerHand);
    const dealerVal  = handTotal(dealerHand);
    const dealerLabel = dealerVal > 21 ? `Bust (${dealerVal})` : `${dealerVal}`;

    const embed = new EmbedBuilder()
        .setAuthor({ name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(statusLine)
        .setDescription(description ? `> ${description}` : null)
        .setFooter({ text: 'Blackjack pays 3:2 · Dealer stands on 17' })
        .setTimestamp();

    if (splitHands) {
        embed.addFields(
            { name: `Dealer (${dealerLabel})`, value: dealerStr, inline: false },
            { name: `Hand 1 (${handTotal(splitHands[0])})`, value: displayHand(splitHands[0]), inline: true },
            { name: `Hand 2 (${handTotal(splitHands[1])})`, value: displayHand(splitHands[1]), inline: true },
        );
    } else if (playerHand) {
        embed.addFields(
            { name: `Dealer (${dealerLabel})`, value: dealerStr, inline: true },
            { name: `Your Hand (${handTotal(playerHand)})`, value: displayHand(playerHand), inline: true },
        );
    }

    if (balanceAfter !== null) {
        embed.addFields({ name: 'Balance', value: `${currency}${balanceAfter.toLocaleString()}`, inline: false });
    }

    return embed;
}

module.exports = {
    name: 'blackjack',
    description: 'Play blackjack against the dealer',
    configure: sub => sub
        .addIntegerOption(opt =>
            opt.setName('bet')
                .setDescription(`Amount to bet (min ${MIN_BET})`)
                .setRequired(true)
                .setMinValue(MIN_BET)
                .setMaxValue(1_000_000_000)),

    async execute(interaction, { releaseLock, onWager } = {}) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false || guildSettings?.economy?.gamesEnabled === false || guildSettings?.economy?.blackjackEnabled === false) {
            releaseLock?.();
            return interaction.reply({ content: 'Blackjack is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency     = guildSettings?.economy?.currency || '💰';
        const bet          = interaction.options.getInteger('bet');
        const casinoMaxBet = guildSettings?.economy?.casinoMaxBet ?? 0;
        if (casinoMaxBet > 0 && bet > casinoMaxBet) {
            releaseLock?.();
            return interaction.reply({ content: `❌ The casino bet limit on this server is **${casinoMaxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        }

        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });

        if (user.balance < bet) {
            releaseLock?.();
            return interaction.reply({ content: `You don't have enough ${currency}. Your balance: **${currency}${user.balance.toLocaleString()}**`, flags: MessageFlags.Ephemeral });
        }

        const { shouldProceed, alreadyReplied } = await confirmBet(interaction, bet, user.balance, 'Blackjack', guildSettings);
        if (!shouldProceed) { releaseLock?.(); return; }
        const sendInitial = (payload) => alreadyReplied ? interaction.editReply(payload) : interaction.reply(payload);

        // The opening wager, and the only debit of this hand that reports one:
        // insurance, a split and a double down below are all further money on
        // the same hand, not another game played.
        const debited = await placeWager(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            bet,
            { extraInc: { lifetimeGambled: bet }, onWager },
        );
        if (!debited) {
            releaseLock?.();
            return interaction.reply({ content: `❌ Not enough ${currency}! Your balance may have changed.`, flags: MessageFlags.Ephemeral });
        }
        user = debited;

        const deck       = buildDeck();
        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];
        const gameId     = `${interaction.user.id}_${Date.now()}`;

        // Natural blackjack check
        if (handTotal(playerHand) === 21) {
            if (handTotal(dealerHand) === 21) {
                const pushUser = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $inc: { balance: bet } },
                    { new: true },
                );
                const embed = buildFinalEmbed(interaction, dealerHand, playerHand, null, currency, bet,
                    '🃏 Blackjack — Push', 'Both got blackjack. Bet returned.', '#f39c12', pushUser?.balance ?? user.balance);
                releaseLock?.();
                return sendInitial({ embeds: [embed], components: buildButtons(gameId, true) });
            }
            const bjCoinMult   = getCoinMultiplier(user);
            const bjServerMult = getServerCoinMultiplier(guildSettings);
            const payout = Math.round(Math.floor(bet * 1.5) * bjCoinMult * bjServerMult);
            const bjWinUser = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: bet + payout } },
                { new: true },
            );
            const boostNote = (bjCoinMult * bjServerMult) > 1.0 ? ` *(🚀 ${(bjCoinMult * bjServerMult).toFixed(1)}x)*` : '';
            const embed = new EmbedBuilder()
                .setAuthor({ name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
                .setThumbnail(THUMB)
                .setColor(COLORS.PRIZE)
                .setTitle('🃏 Blackjack — Natural 21')
                .setDescription(`> Perfect hand. Pays 3:2.`)
                .addFields(
                    { name: 'Your Hand', value: `${displayHand(playerHand)} ━━ Blackjack`, inline: false },
                    { name: `💰 Payout`, value: `${currency}${(bet + payout).toLocaleString()}  (+${currency}${payout.toLocaleString()} net)${boostNote}`, inline: false },
                    { name: 'Balance', value: `${currency}${(bjWinUser?.balance ?? user.balance).toLocaleString()}`, inline: false },
                )
                .setFooter({ text: 'Blackjack pays 3:2 · Dealer stands on 17' })
                .setTimestamp();
            releaseLock?.();
            return sendInitial({ embeds: [embed], components: buildButtons(gameId, true) });
        }

        const dealerShowsAce  = dealerHand[0].value === 'A';
        const insuranceCost   = Math.floor(bet / 2);

        // Dealer peek: if dealer shows Ace and has natural blackjack, resolve before player acts
        if (dealerShowsAce && handTotal(dealerHand) === 21) {
            const peekRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bj_hit_${gameId}`).setLabel('Hit').setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId(`bj_stand_${gameId}`).setLabel('Stand').setStyle(ButtonStyle.Secondary).setDisabled(true),
                ...(insuranceCost > 0 ? [new ButtonBuilder()
                    .setCustomId(`bj_insurance_${gameId}`)
                    .setLabel('🛡️ Insurance')
                    .setStyle(ButtonStyle.Danger)] : []),
            );
            await sendInitial({
                embeds: [buildEmbed(interaction, playerHand, dealerHand, bet, currency,
                    insuranceCost > 0
                        ? `🛡️ Insurance? (${currency}${insuranceCost.toLocaleString()}) — Dealer may have Blackjack`
                        : `⏳ Dealer revealing...`,
                    '#f39c12', true)],
                components: [peekRow],
            });

            let peekInsuranceBet = 0;
            if (insuranceCost > 0) {
                const peekMsg = await interaction.fetchReply();
                try {
                    const insI = await peekMsg.awaitMessageComponent({
                        filter: i2 => i2.user.id === interaction.user.id && i2.customId === `bj_insurance_${gameId}`,
                        time: 15_000,
                    });
                    await insI.deferUpdate();
                    const peekUpdated = await placeWager(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        insuranceCost,
                        { extraInc: { lifetimeGambled: insuranceCost } },
                    );
                    if (peekUpdated) peekInsuranceBet = insuranceCost;
                } catch {
                    // No insurance taken within timeout
                }
            }

            let peekStatus = `❌ Dealer Blackjack! -${currency}${bet.toLocaleString()}`;
            let peekCredit = 0;
            if (peekInsuranceBet > 0) {
                peekCredit = peekInsuranceBet * 3;
                peekStatus += `\n🛡️ Insurance paid! +${currency}${(peekInsuranceBet * 2).toLocaleString()}`;
            }
            if (peekCredit > 0) {
                await User.updateOne(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $inc: { balance: peekCredit } },
                );
            }
            const peekEmbed = buildEmbed(interaction, playerHand, dealerHand, bet, currency, peekStatus, '#e74c3c', false);
            releaseLock?.();
            return interaction.editReply({ embeds: [peekEmbed], components: buildButtons(gameId, true) });
        }

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
                canDouble: doubleAvailable,
                canSplit: splitAvailable,
                canInsurance: insuranceAvailable,
            };
        }

        await sendInitial({
            embeds:     [buildEmbed(interaction, playerHand, dealerHand, bet, currency, '🎲 Your turn', '#5865F2', true)],
            components: buildButtons(gameId, false, currentOpts()),
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
                const updated = await placeWager(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    insuranceCost,
                    { extraInc: { lifetimeGambled: insuranceCost } },
                );
                if (updated) insuranceBet = insuranceCost;
                const statusMsg = updated
                    ? `🛡️ Insurance taken (${currency}${insuranceCost.toLocaleString()}) · Your turn`
                    : `⚠️ Not enough balance for insurance · Your turn`;
                const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, statusMsg, '#5865F2', true);
                return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false, currentOpts()) });
            }

            // ── Double Down ────────────────────────────────────────────────────────
            if (i.customId === `bj_double_${gameId}`) {
                doubleAvailable = false;
                splitAvailable  = false;
                const updated = await placeWager(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    bet,
                    { extraInc: { lifetimeGambled: bet } },
                );
                if (!updated) {
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `⚠️ Not enough balance for double down · Your turn`, '#5865F2', true);
                    return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false, currentOpts()) });
                }
                activeBet = bet * 2;
                playerHand.push(deck.pop());
                const total = handTotal(playerHand);
                if (total > 21) {
                    collector.stop('bust');
                    const bustUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                    const embed = buildFinalEmbed(interaction, dealerHand, playerHand, null, currency, activeBet,
                        '🃏 Blackjack — Bust', randomFrom(BJ_BUST_LINES),
                        '#e74c3c', bustUser?.balance ?? 0);
                    return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) });
                }
                const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `📊 Doubled to ${currency}${activeBet.toLocaleString()} — dealer reveals...`, '#5865F2', true);
                await interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) });
                collector.stop('stand');
                return;
            }

            // ── Split ──────────────────────────────────────────────────────────────
            if (i.customId === `bj_split_${gameId}`) {
                doubleAvailable = false;
                splitAvailable  = false;
                const updated = await placeWager(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    bet,
                    { extraInc: { lifetimeGambled: bet } },
                );
                if (!updated) {
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, `⚠️ Not enough balance for split · Your turn`, '#5865F2', true);
                    return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false, currentOpts()) });
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
                    await interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) });
                    collector.stop('split_done');
                    return;
                }

                const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '▶ Playing Hand 1', '#5865F2', true, splitState);
                return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false) });
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
                            return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false) });
                        } else {
                            const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                            const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '🎲 Both hands done — dealer reveals...', '#5865F2', true, splitState);
                            await interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) });
                            collector.stop('split_done');
                            return;
                        }
                    }

                    const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                    const embed = buildEmbed(interaction, null, dealerHand, bet, currency, `▶ Playing Hand ${currentSplitHand + 1}`, '#5865F2', true, splitState);
                    return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false) });
                }

                // Normal hit
                playerHand.push(deck.pop());
                const total = handTotal(playerHand);

                if (total > 21) {
                    collector.stop('bust');
                    const bustUser2 = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                    const embed = buildFinalEmbed(interaction, dealerHand, playerHand, null, currency, activeBet,
                        '🃏 Blackjack — Bust', randomFrom(BJ_BUST_LINES),
                        '#e74c3c', bustUser2?.balance ?? 0);
                    return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) });
                }

                doubleAvailable = false;
                splitAvailable  = false;

                if (total === 21) {
                    collector.stop('stand');
                } else {
                    const embed = buildEmbed(interaction, playerHand, dealerHand, activeBet, currency, '🎲 Your turn', '#5865F2', true);
                    return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false, currentOpts()) });
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
                        return interaction.editReply({ embeds: [embed], components: buildButtons(gameId, false) });
                    } else {
                        const splitState = { splitHands, splitBets, currentSplitHand, splitHandDone };
                        const embed = buildEmbed(interaction, null, dealerHand, bet, currency, '🎲 Both hands done — dealer reveals...', '#5865F2', true, splitState);
                        await interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) });
                        collector.stop('split_done');
                        return;
                    }
                }
                collector.stop('stand');
            }
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'bust') {
                if (insuranceBet > 0 && handTotal(dealerHand.slice(0, 2)) === 21) {
                    await User.updateOne(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $inc: { balance: insuranceBet * 3 } },
                    );
                    const insUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                    const embed = buildFinalEmbed(interaction, dealerHand, playerHand, null, currency, activeBet,
                        '🃏 Blackjack — Bust',
                        `Went over. The house collects.\n🛡️ Insurance paid! +${currency}${(insuranceBet * 2).toLocaleString()}`,
                        '#e74c3c', insUser?.balance ?? 0);
                    await interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) }).catch(() => {});
                }
                releaseLock?.();
                return;
            }

            // Staged dealer reveal
            const revealEmbed = buildDealerRevealEmbed(
                interaction, dealerHand,
                splitActive ? null : playerHand,
                splitActive ? splitHands : null,
                currency, activeBet,
            );
            await interaction.editReply({ embeds: [revealEmbed], components: [] }).catch(() => {});
            await delay(600);

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
            let color, title, description;

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
                    } else if (luckySaveEligible(hBet) && luckyActive && Math.random() < 0.20) {
                        totalCredit += hBet;
                        handResults.push(`Hand ${h + 1}: 🍀 Lucky Push`);
                    } else if (luckySaveEligible(hBet) && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
                        totalCredit += hBet;
                        handResults.push(`Hand ${h + 1}: 🎯 Lucky Push`);
                    } else {
                        handResults.push(`Hand ${h + 1}: ❌ Loss (-${currency}${hBet.toLocaleString()})`);
                    }
                }
                const net = totalCredit - (splitBets[0] + splitBets[1]);
                color       = net > 0 ? '#2ecc71' : net === 0 ? '#f39c12' : '#e74c3c';
                title       = net > 0 ? '🃏 Blackjack — Split Win' : net === 0 ? '🃏 Blackjack — Split Push' : '🃏 Blackjack — Split Loss';
                description = handResults.join('\n');
            } else {
                const playerTotal = handTotal(playerHand);
                const boostNote   = totalCoinMult > 1.0 ? ` *(🚀 ${totalCoinMult.toFixed(1)}x)*` : '';

                if (dealerTotal > 21) {
                    const netProfit = Math.round(activeBet * totalCoinMult);
                    totalCredit = activeBet + netProfit;
                    title       = '🃏 Blackjack — You Win';
                    description = `${randomFrom(BJ_WIN_LINES)}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  💰 Payout: ${currency}${(activeBet + netProfit).toLocaleString()}  (+${currency}${netProfit.toLocaleString()} net)${boostNote}\n━━━━━━━━━━━━━━━━━━━━━━━━━━`;
                    color       = '#2ecc71';
                } else if (playerTotal > dealerTotal) {
                    const netProfit = Math.round(activeBet * totalCoinMult);
                    totalCredit = activeBet + netProfit;
                    title       = '🃏 Blackjack — You Win';
                    description = `${randomFrom(BJ_WIN_LINES)}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  💰 Payout: ${currency}${(activeBet + netProfit).toLocaleString()}  (+${currency}${netProfit.toLocaleString()} net)${boostNote}\n━━━━━━━━━━━━━━━━━━━━━━━━━━`;
                    color       = '#2ecc71';
                } else if (playerTotal === dealerTotal) {
                    totalCredit = activeBet;
                    title       = '🃏 Blackjack — Push';
                    description = `${randomFrom(BJ_PUSH_LINES)}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  🤝 Returned: ${currency}${activeBet.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━`;
                    color       = '#f39c12';
                } else if (luckySaveEligible(activeBet) && luckyActive && Math.random() < 0.20) {
                    totalCredit = activeBet;
                    title       = '🃏 Blackjack — Lucky Push';
                    description = `🍀 Lucky Charm saved you. Bet returned.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  🤝 Returned: ${currency}${activeBet.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━`;
                    color       = '#f39c12';
                } else if (luckySaveEligible(activeBet) && luckyStreakBonus > 0 && Math.random() < luckyStreakBonus) {
                    totalCredit = activeBet;
                    title       = '🃏 Blackjack — Lucky Push';
                    description = `🎯 Lucky Streak saved you. Bet returned.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  🤝 Returned: ${currency}${activeBet.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━`;
                    color       = '#f39c12';
                } else {
                    title       = '🃏 Blackjack — Dealer Wins';
                    description = `${randomFrom(BJ_LOSE_LINES)}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  💸 Lost: ${currency}${activeBet.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━`;
                    color       = '#e74c3c';
                }
            }

            // Resolve insurance (only pays on dealer natural blackjack)
            if (insuranceBet > 0) {
                const dealerNaturalBJ = handTotal(dealerHand.slice(0, 2)) === 21;
                if (dealerNaturalBJ) {
                    totalCredit += insuranceBet * 3;
                    description += `\n🛡️ Insurance paid! +${currency}${(insuranceBet * 2).toLocaleString()}`;
                } else {
                    description += `\n🛡️ Insurance lost (-${currency}${insuranceBet.toLocaleString()})`;
                }
            }

            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: totalCredit } },
            );

            const finalUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

            if (splitActive) {
                const splitState = { splitHands, splitBets, currentSplitHand: -1, splitHandDone: [true, true] };
                const embed = buildEmbed(interaction, null, dealerHand, bet, currency, description, color, false, splitState);
                embed.setTitle(title);
                await interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) }).catch(() => {});
            } else {
                const embed = buildFinalEmbed(interaction, dealerHand, playerHand, null, currency, activeBet,
                    title, description, color, finalUser?.balance ?? 0);
                await interaction.editReply({ embeds: [embed], components: buildButtons(gameId, true) }).catch(() => {});
            }

            releaseLock?.();
        });
    },
};
