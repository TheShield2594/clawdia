const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const COOLDOWN_MS = 2 * 3_600_000; // 2 hours

const ORES = [
    { name: 'Stone',       emoji: '🪨', payout: 10,   weight: 30 },
    { name: 'Coal',        emoji: '⬛', payout: 25,   weight: 25 },
    { name: 'Iron',        emoji: '🔩', payout: 50,   weight: 18 },
    { name: 'Gold',        emoji: '🟡', payout: 100,  weight: 12 },
    { name: 'Emerald',     emoji: '💚', payout: 200,  weight: 8  },
    { name: 'Ruby',        emoji: '🔴', payout: 350,  weight: 4  },
    { name: 'Diamond',     emoji: '💎', payout: 600,  weight: 2  },
    { name: 'Void Crystal',emoji: '🔮', payout: 1200, weight: 1  },
];

const TOTAL_WEIGHT = ORES.reduce((s, o) => s + o.weight, 0);

function roll() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (const o of ORES) { r -= o.weight; if (r <= 0) return o; }
    return ORES[0];
}

// Occasionally find multiple pieces
function quantity() {
    const r = Math.random();
    if (r < 0.05) return 3;
    if (r < 0.20) return 2;
    return 1;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Head into the mines and dig for ore'),

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

        if (user.lastMine && Date.now() - user.lastMine.getTime() < COOLDOWN_MS) {
            const remaining = COOLDOWN_MS - (Date.now() - user.lastMine.getTime());
            const mins = Math.ceil(remaining / 60000);
            return interaction.reply({ content: `The mines are closed for maintenance. Come back in **${mins} min**.`, ephemeral: true });
        }

        await interaction.deferReply();

        try {
            const ore = roll();
            const qty = quantity();
            const earned = ore.payout * qty;

            user.balance += earned;
            user.lastMine = new Date();
            await user.save();

            const embed = new EmbedBuilder()
                .setColor(ore.payout >= 600 ? '#f39c12' : ore.payout >= 200 ? '#2ecc71' : '#7f8c8d')
                .setTitle(`${ore.emoji} Mining Results`)
                .setDescription(
                    qty > 1
                        ? `You struck **${qty}x ${ore.name}** and earned **${currency}${earned.toLocaleString()}**!`
                        : `You found **${ore.name}** and earned **${currency}${earned.toLocaleString()}**!`
                )
                .addFields(
                    { name: 'Ore', value: `${ore.emoji} ${ore.name} ×${qty}`, inline: true },
                    { name: 'Earned', value: `${currency}${earned.toLocaleString()}`, inline: true },
                    { name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                )
                .setFooter({ text: 'The mines reopen in 2 hours' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Mine command error:', error);
            await interaction.editReply({ content: 'Something went wrong while mining.' });
        }
    }
};
