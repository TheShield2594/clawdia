const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    PermissionFlagsBits
} = require('discord.js');
const Guild = require('../../models/Guild');
const User = require('../../models/User');

const PAGE_SIZE = 5;
const CONFIRM_THRESHOLD = 500;

function buildViewEmbed(items, page, totalPages, guildName, currency, userBalance) {
    const start = page * PAGE_SIZE;
    const slice = items.slice(start, start + PAGE_SIZE);

    const lines = slice.map((item, i) => {
        const stock = item.stock === -1 ? '∞' : item.stock;
        const roleTag = item.roleId ? ` → <@&${item.roleId}>` : '';
        return `**${start + i + 1}. ${item.name}** — ${currency}${item.price.toLocaleString()} (Stock: ${stock})${roleTag}\n${item.description || '*No description*'}`;
    });

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`${guildName} Shop`)
        .setDescription(lines.join('\n\n'));

    const footerParts = [`Use /shop buy <item name> to purchase`];
    if (userBalance !== null) footerParts.push(`Your balance: ${currency}${userBalance.toLocaleString()}`);
    if (totalPages > 1) footerParts.push(`Page ${page + 1}/${totalPages}`);
    embed.setFooter({ text: footerParts.join(' · ') });

    return embed;
}

function buildPageRow(page, totalPages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('shop_prev')
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId('shop_next')
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1)
    );
}

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
                .addBooleanOption(o => o.setName('clear_role').setDescription('Remove the role reward from this item'))
                .addIntegerOption(o => o.setName('stock').setDescription('Updated stock (-1 = unlimited)').setMinValue(-1))
                .addStringOption(o => o.setName('image_url').setDescription('Updated image URL'))
                .addBooleanOption(o => o.setName('clear_image').setDescription('Remove the image from this item')))
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

        // ── VIEW ──────────────────────────────────────────────────────────────
        if (sub === 'view') {
            if (!guildSettings.shop.length) {
                return interaction.reply({ content: 'The shop is empty. Admins can add items with `/shop add`.', ephemeral: true });
            }

            const userData = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const userBalance = userData?.balance ?? 0;
            const items = guildSettings.shop;
            const totalPages = Math.ceil(items.length / PAGE_SIZE);

            let page = 0;
            const embed = buildViewEmbed(items, page, totalPages, interaction.guild.name, currency, userBalance);

            if (totalPages <= 1) {
                return interaction.reply({ embeds: [embed] });
            }

            const row = buildPageRow(page, totalPages);
            const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

            const collector = msg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: i => i.user.id === interaction.user.id,
                time: 120_000
            });

            collector.on('collect', async btn => {
                if (btn.customId === 'shop_prev') page = Math.max(0, page - 1);
                else page = Math.min(totalPages - 1, page + 1);

                await btn.update({
                    embeds: [buildViewEmbed(items, page, totalPages, interaction.guild.name, currency, userBalance)],
                    components: [buildPageRow(page, totalPages)]
                });
            });

            collector.on('end', () => {
                interaction.editReply({ components: [] }).catch(() => {});
            });

            return;
        }

        // ── BUY ───────────────────────────────────────────────────────────────
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
                    content: `You need ${currency}${item.price.toLocaleString()} but only have ${currency}${userData.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            const doPurchase = async (reply) => {
                // Re-fetch to avoid race conditions on stock and balance
                const [freshGuild, freshUser] = await Promise.all([
                    Guild.findOne({ guildId: interaction.guild.id }),
                    User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id })
                ]);

                const freshItem = freshGuild.shop.find(i => i.name.toLowerCase() === itemName);
                if (!freshItem || freshItem.stock === 0) {
                    return reply({ content: 'That item is no longer available.', embeds: [], components: [] });
                }
                if (freshUser.balance < freshItem.price) {
                    return reply({
                        content: `You need ${currency}${freshItem.price.toLocaleString()} but only have ${currency}${freshUser.balance.toLocaleString()}.`,
                        embeds: [], components: []
                    });
                }

                freshUser.balance -= freshItem.price;
                const invEntry = freshUser.inventory.find(e => e.itemId === freshItem.name);
                if (invEntry) invEntry.quantity += 1;
                else freshUser.inventory.push({ itemId: freshItem.name, quantity: 1 });

                if (freshItem.stock > 0) freshItem.stock -= 1;
                await Promise.all([freshUser.save(), freshGuild.save()]);

                if (freshItem.roleId) {
                    await interaction.member.roles.add(freshItem.roleId).catch(console.error);
                }

                const successEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Purchase Successful')
                    .setDescription(`You bought **${freshItem.name}** for ${currency}${freshItem.price.toLocaleString()}.`)
                    .addFields({ name: 'New Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true });

                if (freshItem.roleId) {
                    successEmbed.addFields({ name: 'Role Granted', value: `<@&${freshItem.roleId}>`, inline: true });
                }
                if (freshItem.imageUrl) {
                    successEmbed.setThumbnail(freshItem.imageUrl);
                }

                return reply({ embeds: [successEmbed], components: [] });
            };

            if (item.price >= CONFIRM_THRESHOLD) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('shop_confirm').setLabel('Confirm Purchase').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('shop_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                );

                const confirmEmbed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle('Confirm Purchase')
                    .setDescription(`Buy **${item.name}** for **${currency}${item.price.toLocaleString()}**?`)
                    .addFields(
                        { name: 'Your Balance', value: `${currency}${userData.balance.toLocaleString()}`, inline: true },
                        { name: 'After Purchase', value: `${currency}${(userData.balance - item.price).toLocaleString()}`, inline: true }
                    )
                    .setFooter({ text: 'This confirmation expires in 30 seconds' });

                if (item.imageUrl) confirmEmbed.setThumbnail(item.imageUrl);

                const msg = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });

                const collector = msg.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    filter: i => i.user.id === interaction.user.id,
                    time: 30_000,
                    max: 1
                });

                collector.on('collect', async btn => {
                    if (btn.customId === 'shop_cancel') {
                        return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
                    }
                    await btn.deferUpdate();
                    await doPurchase(opts => interaction.editReply(opts));
                });

                collector.on('end', (collected, reason) => {
                    if (reason === 'time' && collected.size === 0) {
                        interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
                    }
                });

                return;
            }

            await interaction.deferReply();
            await doPurchase(opts => interaction.editReply(opts));
            return;
        }

        // ── ADD ───────────────────────────────────────────────────────────────
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

            guildSettings.shop.push({ name, description, price, roleId: role?.id ?? null, stock, imageUrl });
            await guildSettings.save();

            return interaction.reply({ content: `Added **${name}** to the shop for ${currency}${price.toLocaleString()}.` });
        }

        // ── EDIT ──────────────────────────────────────────────────────────────
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
            const clearRole = interaction.options.getBoolean('clear_role');
            const stock = interaction.options.getInteger('stock');
            const imageUrl = interaction.options.getString('image_url');
            const clearImage = interaction.options.getBoolean('clear_image');

            if (newName && newName.toLowerCase() !== name) {
                if (guildSettings.shop.find(i => i.name.toLowerCase() === newName.toLowerCase())) {
                    return interaction.reply({ content: 'An item with that new name already exists.', ephemeral: true });
                }
                item.name = newName;
            }

            if (price !== null) item.price = price;
            if (description !== null) item.description = description;
            if (stock !== null) item.stock = stock;

            if (clearRole) item.roleId = null;
            else if (role) item.roleId = role.id;

            if (clearImage) item.imageUrl = '';
            else if (imageUrl !== null) item.imageUrl = imageUrl;

            await guildSettings.save();
            return interaction.reply({ content: `Updated **${item.name}**.` });
        }

        // ── REMOVE ────────────────────────────────────────────────────────────
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
            return interaction.reply({ content: `Removed **${name}** from the shop.` });
        }
    }
};
