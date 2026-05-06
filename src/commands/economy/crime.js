const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const COOLDOWN_MS   = 4 * 3_600_000; // 4 hours
const SUCCESS_CHANCE = 0.40;

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
        .setDescription('Attempt a crime for a big payout — or pay a heavy fine'),

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

        if (user.lastCrime && Date.now() - user.lastCrime.getTime() < COOLDOWN_MS) {
            const remaining = COOLDOWN_MS - (Date.now() - user.lastCrime.getTime());
            const hrs = Math.ceil(remaining / 3_600_000);
            return interaction.reply({ content: `You're still on the radar from last time. Lay low for **${hrs}h**.`, ephemeral: true });
        }

        const crime   = CRIMES[Math.floor(Math.random() * CRIMES.length)];
        const success = Math.random() < SUCCESS_CHANCE;

        user.lastCrime = new Date();

        try {
            let embed;
            if (success) {
                const earned = Math.floor(crime.minPayout + Math.random() * (crime.maxPayout - crime.minPayout));
                user.balance += earned;
                await user.save();

                embed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle(`${crime.emoji} Crime Pays — This Time`)
                    .setDescription(`Your attempt at **${crime.name}** was a success! You pocketed **${currency}${earned.toLocaleString()}**.`)
                    .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
                    .setFooter({ text: 'Crimes can be committed every 4 hours' })
                    .setTimestamp();
            } else {
                const fine = Math.floor(50 + Math.random() * 200);
                const paid = Math.min(fine, user.balance);
                user.balance = Math.max(0, user.balance - paid);
                await user.save();

                const flavorText = FINES[Math.floor(Math.random() * FINES.length)];
                embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle(`${crime.emoji} Busted!`)
                    .setDescription(`Your attempt at **${crime.name}** went sideways. ${flavorText}\nYou were fined **${currency}${paid.toLocaleString()}**.`)
                    .addFields({ name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                               { name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
                    .setFooter({ text: 'Crimes can be committed every 4 hours' })
                    .setTimestamp();
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
