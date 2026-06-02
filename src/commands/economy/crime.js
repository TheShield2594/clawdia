const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasEffect, consumeEffect } = require('../../services/effectsService');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { clampMultiplier } = require('../../config/economy');
const { logTransaction } = require('../../utils/logTransaction');
const { getTotalBonus } = require('../../services/petService');
const { randomFrom, CRIME_WIN_LINES, CRIME_BUST_LINES, getCrimeFlavorText } = require('../../utils/copyLines');
const { delay } = require('../../utils/delay');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { isDistrictActive } = require('../../services/districtService');

const COOLDOWN_MS    = 1.5 * 3_600_000; // 1.5 hours
const DEATH_RATE     = 0.08;            // 8% of failures trigger critical death
const DEATH_LOSS_MIN = 0.15;
const DEATH_LOSS_MAX = 0.30;

const CRIMES = [
    { name: 'pickpocketing',      displayName: 'Quick Snatch',  emoji: '🤏', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        riskTag: 'Safe',      successRate: 0.60, minPayout: 80,   maxPayout: 200,  minFine: 50,  maxFine: 100 },
    { name: 'selling fake merch', displayName: 'Street Hustle', emoji: '🛍️', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        riskTag: 'Safe',      successRate: 0.55, minPayout: 100,  maxPayout: 300,  minFine: 75,  maxFine: 150 },
    { name: 'hacking ATMs',       displayName: 'ATM Ghost',     emoji: '💻', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', riskTag: 'Balanced',  successRate: 0.45, minPayout: 200,  maxPayout: 500,  minFine: 100, maxFine: 200 },
    { name: 'art forgery',        displayName: 'The Forgery',   emoji: '🖼️', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', riskTag: 'Balanced',  successRate: 0.40, minPayout: 300,  maxPayout: 700,  minFine: 150, maxFine: 300 },
    { name: 'casino cheating',    displayName: 'Casino Con',    emoji: '🎰', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       riskTag: 'Dangerous', successRate: 0.35, minPayout: 400,  maxPayout: 1000, minFine: 200, maxFine: 400 },
    { name: 'grand larceny',      displayName: 'The Score',     emoji: '💎', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       riskTag: 'Dangerous', successRate: 0.25, minPayout: 600,  maxPayout: 1500, minFine: 300, maxFine: 600 },
];

const FINES = [
    'You were caught by an undercover officer.',
    'A bystander called the police on you.',
    'Security footage gave you away.',
    'Your partner-in-crime ratted you out.',
    'Your disguise fell off at the worst moment.',
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('crime')
        .setDescription('Choose a crime and attempt it for coins. Higher risk = higher reward. Cooldown: 1.5h.'),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        if (guildSettings?.economy?.crimeEnabled === false) {
            return interaction.reply({ content: 'The crime command is disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency || '💰';

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );

        if (user.wantedUntil && Date.now() < user.wantedUntil.getTime()) {
            const nextAt = new Date(user.wantedUntil.getTime());
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🚨 Still Wanted',
                    description: 'The city has eyes on you. Lay low. 🚨\nDon\'t even think about running another job until the heat breaks.',
                    color: '#e74c3c',
                    nextAt,
                    nextRewardPreview: 'Once clear: Grand Larceny pays 600–1500 coins · Casino Con is next on the board',
                })],
                ephemeral: true,
            });
        }

        if (user.lastCrime && Date.now() - user.lastCrime.getTime() < COOLDOWN_MS) {
            const nextAt = new Date(user.lastCrime.getTime() + COOLDOWN_MS);
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🌆 Laying Low',
                    description: "You're still on the radar from last time.\nLie low. Let the heat fade.",
                    color: '#f39c12',
                    nextAt,
                    nextRewardPreview: 'Next run: three new crimes roll — pick the right one for up to 1,500 coins',
                })],
                ephemeral: true,
            });
        }

        // Sample 3 random crimes and present them as buttons
        const featured = getDailyFeatured(interaction.guild.id);
        const timeBand = getTimeBand();

        // Ensure the featured crime appears in the choices at least once
        const shuffled = [...CRIMES].sort(() => Math.random() - 0.5);
        let choices = shuffled.slice(0, 3);
        if (!choices.some(c => c.name === featured.crime.name)) {
            choices[Math.floor(Math.random() * 3)] = CRIMES.find(c => c.name === featured.crime.name) ?? choices[0];
        }

        const row = new ActionRowBuilder().addComponents(
            choices.map(c => {
                const isFeatured = c.name === featured.crime.name;
                return new ButtonBuilder()
                    .setCustomId(c.name)
                    .setLabel(`${isFeatured ? '🌟 ' : ''}${c.emoji} ${c.displayName}  ·  ${c.riskEmoji}`)
                    .setStyle(isFeatured ? ButtonStyle.Primary : ButtonStyle.Secondary);
            })
        );

        const crimeLines = choices.map(c => {
            const isFeatured = c.name === featured.crime.name;
            const featuredTag = isFeatured ? `\n  🌟 **FEATURED** — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout bonus!` : '';
            return (
                `**${isFeatured ? '🌟 ' : ''}${c.emoji} ${c.displayName}** ${c.riskEmoji}\n` +
                `${c.riskLabel}\n` +
                `🎯 ${Math.round(c.successRate * 100)}% success · 💵 ${c.minPayout}–${c.maxPayout} · Fine: ${c.minFine}–${c.maxFine}` +
                featuredTag
            );
        }).join('\n\n');

        const selectionEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle('🌆 Tonight\'s Jobs')
            .setDescription(`Three options on the table. Pick your play — or let the clock decide.\n\n${crimeLines}`)
            .setFooter({ text: `${timeBand.emoji} ${timeBand.label} · 15 seconds. No choice and it gets chosen for you.` })
            .setTimestamp();

        const response = await interaction.reply({ embeds: [selectionEmbed], components: [row], fetchReply: true });

        let crime;
        let buttonInteraction = null;
        try {
            buttonInteraction = await response.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 15_000,
            });
            crime = CRIMES.find(c => c.name === buttonInteraction.customId);
            // Acknowledge the button immediately so Discord doesn't time it out
            await buttonInteraction.deferUpdate();
        } catch {
            // Timeout — auto-select from the presented choices
            crime = choices[Math.floor(Math.random() * choices.length)];
        }

        // Lucky Charm: +20% success rate on crime
        let successChance = crime.successRate;
        const luckyActive = hasEffect(user, 'lucky_charm');
        if (luckyActive) successChance = Math.min(0.95, successChance + 0.20);

        // Cat pet: +5% crime success chance (only if hunger >= 30)
        const petCrimeBonus = getTotalBonus(user.pets || [], 'crime_success') / 100;
        if (petCrimeBonus > 0) successChance = Math.min(0.95, successChance + petCrimeBonus);

        const success = Math.random() < successChance;
        const crimeTime = new Date();

        const streakMult = clampMultiplier(getStreakMultiplier(user.streak?.current ?? 0));

        try {
            let embed;
            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            if (success) {
                const isFeaturedCrime = crime.name === featured.crime.name;
                const baseEarned = Math.floor(crime.minPayout + Math.random() * (crime.maxPayout - crime.minPayout));
                let earned = Math.round(baseEarned * streakMult);
                if (isFeaturedCrime) earned = Math.round(earned * (1 + FEATURED_PAYOUT_BONUS));

                const updated = await User.findOneAndUpdate(
                    userFilter,
                    { $inc: { balance: earned }, $set: { lastCrime: crimeTime } },
                    { new: true }
                );

                logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime', amount: earned, balance: updated.balance, note: `${crime.name} (success)${isFeaturedCrime ? ' [featured]' : ''}` });

                // Log big win if payout is large enough
                const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
                if (earned >= bigWinThreshold) {
                    logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: earned, source: 'crime', details: crime.displayName });
                }

                let flavorWin = getCrimeFlavorText(crime.name, 'win')
                    .replace('{amount}', earned.toLocaleString());
                let desc = flavorWin;
                if (luckyActive) desc += `\n> 🍀 *Lucky Charm boosted your success chance!*`;
                if (petCrimeBonus > 0) desc += `\n> 🐱 *Cat pet boosted your success chance!*`;
                if (isFeaturedCrime) desc += `\n> 🌟 *Featured job — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout applied!*`;
                // Crime streak bonus flavor
                const crimeStreak = user._crimeStreak ?? 0;
                if (crimeStreak >= 2) desc += `\n> 🔥 *${crimeStreak + 1} clean jobs in a row. The streets are talking.*`;
                desc += `\n\n────────────────────\n  ${currency} Earned: ${earned.toLocaleString()} coins`;
                if (streakMult > 1.0) desc += `\n  🔥 Streak bonus: ${streakMult}x applied`;
                desc += `\n────────────────────\n  Balance: ${updated.balance.toLocaleString()} coins`;

                embed = new EmbedBuilder()
                    .setColor(isFeaturedCrime ? '#FFD700' : '#2ecc71')
                    .setTitle(`${isFeaturedCrime ? '🌟 ' : ''}${crime.emoji} ${crime.displayName} — Clean Getaway`)
                    .setDescription(desc)
                    .setFooter({ text: 'Cooldown: 1.5h' })
                    .setTimestamp();
            } else {
                const flavorText = FINES[Math.floor(Math.random() * FINES.length)];
                const isCriticalFailure = Math.random() < DEATH_RATE;

                const lifesaverActive = hasEffect(user, 'lifesaver');
                if (lifesaverActive) {
                    consumeEffect(user, 'lifesaver');
                    const wouldHaveLost = isCriticalFailure
                        ? Math.floor(user.balance * (DEATH_LOSS_MIN + Math.random() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN)))
                        : Math.floor(crime.minFine + Math.random() * (crime.maxFine - crime.minFine));
                    await User.findOneAndUpdate(
                        userFilter,
                        { $set: { lastCrime: crimeTime, activeEffects: user.activeEffects } }
                    );

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_lifesaver', amount: 0, balance: user.balance, note: `${crime.name} (lifesaver, would have lost ${wouldHaveLost})` });

                    embed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle(`${crime.emoji} Saved by the Lifesaver!`)
                        .setDescription(`Your attempt at **${crime.displayName}** went sideways. ${flavorText}\n> 🛟 *Your Lifesaver activated and saved you! No coins lost! (consumed)*`)
                        .addFields(
                            { name: isCriticalFailure ? 'Death Loss Absorbed' : 'Fine Absorbed', value: `${currency}${Math.min(wouldHaveLost, user.balance).toLocaleString()}`, inline: true },
                            { name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1.5h' })
                        .setTimestamp();
                } else if (isCriticalFailure) {
                    const lossRate = DEATH_LOSS_MIN + Math.random() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN);
                    const lost = Math.floor(user.balance * lossRate);
                    const updated = await User.findOneAndUpdate(
                        userFilter,
                        { $inc: { balance: -lost }, $set: { lastCrime: crimeTime } },
                        { new: true }
                    );

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_critical_fail', amount: -lost, balance: updated.balance, note: `${crime.name} (critical failure, ${Math.round(lossRate * 100)}% seized)` });

                    const critNarrative = getCrimeFlavorText(crime.name, 'fail')
                        .replace('{fine}', lost.toLocaleString())
                        .replace('{amount}', lost.toLocaleString());
                    const critDesc =
                        `${critNarrative}\n\n> *${flavorText}*\n\n` +
                        `────────────────────\n` +
                        `  💸 Seized: ${currency}${lost.toLocaleString()} coins  (${Math.round(lossRate * 100)}% of wallet)\n` +
                        `  💰 Remaining: ${updated.balance.toLocaleString()} coins\n` +
                        `────────────────────`;

                    embed = new EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle(`💀 ${crime.displayName} — Everything Went Wrong`)
                        .setDescription(critDesc)
                        .setFooter({ text: 'Cooldown: 1.5h • Purchase a Lifesaver from /shop to protect against critical failures' })
                        .setTimestamp();
                } else {
                    const undergroundActive = isDistrictActive(guildSettings, 'underground');
                    const rawFine = Math.floor(crime.minFine + Math.random() * (crime.maxFine - crime.minFine));
                    const maxFine = Math.max(crime.minFine, Math.floor(user.balance * 0.20));
                    let fine = Math.min(rawFine, maxFine);
                    if (undergroundActive) fine = Math.floor(fine * 0.85);
                    const paid = Math.min(fine, user.balance);
                    const updated = await User.findOneAndUpdate(
                        userFilter,
                        { $inc: { balance: -paid }, $set: { lastCrime: crimeTime } },
                        { new: true }
                    );

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_fine', amount: -paid, balance: updated.balance, note: `${crime.name} (busted)` });

                    const bustNarrative = getCrimeFlavorText(crime.name, 'fail')
                        .replace('{fine}', paid.toLocaleString())
                        .replace('{amount}', paid.toLocaleString());
                    const undergroundStr = undergroundActive ? '\n> 🌑 *Underground district active — fine reduced by 15%!*' : '';
                    embed = new EmbedBuilder()
                        .setColor('#e74c3c')
                        .setTitle(`${crime.emoji} ${crime.displayName} — Busted`)
                        .setDescription(`${bustNarrative}\n\n> *${flavorText}*${undergroundStr}`)
                        .addFields(
                            { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                            { name: 'Balance',   value: `${currency}${updated.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1.5h' })
                        .setTimestamp();
                }
            }

            // Suspense delay between selection and result reveal
            const suspenseEmbed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`${crime.emoji} Running the Job…`)
                .setDescription(`*${crime.displayName} in progress…*`);
            await interaction.editReply({ embeds: [suspenseEmbed], components: [] });
            await delay(900);
            await interaction.editReply({ embeds: [embed], components: [] });
        } catch (error) {
            console.error('Crime command error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
            }
        }
    }
};
