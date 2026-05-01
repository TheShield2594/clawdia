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
                .addIntegerOption(o => o.setName('stock').setDescription('Stock limit (-1 = unlimited)').setMinValue(-1))
                .addStringOption(o => o.setName('image_url').setDescription('Image URL shown for this item')))
        .addSubcommand(sub =>
            sub.setName('edit')
                .setDescription('Edit an existing shop item (admin only)')
                .addStringOption(o => o.setName('name').setDescription('Existing item name').setRequired(true))
                .addStringOption(o => o.setName('new_name').setDescription('Updated item name'))
                .addIntegerOption(o => o.setName('price').setDescription('Updated price in coins').setMinValue(1))
                .addStringOption(o => o.setName('description').setDescription('Updated item description'))
                .addRoleOption(o => o.setName('role').setDescription('Updated role to grant on purchase'))
                .addIntegerOption(o => o.setName('stock').setDescription('Updated stock (-1 = unlimited)').setMinValue(-1))
                .addStringOption(o => o.setName('image_url').setDescription('Updated image URL')))
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
                const imageTag = item.imageUrl ? `\nImage: ${item.imageUrl}` : '';
                return `**${i + 1}. ${item.name}** — ${currency}${item.price} (Stock: ${stock})${roleTag}\n${item.description || ''}${imageTag}`;
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

            if (item.imageUrl) {
                embed.setThumbnail(item.imageUrl);
            }

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
            const imageUrl = interaction.options.getString('image_url') ?? '';

            if (guildSettings.shop.find(i => i.name.toLowerCase() === name.toLowerCase())) {
                return interaction.reply({ content: 'An item with that name already exists.', ephemeral: true });
            }

            guildSettings.shop.push({
                name,
                description,
                price,
                roleId: role?.id ?? null,
                stock,
                imageUrl
            });
            await guildSettings.save();

            await interaction.reply({ content: `Added **${name}** to the shop for ${currency}${price}.` });
        }

        if (sub === 'edit') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: 'You need Manage Server permission to edit the shop.', ephemeral: true });
            }

            const name = interaction.options.getString('name').toLowerCase();
            const item = guildSettings.shop.find(i => i.name.toLowerCase() === name);

            if (!item) {
                return interaction.reply({ content: `Item \`${name}\` not found.`, ephemeral: true });
            }

            const newName = interaction.options.getString('new_name');
            const price = interaction.options.getInteger('price');
            const description = interaction.options.getString('description');
            const role = interaction.options.getRole('role');
            const stock = interaction.options.getInteger('stock');
            const imageUrl = interaction.options.getString('image_url');

            if (newName && newName.toLowerCase() !== name) {
                const duplicate = guildSettings.shop.find(i => i.name.toLowerCase() === newName.toLowerCase());
                if (duplicate) {
                    return interaction.reply({ content: 'An item with that new name already exists.', ephemeral: true });
                }
                item.name = newName;
            }

            if (price !== null) item.price = price;
            if (description !== null) item.description = description;
            if (stock !== null) item.stock = stock;
            if (imageUrl !== null) item.imageUrl = imageUrl;
            if (role) item.roleId = role.id;

            await guildSettings.save();
            await interaction.reply({ content: `Updated **${item.name}**.` });
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
