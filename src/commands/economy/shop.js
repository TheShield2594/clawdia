const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../../models/Guild');
const User = require('../../models/User');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Browse and buy items from the server shop')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('Browse available items'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase an item')
                .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add an item to the shop (admin only)')
                .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
                .addIntegerOption(o => o.setName('price').setDescription('Price in coins').setRequired(true).setMinValue(1))
                .addStringOption(o => o.setName('description').setDescription('Item description'))
                .addRoleOption(o => o.setName('role').setDescription('Role to grant on purchase'))
                .addIntegerOption(o => o.setName('stock').setDescription('Stock limit (-1 = unlimited)').setMinValue(-1)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove an item from the shop (admin only)')
                .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        const currency = guildSettings.economy.currency;

        if (sub === 'view') {
            if (!guildSettings.shop.length) {
                return interaction.reply({ content: 'The shop is empty. Admins can add items with `/shop add`.', ephemeral: true });
            }

            const lines = guildSettings.shop.map((item, i) => {
                const stock = item.stock === -1 ? '∞' : item.stock;
                const roleTag = item.roleId ? ` → <@&${item.roleId}>` : '';
                return `**${i + 1}. ${item.name}** — ${currency}${item.price} (Stock: ${stock})${roleTag}\n${item.description || ''}`;
            });

            const embed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle(`${interaction.guild.name} Shop`)
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: 'Use /shop buy <item name> to purchase' });

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'buy') {
            const itemName = interaction.options.getString('item').toLowerCase();
            const item = guildSettings.shop.find(i => i.name.toLowerCase() === itemName);

            if (!item) {
                return interaction.reply({ content: `Item \`${itemName}\` not found. Use \`/shop view\` to see available items.`, ephemeral: true });
            }

            if (item.stock === 0) {
                return interaction.reply({ content: 'That item is out of stock!', ephemeral: true });
            }

            const userData = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            );

            if (userData.balance < item.price) {
                return interaction.reply({
                    content: `You need ${currency}${item.price} but only have ${currency}${userData.balance}.`,
                    ephemeral: true
                });
            }

            userData.balance -= item.price;

            const invEntry = userData.inventory.find(e => e.itemId === item.name);
            if (invEntry) {
                invEntry.quantity += 1;
            } else {
                userData.inventory.push({ itemId: item.name, quantity: 1 });
            }

            if (item.stock > 0) item.stock -= 1;

            await Promise.all([userData.save(), guildSettings.save()]);

            if (item.roleId) {
                await interaction.member.roles.add(item.roleId).catch(console.error);
            }

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Purchase Successful')
                .setDescription(`You bought **${item.name}** for ${currency}${item.price}.`)
                .addFields({ name: 'New Balance', value: `${currency}${userData.balance}`, inline: true });

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'add') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'You need Manage Server permission to edit the shop.', ephemeral: true });
            }

            const name = interaction.options.getString('name');
            const price = interaction.options.getInteger('price');
            const description = interaction.options.getString('description') ?? '';
            const role = interaction.options.getRole('role');
            const stock = interaction.options.getInteger('stock') ?? -1;

            if (guildSettings.shop.find(i => i.name.toLowerCase() === name.toLowerCase())) {
                return interaction.reply({ content: 'An item with that name already exists.', ephemeral: true });
            }

            guildSettings.shop.push({
                name,
                description,
                price,
                roleId: role?.id ?? null,
                stock
            });
            await guildSettings.save();

            await interaction.reply({ content: `Added **${name}** to the shop for ${currency}${price}.` });
        }

        if (sub === 'remove') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'You need Manage Server permission to edit the shop.', ephemeral: true });
            }

            const name = interaction.options.getString('name').toLowerCase();
            const before = guildSettings.shop.length;
            guildSettings.shop = guildSettings.shop.filter(i => i.name.toLowerCase() !== name);

            if (guildSettings.shop.length === before) {
                return interaction.reply({ content: `Item \`${name}\` not found.`, ephemeral: true });
            }

            await guildSettings.save();
            await interaction.reply({ content: `Removed **${name}** from the shop.` });
        }
    }
};
