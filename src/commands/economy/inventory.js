const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inventory')
        .setDescription("View your or another user's inventory")
        .addUserOption(o => o.setName('user').setDescription('User to inspect')),

    async execute(interaction) {
        const target = interaction.options.getUser('user') ?? interaction.user;

        const [userData, guildSettings] = await Promise.all([
            User.findOne({ userId: target.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id })
        ]);

        const currency = guildSettings?.economy?.currency ?? '💰';

        if (!userData?.inventory?.length) {
            return interaction.reply({
                content: target.id === interaction.user.id
                    ? "Your inventory is empty. Buy items from the `/shop`!"
                    : `${target.username}'s inventory is empty.`,
                ephemeral: true
            });
        }

        const shopItems = guildSettings?.shop ?? [];

        const lines = userData.inventory.map(entry => {
            const shopItem = shopItems.find(s => s.name.toLowerCase() === entry.itemId.toLowerCase());
            const worth = shopItem ? `(worth ${currency}${shopItem.price} each)` : '';
            return `**${entry.itemId}** ×${entry.quantity} ${worth}`;
        });

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`${target.username}'s Inventory`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${userData.inventory.reduce((sum, e) => sum + e.quantity, 0)} total items` });

        await interaction.reply({ embeds: [embed] });
    }
};
