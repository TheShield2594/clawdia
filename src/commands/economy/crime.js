const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasEffect, consumeEffect } = require('../../services/effectsService');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');

const COOLDOWN_MS      = 2.5 * 3_600_000; // 2.5 hours
const WANTED_MS        = 0.5 * 3_600_000; // 30 min wanted cooldown after death
const BASE_SUCCESS     = 0.40;
const DEATH_RATE       = 0.08;          // 8% of failures trigger critical death
const DEATH_LOSS_MIN   = 0.15;
const DEATH_LOSS_MAX   = 0.30;

const CRIMES = [
    { name: 'pickpocketing',       emoji: '🤏', minPayout: 80,   maxPayout: 200  },
    { name: 'selling fake merch',  emoji: '🛍️', minPayout: 100,  maxPayout: 300  },
    { name: 'hacking ATMs',        emoji: '💻', minPayout: 200,  maxPayout: 500  },
    { name: 'art forgery',         emoji: '🖼️', minPayout: 300,  maxPayout: 700  },
    { name: 'casino cheating',     emoji: '🎰', minPayout: 400,  maxPayout: 1000 },
    { name: 'grand larceny',       emoji: '💎', minPayout: 600,  maxPayout: 1500 },
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
        .setDescription('Attempt a crime for 80–1,500 coins (40% success). Caught? You pay a fine instead. Cooldown: 2.5h.'),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency || '💰';

        let user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            {},
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

        const crime = CRIMES[Math.floor(Math.random() * CRIMES.length)];

        // Lucky Charm: +20% success rate on crime
        let successChance = BASE_SUCCESS;
        const luckyActive = hasEffect(user, 'lucky_charm');
        if (luckyActive) successChance = Math.min(0.95, successChance + 0.20);

        const success = Math.random() < successChance;
        user.lastCrime = new Date();

        const streakMult = getStreakMultiplier(user.streak?.current ?? 0);
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
                    .setFooter({ text: 'Cooldown: 2.5h' })
                    .setTimestamp();
            } else {
                const flavorText = FINES[Math.floor(Math.random() * FINES.length)];
                const isCriticalFailure = Math.random() < DEATH_RATE;

                // Lifesaver: absorbs any failure — no fine or death losses
                const lifesaverActive = hasEffect(user, 'lifesaver');
                if (lifesaverActive) {
                    consumeEffect(user, 'lifesaver');
                    const wouldHaveLost = isCriticalFailure
                        ? Math.floor(user.balance * (DEATH_LOSS_MIN + Math.random() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN)))
                        : Math.floor(Math.random() * 151) + 50;
                    user.lastCrime = new Date();
                    await user.save();

                    embed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle(`${crime.emoji} Saved by the Lifesaver!`)
                        .setDescription(`Your attempt at **${crime.name}** went sideways. ${flavorText}\n> 🛟 *Your Lifesaver activated and saved you! No coins lost! (consumed)*`)
                        .addFields(
                            { name: isCriticalFailure ? 'Death Loss Absorbed' : 'Fine Absorbed', value: `${currency}${Math.min(wouldHaveLost, user.balance).toLocaleString()}`, inline: true },
                            { name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 2.5h' })
                        .setTimestamp();
                } else if (isCriticalFailure) {
                    // Critical failure: lose 15–30% of wallet, enter "wanted" status
                    const lossRate = DEATH_LOSS_MIN + Math.random() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN);
                    const lost = Math.floor(user.balance * lossRate);
                    user.balance = Math.max(0, user.balance - lost);
                    user.wantedUntil = new Date(Date.now() + WANTED_MS);
                    user.lastCrime = new Date();
                    await user.save();

                    embed = new EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle(`💀 ${crime.emoji} Caught — You're Wanted!`)
                        .setDescription(
                            `Your attempt at **${crime.name}** ended catastrophically. ${flavorText}\n\n` +
                            `**The police seized ${Math.round(lossRate * 100)}% of your wallet.**\n` +
                            `> 🚨 You are now **wanted** — no crimes for 30 minutes.`
                        )
                        .addFields(
                            { name: '💸 Lost',           value: `${currency}${lost.toLocaleString()}`,          inline: true },
                            { name: '💰 Remaining',      value: `${currency}${user.balance.toLocaleString()}`,  inline: true },
                            { name: '⏳ Wanted For',     value: '30 minutes',                                   inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 2.5h • Purchase a Lifesaver from /shop to protect against death events' })
                        .setTimestamp();
                } else {
                    const fine = Math.floor(Math.random() * 151) + 50;
                    const paid = Math.min(fine, user.balance);
                    user.balance = Math.max(0, user.balance - paid);
                    user.lastCrime = new Date();
                    await user.save();

                    embed = new EmbedBuilder()
                        .setColor('#e74c3c')
                        .setTitle(`${crime.emoji} Busted!`)
                        .setDescription(`Your attempt at **${crime.name}** went sideways. ${flavorText}\nYou were fined **${currency}${paid.toLocaleString()}**.`)
                        .addFields(
                            { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 2.5h' })
                        .setTimestamp();
                }
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Crime command error:', error);
            if (!interaction.replied) {
                await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
            }
        }
    }
};
