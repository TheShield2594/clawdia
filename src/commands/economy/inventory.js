const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { pruneEffects, EFFECT_CONFIGS, timeRemaining } = require('../../services/effectsService');

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

        if (!userData?.inventory?.length && !userData?.activeEffects?.length) {
            return interaction.reply({
                content: target.id === interaction.user.id
                    ? "Your inventory is empty. Buy items from the `/shop`!"
                    : `${target.username}'s inventory is empty.`,
                ephemeral: true
            });
        }

        // Prune expired effects before displaying
        if (userData) pruneEffects(userData);

        const shopItems = guildSettings?.shop ?? [];
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`${target.username}'s Inventory`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }));

        // ── Items in bag ──────────────────────────────────────────────────────
        if (userData?.inventory?.length) {
            const lines = userData.inventory.map(entry => {
                const shopItem = shopItems.find(s => s.name.toLowerCase() === entry.itemId.toLowerCase());
                const worth = shopItem ? ` (worth ${currency}${shopItem.price} each)` : '';
                return `**${entry.itemId}** ×${entry.quantity}${worth}`;
            });
            embed.addFields({ name: '🎒 Items', value: lines.join('\n'), inline: false });
        }

        // ── Active effects ────────────────────────────────────────────────────
        if (userData?.activeEffects?.length) {
            const lines = userData.activeEffects.map(e => {
                const cfg = EFFECT_CONFIGS[e.type];
                if (!cfg) return null;
                let durationStr;
                if (e.expiresAt) {
                    durationStr = `⏳ ${timeRemaining(e.expiresAt)} remaining`;
                } else if (e.charges > 0) {
                    durationStr = `${e.charges} use${e.charges !== 1 ? 's' : ''} left`;
                } else {
                    durationStr = 'permanent';
                }
                return `${cfg.emoji} **${cfg.label}** — ${durationStr}`;
            }).filter(Boolean);

            if (lines.length) {
                embed.addFields({ name: '✨ Active Effects', value: lines.join('\n'), inline: false });
            }
        }

        const totalItems = userData?.inventory?.reduce((sum, e) => sum + e.quantity, 0) ?? 0;
        embed.setFooter({ text: `${totalItems} item${totalItems !== 1 ? 's' : ''} in bag` });

        await interaction.reply({ embeds: [embed] });
    }
};
