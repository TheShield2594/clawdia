'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { WEAPON_TIERS, WEAPON_BY_TIER, WEAPON_UPGRADES } = require('../../data/huntData');
const { ensureHuntData, updateWeaponStatus } = require('../../services/huntService');

const UPGRADE_CHOICES = Object.values(WEAPON_UPGRADES).map(u => ({ name: `${u.name} — ${u.description}`, value: u.id }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('buygun')
        .setDescription('Purchase a weapon for hunting')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse available weapons'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Buy a weapon by tier')
                .addIntegerOption(o =>
                    o.setName('tier')
                        .setDescription('Weapon tier (1–5)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(5))
                .addBooleanOption(o =>
                    o.setName('equip')
                        .setDescription('Auto-equip after purchase (default: true)')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('upgrade')
                .setDescription('Add a module upgrade to your equipped weapon')
                .addStringOption(o =>
                    o.setName('module')
                        .setDescription('Upgrade module to install')
                        .setRequired(true)
                        .addChoices(...UPGRADE_CHOICES))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';

        // ── LIST ───────────────────────────────────────────────────────────
        if (sub === 'list') {
            const lines = WEAPON_TIERS.map(w => {
                const ammo = w.requiresAmmo ? `${w.ammoType.replace(/_/g, ' ')} (${currency}${w.ammoCost}/hunt)` : 'None';
                return [
                    `**T${w.tier} — ${w.emoji} ${w.name}** — ${currency}${w.cost.toLocaleString()}`,
                    `> ${w.description}`,
                    `> Durability: ${w.baseDurability} | Success: ${Math.round(w.successRate * 100)}% | Rarity Boost: +${Math.round(w.rarityBoost * 100)}%`,
                    `> Ammo: ${ammo}`
                ].join('\n');
            });

            const upgradeLines = Object.values(WEAPON_UPGRADES).map(u =>
                `**${u.emoji} ${u.name}** — ${u.description} (costs ${Math.round(u.costMultiplier * 100)}% of gun price)`
            );

            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🔫 Weapon Shop')
                .setDescription(lines.join('\n\n'))
                .addFields({ name: '🔧 Available Upgrades (one per weapon)', value: upgradeLines.join('\n') })
                .setFooter({ text: 'Use /buygun buy <tier> to purchase • /buygun upgrade <module> for upgrades' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── BUY ────────────────────────────────────────────────────────────
        if (sub === 'buy') {
            const tier       = interaction.options.getInteger('tier');
            const autoEquip  = interaction.options.getBoolean('equip') ?? true;
            const weaponData = WEAPON_BY_TIER[tier];

            if (!weaponData) {
                return interaction.reply({ content: 'Invalid weapon tier.', ephemeral: true });
            }

            const user = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            );
            ensureHuntData(user);

            if (user.balance < weaponData.cost) {
                return interaction.reply({
                    content: `You need ${currency}${weaponData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            // Confirmation button for purchases ≥ 5,000 coins
            if (weaponData.cost >= 5000) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('buygun_confirm').setLabel('Confirm Purchase').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('buygun_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                );

                const confirmEmbed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle('Confirm Purchase')
                    .setDescription(`Buy **${weaponData.emoji} ${weaponData.name}** for **${currency}${weaponData.cost.toLocaleString()}**?`)
                    .addFields(
                        { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
                        { name: 'After Purchase', value: `${currency}${(user.balance - weaponData.cost).toLocaleString()}`, inline: true }
                    )
                    .setFooter({ text: 'This expires in 30 seconds' });

                const msg = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });

                const collector = msg.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    filter: i => i.user.id === interaction.user.id,
                    time: 30_000,
                    max: 1
                });

                collector.on('collect', async btnInteraction => {
                    if (btnInteraction.customId === 'buygun_cancel') {
                        await btnInteraction.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
                        return;
                    }
                    await btnInteraction.deferUpdate();
                    await completePurchase(btnInteraction, user, weaponData, autoEquip, currency);
                });

                collector.on('end', async (collected, reason) => {
                    if (reason === 'time' && collected.size === 0) {
                        await interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
                    }
                });

            } else {
                // Small purchases go through immediately
                await interaction.deferReply();
                await completePurchase(interaction, user, weaponData, autoEquip, currency);
            }
        }

        // ── UPGRADE ────────────────────────────────────────────────────────
        if (sub === 'upgrade') {
            const moduleId = interaction.options.getString('module');
            const upgradeDef = WEAPON_UPGRADES[moduleId];
            if (!upgradeDef) {
                return interaction.reply({ content: 'Unknown upgrade module.', ephemeral: true });
            }

            const user = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            );
            ensureHuntData(user);
            const h = user.hunt;

            if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
                return interaction.reply({ content: 'No weapon equipped. Equip a weapon first with `/huntinv equip`.', ephemeral: true });
            }

            const weapon     = h.weapons[h.equippedWeaponIndex];
            const weaponData = WEAPON_BY_TIER[weapon.tier];
            const cost       = Math.round(weaponData.cost * upgradeDef.costMultiplier);

            if (weapon.upgrade) {
                return interaction.reply({
                    content: `Your **${weapon.name}** already has a **${weapon.upgrade.replace(/_/g, ' ')}** installed. Each weapon supports only one upgrade.`,
                    ephemeral: true
                });
            }
            if (user.balance < cost) {
                return interaction.reply({
                    content: `You need ${currency}${cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            user.balance    -= cost;
            weapon.upgrade   = moduleId;
            user.markModified('hunt');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
                .setDescription(`**${upgradeDef.name}** has been installed on your **${weapon.name}**.`)
                .addFields(
                    { name: 'Effect',      value: upgradeDef.description,                         inline: true },
                    { name: 'Cost',        value: `${currency}${cost.toLocaleString()}`,           inline: true },
                    { name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}`,   inline: true }
                )
                .setFooter({ text: 'Upgrade is permanently attached to this weapon instance.' });

            return interaction.reply({ embeds: [embed] });
        }
    }
};

// ─── HELPER ──────────────────────────────────────────────────────────────────

async function completePurchase(interactionOrBtn, user, weaponData, autoEquip, currency) {
    const h = user.hunt;

    // Re-check balance (could have changed between confirmation and click)
    if (user.balance < weaponData.cost) {
        const reply = { content: `Insufficient funds. You need ${currency}${weaponData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    user.balance -= weaponData.cost;

    const newWeapon = {
        name:              weaponData.name,
        tier:              weaponData.tier,
        slug:              weaponData.slug,
        currentDurability: weaponData.baseDurability,
        maxDurability:     weaponData.baseDurability,
        baseDurability:    weaponData.baseDurability,
        repairCount:       0,
        upgrade:           null,
        status:            'good',
        acquiredAt:        new Date()
    };

    h.weapons.push(newWeapon);
    const newIndex = h.weapons.length - 1;

    if (autoEquip && (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex] || h.weapons[h.equippedWeaponIndex].status === 'broken')) {
        h.equippedWeaponIndex = newIndex;
    }

    user.markModified('hunt');
    await user.save();

    const equipped = h.equippedWeaponIndex === newIndex;
    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${weaponData.emoji} ${weaponData.name} Purchased!`)
        .setDescription(weaponData.description)
        .addFields(
            { name: 'Durability',    value: `${weaponData.baseDurability}/${weaponData.baseDurability}`, inline: true },
            { name: 'Success Rate',  value: `${Math.round(weaponData.successRate * 100)}%`,              inline: true },
            { name: 'Rarity Boost',  value: `+${Math.round(weaponData.rarityBoost * 100)}%`,            inline: true },
            { name: 'Ammo',          value: weaponData.requiresAmmo ? `${weaponData.ammoType.replace(/_/g, ' ')} (${currency}${weaponData.ammoCost}/hunt)` : 'None required', inline: true },
            { name: 'Weapon #',      value: `#${newIndex + 1} in inventory`,                            inline: true },
            { name: 'Status',        value: equipped ? '✅ Equipped' : `Use \`/huntinv equip ${newIndex + 1}\``, inline: true }
        )
        .addFields({ name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}` })
        .setFooter({ text: equipped ? 'Ready to hunt! Use /hunt' : `Equip with /huntinv equip ${newIndex + 1}` });

    const reply = { embeds: [embed], components: [] };
    if (interactionOrBtn.editReply) return interactionOrBtn.editReply(reply);
    return interactionOrBtn.update(reply);
}
