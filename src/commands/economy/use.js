const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('use')
        .setDescription('Use an item from your inventory')
        .addStringOption(o =>
            o.setName('item')
                .setDescription('Name of the item to use')
                .setRequired(true)),

    async execute(interaction) {
        const itemName = interaction.options.getString('item').trim();

        const [user, guildSettings] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id })
        ]);

        if (!user || !user.inventory?.length) {
            return interaction.reply({ content: "Your inventory is empty. Buy items with `/shop buy`.", ephemeral: true });
        }

        const invEntry = user.inventory.find(e => e.itemId.toLowerCase() === itemName.toLowerCase());
        if (!invEntry || invEntry.quantity < 1) {
            return interaction.reply({ content: `You don't have **${itemName}** in your inventory.`, ephemeral: true });
        }

        const shopItem = guildSettings?.shop?.find(s => s.name.toLowerCase() === itemName.toLowerCase());

        // Consume one from inventory
        invEntry.quantity -= 1;
        if (invEntry.quantity <= 0) {
            user.inventory = user.inventory.filter(e => e.itemId.toLowerCase() !== itemName.toLowerCase());
        }

        let roleGranted = false;
        if (shopItem?.roleId) {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (member && !member.roles.cache.has(shopItem.roleId)) {
                await member.roles.add(shopItem.roleId, `Used shop item: ${shopItem.name}`).catch(() => {});
                roleGranted = true;
            }
        }

        await user.save();

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`✅ Used: ${shopItem?.name ?? itemName}`)
            .setDescription(shopItem?.description || 'Item consumed from your inventory.')
            .setTimestamp();

        if (roleGranted) {
            embed.addFields({ name: 'Role Granted', value: `<@&${shopItem.roleId}>` });
        }

        const remaining = user.inventory.find(e => e.itemId.toLowerCase() === itemName.toLowerCase())?.quantity ?? 0;
        embed.addFields({ name: 'Remaining', value: `${remaining}x`, inline: true });

        await interaction.reply({ embeds: [embed] });
    }
};
