const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasEffect, consumeEffect } = require('../../services/effectsService');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { clampMultiplier } = require('../../config/economy');

const COOLDOWN_MS    = 1.5 * 3_600_000; // 1.5 hours
const DEATH_RATE     = 0.08;            // 8% of failures trigger critical death
const DEATH_LOSS_MIN = 0.15;
const DEATH_LOSS_MAX = 0.30;

const CRIMES = [
    { name: 'pickpocketing',      emoji: '🤏', successRate: 0.60, minPayout: 80,   maxPayout: 200,  minFine: 50,  maxFine: 100 },
    { name: 'selling fake merch', emoji: '🛍️', successRate: 0.55, minPayout: 100,  maxPayout: 300,  minFine: 75,  maxFine: 150 },
    { name: 'hacking ATMs',       emoji: '💻', successRate: 0.45, minPayout: 200,  maxPayout: 500,  minFine: 100, maxFine: 200 },
    { name: 'art forgery',        emoji: '🖼️', successRate: 0.40, minPayout: 300,  maxPayout: 700,  minFine: 150, maxFine: 300 },
    { name: 'casino cheating',    emoji: '🎰', successRate: 0.35, minPayout: 400,  maxPayout: 1000, minFine: 200, maxFine: 400 },
    { name: 'grand larceny',      emoji: '💎', successRate: 0.25, minPayout: 600,  maxPayout: 1500, minFine: 300, maxFine: 600 },
];

const FINES = [
    'You were caught by an undercover officer.',
    'A bystander called the police on you.',
    'Security footage gave you away.',
    'Your partner-in-crime ratted you out.',
    'Your disguise fell off at the worst moment.',
];

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

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
                .setLabel(`${c.emoji} ${capitalize(c.name)}`)
                .setStyle(ButtonStyle.Secondary)
            )
        );

        const selectionEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle('🦹 Choose Your Crime')
            .setDescription(
                choices.map(c =>
                    `${c.emoji} **${capitalize(c.name)}** — ${Math.round(c.successRate * 100)}% success | ${currency}${c.minPayout}–${c.maxPayout} payout | Fine: ${currency}${c.minFine}–${c.maxFine}`
                ).join('\n')
            )
            .setFooter({ text: 'You have 15 seconds to choose. No choice = random auto-selection.' })
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

        const success = Math.random() < successChance;
        user.lastCrime = new Date();

        const streakMult = clampMultiplier(getStreakMultiplier(user.streak?.current ?? 0));

        try {
            let embed;
            if (success) {
                const baseEarned = Math.floor(crime.minPayout + Math.random() * (crime.maxPayout - crime.minPayout));
                const earned = Math.round(baseEarned * streakMult);
                user.balance += earned;
                await user.save();

                const streakLine = streakMult > 1.0 ? `\n> 🔥 *${streakMult}x streak bonus applied!*` : '';
                embed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle(`${crime.emoji} Crime Pays — This Time`)
                    .setDescription(`Your attempt at **${crime.name}** was a success! You pocketed **${currency}${earned.toLocaleString()}**.${luckyActive ? '\n> 🍀 *Lucky Charm boosted your success chance!*' : ''}${streakLine}`)
                    .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
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
                    await user.save();

                    embed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle(`${crime.emoji} Saved by the Lifesaver!`)
                        .setDescription(`Your attempt at **${crime.name}** went sideways. ${flavorText}\n> 🛟 *Your Lifesaver activated and saved you! No coins lost! (consumed)*`)
                        .addFields(
                            { name: isCriticalFailure ? 'Death Loss Absorbed' : 'Fine Absorbed', value: `${currency}${Math.min(wouldHaveLost, user.balance).toLocaleString()}`, inline: true },
                            { name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1.5h' })
                        .setTimestamp();
                } else if (isCriticalFailure) {
                    const lossRate = DEATH_LOSS_MIN + Math.random() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN);
                    const lost = Math.floor(user.balance * lossRate);
                    user.balance = Math.max(0, user.balance - lost);
                    await user.save();

                    embed = new EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle(`💀 ${crime.emoji} Critical Failure!`)
                        .setDescription(
                            `Your attempt at **${crime.name}** ended catastrophically. ${flavorText}\n\n` +
                            `**The police seized ${Math.round(lossRate * 100)}% of your wallet.**`
                        )
                        .addFields(
                            { name: '💸 Lost',      value: `${currency}${lost.toLocaleString()}`,         inline: true },
                            { name: '💰 Remaining', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1.5h • Purchase a Lifesaver from /shop to protect against critical failures' })
                        .setTimestamp();
                } else {
                    const rawFine = Math.floor(crime.minFine + Math.random() * (crime.maxFine - crime.minFine));
                    const maxFine = Math.max(crime.minFine, Math.floor(user.balance * 0.20));
                    const fine = Math.min(rawFine, maxFine);
                    const paid = Math.min(fine, user.balance);
                    user.balance = Math.max(0, user.balance - paid);
                    await user.save();

                    embed = new EmbedBuilder()
                        .setColor('#e74c3c')
                        .setTitle(`${crime.emoji} Busted!`)
                        .setDescription(`Your attempt at **${crime.name}** went sideways. ${flavorText}\nYou were fined **${currency}${paid.toLocaleString()}**.`)
                        .addFields(
                            { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`, inline: true }
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
