const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const COOLDOWN_MS = 3_600_000; // 1 hour

const CATCHES = [
    { name: 'Old Boot',       emoji: '👢', payout: 0,    weight: 15 },
    { name: 'Seaweed',        emoji: '🌿', payout: 5,    weight: 20 },
    { name: 'Small Fish',     emoji: '🐟', payout: 25,   weight: 25 },
    { name: 'Crab',           emoji: '🦀', payout: 50,   weight: 15 },
    { name: 'Salmon',         emoji: '🐡', payout: 80,   weight: 10 },
    { name: 'Lobster',        emoji: '🦞', payout: 120,  weight: 7  },
    { name: 'Swordfish',      emoji: '🐬', payout: 200,  weight: 5  },
    { name: 'Shark',          emoji: '🦈', payout: 350,  weight: 2  },
    { name: 'Golden Fish',    emoji: '✨', payout: 750,  weight: 1  },
];

const TOTAL_WEIGHT = CATCHES.reduce((s, c) => s + c.weight, 0);

function roll() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (const c of CATCHES) { r -= c.weight; if (r <= 0) return c; }
    return CATCHES[0];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('fish')
        .setDescription('Cast your line and see what you catch'),

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

        if (user.lastFish && Date.now() - user.lastFish.getTime() < COOLDOWN_MS) {
            const remaining = COOLDOWN_MS - (Date.now() - user.lastFish.getTime());
            const mins = Math.ceil(remaining / 60000);
            return interaction.reply({ content: `Your fishing rod needs a rest. Try again in **${mins} min**.`, ephemeral: true });
        }

        await interaction.deferReply();

        try {
            const catch_ = roll();
            user.balance += catch_.payout;
            user.lastFish = new Date();
            await user.save();

            const embed = new EmbedBuilder()
                .setColor(catch_.payout === 0 ? '#95a5a6' : catch_.payout >= 350 ? '#f39c12' : '#3498db')
                .setTitle(`${catch_.emoji} ${catch_.name}`)
                .setDescription(
                    catch_.payout === 0
                        ? `You reeled in a **${catch_.name}**. Better luck next time.`
                        : `You caught a **${catch_.name}** and earned **${currency}${catch_.payout.toLocaleString()}**!`
                )
                .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
                .setFooter({ text: 'Come back in 1 hour to fish again' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Fish command error:', error);
            await interaction.editReply({ content: 'Something went wrong while fishing.' });
        }
    }
};
