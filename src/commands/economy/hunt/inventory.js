'use strict';

// The /hunt inv group — weapons, ammo, consumables and materials.

const { WEAPON_BY_TIER, CONSUMABLES, MATERIAL_NAMES } = require('../../../data/huntData');
const { weaponStatusEmoji, durabilityBar, repairsRemaining, ensureHuntData } = require('../../../services/huntService');
const { chunkByLength } = require('../../../utils/embedFields');
const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { paginate } = require('../../../utils/paginator');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// INV (was /huntinv)
// ═══════════════════════════════════════════════════════════════════════════════

const WEAPON_SEPARATOR = '\n\n';

function buildWeaponPages(h) {
    const ordered = h.weapons
        .map((w, index) => ({ w, index }))
        .sort((a, b) => {
            if (a.index === h.equippedWeaponIndex) return -1;
            if (b.index === h.equippedWeaponIndex) return 1;
            return (b.w.tier ?? 0) - (a.w.tier ?? 0);
        });

    const lines = ordered.map(({ w, index }) => {
        const wd         = WEAPON_BY_TIER[w.tier];
        const statusIcon = weaponStatusEmoji(w.status);
        const bar        = durabilityBar(w.currentDurability, w.maxDurability, 12);
        const upgrade    = w.upgrade ? `[${w.upgrade.replace(/_/g, ' ')}]` : '';
        const equipped   = index === h.equippedWeaponIndex ? ' **[EQUIPPED]**' : '';
        // Repairs spent is the number the profile stores; repairs LEFT is the
        // number that decides whether this weapon is worth putting money into,
        // and it is the one a player cannot work out from the durability bar.
        const left = repairsRemaining(w);
        const repairNote = left > 0 ? `${w.repairCount} used, ${left} left` : `${w.repairCount} used, condemned`;
        return [
            `**#${index + 1} — ${wd?.emoji ?? '🔫'} ${w.name}**${equipped}`,
            `> ${statusIcon} ${w.status.toUpperCase()} · ${bar} ${w.currentDurability}/${w.maxDurability} dur`,
            `> Repairs: ${repairNote} · Max: ${w.maxDurability}/${w.baseDurability} · ${upgrade || 'No upgrade'}`
        ].join('\n');
    });

    // A page cap as well as a character budget: eight entries is a screenful,
    // and a list that fills 4096 characters before it pages is one nobody reads.
    return chunkByLength(lines, { separator: WEAPON_SEPARATOR, maxPerChunk: 8 });
}

