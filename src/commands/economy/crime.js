const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasEffect, consumeEffect } = require('../../services/effectsService');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { clampMultiplier } = require('../../config/economy');
const { logTransaction } = require('../../utils/logTransaction');
const { getTotalBonus } = require('../../services/petService');

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

        const currency = guildSettings?.economy?.currency || '💰';

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );

        if (user.wantedUntil && Date.now() < user.wantedUntil.getTime()) {
            const remaining = user.wantedUntil.getTime() - Date.now();
            const mins = Math.ceil(remaining / 60_000);
            return interaction.reply({ content: `🚨 You're still **wanted by the police**! Lay low for **${mins} min** before attempting another crime.`, ephemeral: true });
        }

        if (user.lastCrime && Date.now() - user.lastCrime.getTime() < COOLDOWN_MS) {
            const remaining = COOLDOWN_MS - (Date.now() - user.lastCrime.getTime());
            const mins = Math.ceil(remaining / 60_000);
            const display = mins >= 60 ? (mins % 60 === 0 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`) : `${mins}m`;
            return interaction.reply({ content: `You're still on the radar from last time. Lay low for **${display}**.`, ephemeral: true });
        }

        // Sample 3 random crimes and present them as buttons
        const shuffled = [...CRIMES].sort(() => Math.random() - 0.5);
        const choices = shuffled.slice(0, 3);

        const row = new ActionRowBuilder().addComponents(
            choices.map(c => new ButtonBuilder()
                .setCustomId(c.name)
                .setLabel(`${c.emoji} ${c.displayName}  ·  ${c.riskEmoji}`)
                .setStyle(ButtonStyle.Secondary)
            )
        );

        const selectionEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle('🌆 Tonight\'s Jobs')
            .setDescription('Three options on the table.\nPick your play — or let the clock decide.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━')
            .addFields(
                choices.map(c => ({
                    name: `${c.emoji} ${c.displayName}`,
                    value: `${c.riskLabel}\n🎯 ${Math.round(c.successRate * 100)}% success\n💵 ${c.minPayout}–${c.maxPayout}  ·  Fine: ${c.minFine}–${c.maxFine}`,
                    inline: true,
                }))
            )
            .setFooter({ text: '15 seconds. No choice and it gets chosen for you.' })
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
                const baseEarned = Math.floor(crime.minPayout + Math.random() * (crime.maxPayout - crime.minPayout));
                const earned = Math.round(baseEarned * streakMult);
                const updated = await User.findOneAndUpdate(
                    userFilter,
                    { $inc: { balance: earned }, $set: { lastCrime: crimeTime } },
                    { new: true }
                );

                logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime', amount: earned, balance: updated.balance, note: `${crime.name} (success)` });

                let desc = `Another score. The heat hasn't found you yet.`;
                if (luckyActive) desc += `\n> 🍀 *Lucky Charm boosted your success chance!*`;
                if (petCrimeBonus > 0) desc += `\n> 🐱 *Cat pet boosted your success chance!*`;
                desc += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${currency} Earned: ${earned.toLocaleString()} coins`;
                if (streakMult > 1.0) desc += `\n  🔥 Streak bonus: ${streakMult}x applied`;
                desc += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Balance: ${updated.balance.toLocaleString()} coins`;

                embed = new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${crime.emoji} ${crime.displayName} — Clean Getaway`)
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

                    const critDesc =
                        `You tried to pull it off.\nYou didn't make it out.\n\n> "${flavorText}"\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `  💸 Seized: ${currency}${lost.toLocaleString()} coins  (${Math.round(lossRate * 100)}% of wallet)\n` +
                        `  💰 Remaining: ${updated.balance.toLocaleString()} coins\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━`;

                    embed = new EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle(`💀 ${crime.displayName} — Everything Went Wrong`)
                        .setDescription(critDesc)
                        .setFooter({ text: 'Cooldown: 1.5h • Purchase a Lifesaver from /shop to protect against critical failures' })
                        .setTimestamp();
                } else {
                    const rawFine = Math.floor(crime.minFine + Math.random() * (crime.maxFine - crime.minFine));
                    const maxFine = Math.max(crime.minFine, Math.floor(user.balance * 0.20));
                    const fine = Math.min(rawFine, maxFine);
                    const paid = Math.min(fine, user.balance);
                    const updated = await User.findOneAndUpdate(
                        userFilter,
                        { $inc: { balance: -paid }, $set: { lastCrime: crimeTime } },
                        { new: true }
                    );

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_fine', amount: -paid, balance: updated.balance, note: `${crime.name} (busted)` });

                    embed = new EmbedBuilder()
                        .setColor('#e74c3c')
                        .setTitle(`${crime.emoji} ${crime.displayName} — Busted`)
                        .setDescription(`Your attempt went sideways. ${flavorText}\nYou were fined **${currency}${paid.toLocaleString()}**.`)
                        .addFields(
                            { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                            { name: 'Balance',   value: `${currency}${updated.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1.5h' })
                        .setTimestamp();
                }
            }

            if (buttonInteraction) {
                await buttonInteraction.update({ embeds: [embed], components: [] });
            } else {
                await interaction.editReply({ embeds: [embed], components: [] });
            }
        } catch (error) {
            console.error('Crime command error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
            }
        }
    }
};
