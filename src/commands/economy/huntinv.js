'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { WEAPON_BY_TIER, CONSUMABLES } = require('../../data/huntData');
const { ensureHuntData, weaponStatusEmoji, durabilityBar } = require('../../services/huntService');

// Human-readable material names
const MATERIAL_NAMES = {
    rabbits_foot:      "Rabbit's Foot",     acorn_cache:     'Acorn Cache',
    feather:           'Feather',            down_feather:    'Down Feather',
    antler_fragment:   'Antler Fragment',    tusk_shard:      'Tusk Shard',
    badger_pelt:       'Badger Pelt',        beaver_pelt:     'Beaver Pelt',
    coyote_fang:       'Coyote Fang',        wolf_pelt:       'Wolf Pelt',
    elk_antler:        'Grand Antler',       lynx_fang:       'Lynx Fang',
    eagle_talon:       'Eagle Talon',        mountain_horn:   'Mountain Horn',
    bear_claw:         'Bear Claw',          moose_rack:      'Moose Rack',
    lion_tooth:        "Lion's Tooth",       wolverine_fur:   'Wolverine Fur',
    spirit_pelt:       'Spirit Pelt',        megaloceros_crown:'Megaloceros Crown',
    golden_fur:        'Golden Fur',         spirit_essence:  'Spirit Essence',
    ancient_claw:      'Ancient Claw',       thunderfeather:  'Thunderfeather',
    spectral_bone:     'Spectral Bone',      bandit_mask:     'Bandit Mask'
};

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('huntinv')
        .setDescription('View and manage your hunt inventory')
        .addSubcommand(sub =>
            sub.setName('weapons')
                .setDescription('View your weapon collection'))
        .addSubcommand(sub =>
            sub.setName('equip')
                .setDescription('Equip a weapon by its inventory number')
                .addIntegerOption(o =>
                    o.setName('number')
                        .setDescription('Weapon number from /huntinv weapons')
                        .setRequired(true)
                        .setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('ammo')
                .setDescription('View your ammo stocks'))
        .addSubcommand(sub =>
            sub.setName('consumables')
                .setDescription('View your consumables and active buffs'))
        .addSubcommand(sub =>
            sub.setName('materials')
                .setDescription('View your crafting materials'))
        .addSubcommand(sub =>
            sub.setName('discard')
                .setDescription('Discard a broken or condemned weapon')
                .addIntegerOption(o =>
                    o.setName('number')
                        .setDescription('Weapon number to discard')
                        .setRequired(true)
                        .setMinValue(1))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const currency = guildSettings?.economy?.currency ?? '💰';

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureHuntData(user);
        const h = user.hunt;

        // ── WEAPONS ────────────────────────────────────────────────────────
        if (sub === 'weapons') {
            if (!h.weapons.length) {
                return interaction.reply({
                    content: "You don't own any weapons! Buy one with `/buygun buy <tier>`.",
                    ephemeral: true
                });
            }

            const lines = h.weapons.map((w, i) => {
                const isEquipped = i === h.equippedWeaponIndex;
                const wd         = WEAPON_BY_TIER[w.tier];
                const statusIcon = weaponStatusEmoji(w.status);
                const bar        = durabilityBar(w.currentDurability, w.maxDurability, 12);
                const upgrade    = w.upgrade ? `[${w.upgrade.replace(/_/g, ' ')}]` : '';
                const equipped   = isEquipped ? ' **[EQUIPPED]**' : '';
                return [
                    `**#${i + 1} — ${wd?.emoji ?? '🔫'} ${w.name}**${equipped}`,
                    `> ${statusIcon} ${w.status.toUpperCase()} · ${bar} ${w.currentDurability}/${w.maxDurability} dur`,
                    `> Repairs: ${w.repairCount} · Max: ${w.maxDurability}/${w.baseDurability} · ${upgrade || 'No upgrade'}`
                ].join('\n');
            });

            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🔫 Your Weapons')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: 'Use /huntinv equip <#> to change weapon • /repair gun to restore durability • /buygun upgrade for modules' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── EQUIP ──────────────────────────────────────────────────────────
        if (sub === 'equip') {
            const num    = interaction.options.getInteger('number');
            const index  = num - 1;

            if (index < 0 || index >= h.weapons.length) {
                return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s). Use \`/huntinv weapons\` to see them.`, ephemeral: true });
            }

            const weapon = h.weapons[index];
            if (weapon.status === 'broken') {
                return interaction.reply({ content: `**${weapon.name}** is broken and cannot be equipped. Repair it first with \`/repair gun\`.`, ephemeral: true });
            }

            h.equippedWeaponIndex = index;
            user.markModified('hunt');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('⚔️ Weapon Equipped')
                .setDescription(`**${weapon.name}** is now equipped and ready for hunting.`)
                .addFields(
                    { name: 'Durability', value: `${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                    { name: 'Status',     value: weaponStatusEmoji(weapon.status) + ' ' + weapon.status, inline: true },
                    { name: 'Upgrade',    value: weapon.upgrade ? weapon.upgrade.replace(/_/g, ' ') : 'None', inline: true }
                )
                .setFooter({ text: 'Use /hunt to start hunting!' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── AMMO ───────────────────────────────────────────────────────────
        if (sub === 'ammo') {
            const ammoEntries = Object.entries(h.ammo).filter(([, qty]) => qty > 0);
            const allAmmo = [
                ['iron_shot',       '🔶', 'Iron Shot        (T2 Iron Rifle)'],
                ['steel_shot',      '⚫', 'Steel Shot       (T3 Steel Rifle)'],
                ['composite_round', '🔵', 'Composite Round  (T4 Composite Rifle)'],
                ['titanium_round',  '💎', 'Titanium Round   (T5 Titanium Rifle)']
            ];

            const lines = allAmmo.map(([type, emoji, label]) => {
                const qty = h.ammo[type] ?? 0;
                return `${emoji} **${label}**: ${qty} rounds`;
            });

            const equippedWeapon = h.equippedWeaponIndex >= 0 ? h.weapons[h.equippedWeaponIndex] : null;
            const currentAmmoType = equippedWeapon ? WEAPON_BY_TIER[equippedWeapon.tier]?.ammoType : null;
            const currentAmmo = currentAmmoType ? (h.ammo[currentAmmoType] ?? 0) : null;

            const embed = new EmbedBuilder()
                .setColor('#e67e22')
                .setTitle('🔶 Ammo Stocks')
                .setDescription(lines.join('\n'));

            if (currentAmmoType) {
                embed.addFields({ name: '🔫 Equipped Weapon Ammo', value: `${currentAmmoType.replace(/_/g, ' ')}: **${currentAmmo} rounds**` });
            }

            embed.setFooter({ text: 'Buy ammo with /huntshop buy <ammo_pack>' });
            return interaction.reply({ embeds: [embed] });
        }

        // ── CONSUMABLES ────────────────────────────────────────────────────
        if (sub === 'consumables') {
            const lines = Object.entries(h.consumables)
                .map(([id, qty]) => {
                    const def = CONSUMABLES[id];
                    if (!def || qty <= 0) return null;
                    return `${def.emoji} **${def.name}** ×${qty} — ${def.description}`;
                })
                .filter(Boolean);

            const activeParts = [];
            if (h.activeBait)    activeParts.push(`🪱 **${h.activeBait.replace(/_/g, ' ')}** — ${h.activeBaitHuntsLeft} hunt(s) left`);
            if (h.activeCharm)   activeParts.push(`🍀 **${h.activeCharm.replace(/_/g, ' ')}** — ${h.activeCharmHuntsLeft} hunt(s) left`);
            if (h.activeFocus)   activeParts.push(`🎯 **Hunter's Focus** — queued for next hunt`);
            if (h.activeXpScroll) activeParts.push(`📜 **XP Scroll** — queued for next hunt`);

            const embed = new EmbedBuilder()
                .setColor('#9b59b6')
                .setTitle('🧪 Consumables')
                .addFields({ name: 'In Stock', value: lines.length ? lines.join('\n') : 'None', inline: false });

            if (activeParts.length) {
                embed.addFields({ name: '✅ Active Buffs', value: activeParts.join('\n'), inline: false });
            }

            embed.setFooter({ text: 'Buy from /huntshop • Activate with /huntshop use <item>' });
            return interaction.reply({ embeds: [embed] });
        }

        // ── MATERIALS ──────────────────────────────────────────────────────
        if (sub === 'materials') {
            const entries = Object.entries(h.materials)
                .filter(([, qty]) => qty > 0)
                .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}** ×${qty}`);

            const embed = new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🪨 Crafting Materials')
                .setDescription(entries.length ? entries.join('\n') : 'No materials yet. Hunt rare+ animals to find special drops!');

            if (!entries.length) {
                embed.setFooter({ text: 'Tip: Use bait from /huntshop to boost rare animal chances' });
            }

            return interaction.reply({ embeds: [embed] });
        }

        // ── DISCARD ────────────────────────────────────────────────────────
        if (sub === 'discard') {
            const num   = interaction.options.getInteger('number');
            const index = num - 1;

            if (index < 0 || index >= h.weapons.length) {
                return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s).`, ephemeral: true });
            }

            const weapon = h.weapons[index];
            if (weapon.status !== 'broken' && weapon.status !== 'condemned') {
                return interaction.reply({
                    content: `**${weapon.name}** is not broken or condemned. You can only discard unusable weapons.`,
                    ephemeral: true
                });
            }

            const wasEquipped = h.equippedWeaponIndex === index;
            h.weapons.splice(index, 1);

            // Fix equipped index after splice
            if (wasEquipped) {
                h.equippedWeaponIndex = h.weapons.length > 0 ? 0 : -1;
            } else if (h.equippedWeaponIndex > index) {
                h.equippedWeaponIndex -= 1;
            }

            user.markModified('hunt');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#e74c3c')
                .setTitle('🗑️ Weapon Discarded')
                .setDescription(`**${weapon.name}** has been discarded.`)
                .setFooter({ text: h.weapons.length === 0 ? 'Buy a new weapon with /buygun' : 'Use /huntinv weapons to view remaining weapons' });

            return interaction.reply({ embeds: [embed] });
        }
    }
};