async function executeInv(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureHuntData(user);
    const h = user.hunt;

    if (sub === 'weapons') {
        if (!h.weapons.length) {
            return interaction.reply({
                content: "You don't own any weapons! Buy one with `/hunt shop weapon`.",
                flags: MessageFlags.Ephemeral
            });
        }

        const pages = buildWeaponPages(h).map((lines, page, all) => new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle(all.length > 1 ? `🔫 Your Weapons (${h.weapons.length})` : '🔫 Your Weapons')
            .setDescription(lines.join(WEAPON_SEPARATOR))
            .setFooter({ text: 'Use /hunt inv equip <#> to change weapon • /hunt shop repair to restore durability • /hunt shop upgrade for modules' }));

        return paginate(interaction, pages);
    }

    if (sub === 'equip') {
        const num    = interaction.options.getInteger('number');
        const index  = num - 1;

        if (index < 0 || index >= h.weapons.length) {
            return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s). Use \`/hunt inv weapons\` to see them.`, flags: MessageFlags.Ephemeral });
        }

        const weapon = h.weapons[index];
        if (weapon.status === 'broken') {
            return interaction.reply({ content: `**${weapon.name}** is broken and cannot be equipped. Repair it first with \`/hunt shop repair\`.`, flags: MessageFlags.Ephemeral });
        }

        h.equippedWeaponIndex = index;
        user.markModified('hunt');
        await user.save();

        const embed = new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle('⚔️ Weapon Equipped')
            .setDescription(`**${weapon.name}** is now equipped and ready for hunting.`)
            .addFields(
                { name: 'Durability', value: `${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                { name: 'Status',     value: weaponStatusEmoji(weapon.status) + ' ' + weapon.status, inline: true },
                { name: 'Upgrade',    value: weapon.upgrade ? weapon.upgrade.replace(/_/g, ' ') : 'None', inline: true }
            )
            .setFooter({ text: 'Use /hunt start to start hunting!' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'ammo') {
        const allAmmo = [
            ['iron_shot',       '🔶', 'Iron Shot        (T2–T3: Iron, Copper)'],
            ['steel_shot',      '⚫', 'Steel Shot       (T4–T5: Steel, Cobalt)'],
            ['composite_round', '🔵', 'Composite Round  (T6–T8: Gold, Platinum, Crimson)'],
            ['titanium_round',  '💎', 'Titanium Round   (T9–T12: Adamantine → Altair)']
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

        embed.setFooter({ text: 'Buy ammo with /hunt shop buy <ammo_pack>' });
        return interaction.reply({ embeds: [embed] });
    }

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
            .setColor(COLORS.RARE)
            .setTitle('🧪 Consumables')
            .addFields({ name: 'In Stock', value: lines.length ? lines.join('\n') : 'None', inline: false });

        if (activeParts.length) {
            embed.addFields({ name: '✅ Active Buffs', value: activeParts.join('\n'), inline: false });
        }

        embed.setFooter({ text: 'Buy from /hunt shop • Activate with /hunt shop use <item>' });
        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'materials') {
        const entries = Object.entries(h.materials)
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}** ×${qty}`);

        const footer = entries.length
            ? 'Every material feeds a recipe — see /craft list. Each zone ends in a permanent Field Trophy.'
            : 'Tip: Use bait from /hunt shop to boost rare animal chances';

        // Bounded by the 58 material ids to about 1,700 characters, so this
        // fits today — but it is the same join-and-hope shape the weapon list
        // broke on, and the material table only ever grows.
        const pages = entries.length
            ? chunkByLength(entries).map(lines => new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🪨 Crafting Materials')
                .setDescription(lines.join('\n'))
                .setFooter({ text: footer }))
            : [new EmbedBuilder()
                .setColor('#1abc9c')
                .setTitle('🪨 Crafting Materials')
                .setDescription('No materials yet. Hunt rare+ animals to find special drops!')
                .setFooter({ text: footer })];

        return paginate(interaction, pages);
    }

    if (sub === 'discard') {
        const num   = interaction.options.getInteger('number');
        const index = num - 1;

        if (index < 0 || index >= h.weapons.length) {
            return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s).`, flags: MessageFlags.Ephemeral });
        }

        const weapon = h.weapons[index];
        if (weapon.status !== 'broken' && weapon.status !== 'condemned') {
            return interaction.reply({
                content: `**${weapon.name}** is not broken or condemned. You can only discard unusable weapons.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const wasEquipped = h.equippedWeaponIndex === index;
        h.weapons.splice(index, 1);

        if (wasEquipped) {
            h.equippedWeaponIndex = h.weapons.length > 0 ? 0 : -1;
        } else if (h.equippedWeaponIndex > index) {
            h.equippedWeaponIndex -= 1;
        }

        user.markModified('hunt');
        await user.save();

        const embed = new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('🗑️ Weapon Discarded')
            .setDescription(`**${weapon.name}** has been discarded.`)
            .setFooter({ text: h.weapons.length === 0 ? 'Buy a new weapon with /hunt shop weapon' : 'Use /hunt inv weapons to view remaining weapons' });

        return interaction.reply({ embeds: [embed] });
    }
}

module.exports = {
    WEAPON_SEPARATOR,
    buildWeaponPages,
    executeInv,
};
