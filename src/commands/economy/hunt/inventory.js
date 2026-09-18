'use strict';

// The /hunt inventory surface — one read-only /hunt inv that shows every
// category at a glance, with a `category` option that opens the full, paginated
// list for one of them, plus the two mutating actions /hunt equip and
// /hunt discard as their own top-level subcommands (#1053-follow-up).
//
// Before this it was a six-way subcommand group: /hunt inv weapons, ammo,
// consumables, materials, equip, discard. The four view subcommands are now the
// `category` choices of a single /hunt inv, and equip/discard moved up a level
// so the whole group could collapse — Discord will not let a subcommand *group*
// be run on its own, so /hunt inv had to stop being a group to become runnable.

const { WEAPON_BY_TIER, CONSUMABLES, MATERIAL_NAMES } = require('../../../data/huntData');
const { weaponStatusEmoji, durabilityBar, repairsRemaining, ensureHuntData } = require('../../../services/huntService');
const { chunkByLength } = require('../../../utils/embedFields');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { paginate } = require('../../../utils/paginator');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// INV
// ═══════════════════════════════════════════════════════════════════════════════

const WEAPON_SEPARATOR = '\n\n';

// Weapons sorted equipped-first, then by tier, carrying the original index so the
// number a player reads is the one /hunt equip and /hunt discard take.
function orderedWeapons(h) {
    return h.weapons
        .map((w, index) => ({ w, index }))
        .sort((a, b) => {
            if (a.index === h.equippedWeaponIndex) return -1;
            if (b.index === h.equippedWeaponIndex) return 1;
            return (b.w.tier ?? 0) - (a.w.tier ?? 0);
        });
}

function buildWeaponPages(h) {
    const lines = orderedWeapons(h).map(({ w, index }) => {
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

// ── Per-category renderers, each returning an array of embeds ─────────────────

function weaponsPages(h) {
    if (!h.weapons.length) {
        return [new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle('🔫 Your Weapons')
            .setDescription("You don't own any weapons! Buy one with `/hunt shop weapon`.")];
    }

    return buildWeaponPages(h).map((lines, _page, all) => new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(all.length > 1 ? `🔫 Your Weapons (${h.weapons.length})` : '🔫 Your Weapons')
        .setDescription(lines.join(WEAPON_SEPARATOR))
        .setFooter({ text: 'Use /hunt equip <#> to change weapon • /hunt shop repair to restore durability • /hunt shop upgrade for modules' }));
}

const AMMO_ROWS = [
    ['iron_shot',       '🔶', 'Iron Shot        (T2–T3: Iron, Copper)'],
    ['steel_shot',      '⚫', 'Steel Shot       (T4–T5: Steel, Cobalt)'],
    ['composite_round', '🔵', 'Composite Round  (T6–T8: Gold, Platinum, Crimson)'],
    ['titanium_round',  '💎', 'Titanium Round   (T9–T12: Adamantine → Altair)']
];

function ammoEmbed(h) {
    const lines = AMMO_ROWS.map(([type, emoji, label]) => `${emoji} **${label}**: ${h.ammo[type] ?? 0} rounds`);

    const equippedWeapon  = h.equippedWeaponIndex >= 0 ? h.weapons[h.equippedWeaponIndex] : null;
    const currentAmmoType = equippedWeapon ? WEAPON_BY_TIER[equippedWeapon.tier]?.ammoType : null;
    const currentAmmo     = currentAmmoType ? (h.ammo[currentAmmoType] ?? 0) : null;

    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('🔶 Ammo Stocks')
        .setDescription(lines.join('\n'));

    if (currentAmmoType) {
        embed.addFields({ name: '🔫 Equipped Weapon Ammo', value: `${currentAmmoType.replace(/_/g, ' ')}: **${currentAmmo} rounds**` });
    }

    embed.setFooter({ text: 'Buy ammo with /hunt shop buy <ammo_pack>' });
    return embed;
}

function consumableStockLines(h) {
    return Object.entries(h.consumables)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            if (!def || qty <= 0) return null;
            return `${def.emoji} **${def.name}** ×${qty} — ${def.description}`;
        })
        .filter(Boolean);
}

function activeBuffLines(h) {
    const parts = [];
    if (h.activeBait)     parts.push(`🪱 **${h.activeBait.replace(/_/g, ' ')}** — ${h.activeBaitHuntsLeft} hunt(s) left`);
    if (h.activeCharm)    parts.push(`🍀 **${h.activeCharm.replace(/_/g, ' ')}** — ${h.activeCharmHuntsLeft} hunt(s) left`);
    if (h.activeFocus)    parts.push(`🎯 **Hunter's Focus** — queued for next hunt`);
    if (h.activeXpScroll) parts.push(`📜 **XP Scroll** — queued for next hunt`);
    return parts;
}

function consumablesEmbed(h) {
    const lines = consumableStockLines(h);
    const activeParts = activeBuffLines(h);

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('🧪 Consumables')
        .addFields({ name: 'In Stock', value: lines.length ? lines.join('\n') : 'None', inline: false });

    if (activeParts.length) {
        embed.addFields({ name: '✅ Active Buffs', value: activeParts.join('\n'), inline: false });
    }

    embed.setFooter({ text: 'Buy from /hunt shop • Activate with /hunt shop use <item>' });
    return embed;
}

function materialsPages(h) {
    const entries = Object.entries(h.materials)
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}** ×${qty}`);

    const footer = entries.length
        ? 'Every material feeds a recipe — see /craft list. Each zone ends in a permanent Field Trophy.'
        : 'Tip: Use bait from /hunt shop to boost rare animal chances';

    // Bounded by the 58 material ids to about 1,700 characters, so this
    // fits today — but it is the same join-and-hope shape the weapon list
    // broke on, and the material table only ever grows.
    if (!entries.length) {
        return [new EmbedBuilder()
            .setColor('#1abc9c')
            .setTitle('🪨 Crafting Materials')
            .setDescription('No materials yet. Hunt rare+ animals to find special drops!')
            .setFooter({ text: footer })];
    }

    return chunkByLength(entries).map(lines => new EmbedBuilder()
        .setColor('#1abc9c')
        .setTitle('🪨 Crafting Materials')
        .setDescription(lines.join('\n'))
        .setFooter({ text: footer }));
}

// ── The at-a-glance overview: every category in one embed ────────────────────

const OVERVIEW_WEAPON_PREVIEW = 5;
const OVERVIEW_MATERIAL_PREVIEW = 8;

function overviewEmbed(interaction, h) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(`🎒 ${interaction.user.username}'s Hunt Inventory`)
        .setTimestamp();

    // Weapons — a short preview, equipped first, pointing at the full list.
    if (!h.weapons.length) {
        embed.addFields({ name: '🔫 Weapons', value: 'None — buy one with `/hunt shop weapon`', inline: false });
    } else {
        const ordered = orderedWeapons(h);
        const preview = ordered.slice(0, OVERVIEW_WEAPON_PREVIEW).map(({ w, index }) => {
            const wd       = WEAPON_BY_TIER[w.tier];
            const equipped = index === h.equippedWeaponIndex ? ' **[E]**' : '';
            return `**#${index + 1}** ${wd?.emoji ?? '🔫'} ${w.name}${equipped} — ${weaponStatusEmoji(w.status)} ${w.currentDurability}/${w.maxDurability}`;
        });
        const extra = ordered.length - preview.length;
        if (extra > 0) preview.push(`…and ${extra} more — \`/hunt inv category:weapons\` for the full list`);
        embed.addFields({ name: `🔫 Weapons (${h.weapons.length})`, value: preview.join('\n'), inline: false });
    }

    // Ammo — the four stocks, compact.
    const ammoLines = AMMO_ROWS.map(([type, emoji]) => `${emoji} ${type.replace(/_/g, ' ')}: **${h.ammo[type] ?? 0}**`);
    embed.addFields({ name: '🔶 Ammo', value: ammoLines.join('\n'), inline: true });

    // Consumables — names and counts only (the full descriptions live in the
    // focused view), plus any active buffs.
    const consLines = Object.entries(h.consumables)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            if (!def || qty <= 0) return null;
            return `${def.emoji} ${def.name} ×${qty}`;
        })
        .filter(Boolean);
    embed.addFields({ name: '🧪 Consumables', value: consLines.length ? consLines.join('\n') : 'None', inline: true });

    const buffs = activeBuffLines(h);
    if (buffs.length) embed.addFields({ name: '✅ Active Buffs', value: buffs.join('\n'), inline: false });

    // Materials — a preview, pointing at the full list when it overflows.
    const matEntries = Object.entries(h.materials)
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => `• ${MATERIAL_NAMES[id] ?? id} ×${qty}`);
    if (!matEntries.length) {
        embed.addFields({ name: '🪨 Materials', value: 'None yet — hunt rare+ animals for drops', inline: false });
    } else {
        const preview = matEntries.slice(0, OVERVIEW_MATERIAL_PREVIEW);
        const extra = matEntries.length - preview.length;
        if (extra > 0) preview.push(`…and ${extra} more — \`/hunt inv category:materials\` for the full list`);
        embed.addFields({ name: `🪨 Materials (${matEntries.length})`, value: preview.join('\n'), inline: false });
    }

    embed.setFooter({ text: 'Open a section with /hunt inv category:<name> • Equip /hunt equip <#> • Discard /hunt discard <#>' });
    return embed;
}

// ── Shared loader ─────────────────────────────────────────────────────────────

// Loads the user's hunt data, or replies and returns null when the economy is
// off. Every /hunt inv, /hunt equip and /hunt discard invocation starts here.
async function loadHunt(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        await interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        return null;
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureHuntData(user);
    return user;
}

// ── /hunt inv [category] ──────────────────────────────────────────────────────

async function executeInv(interaction) {
    const user = await loadHunt(interaction);
    if (!user) return;
    const h = user.hunt;

    const category = interaction.options.getString('category');
    switch (category) {
        case 'weapons':     return paginate(interaction, weaponsPages(h));
        case 'ammo':        return interaction.reply({ embeds: [ammoEmbed(h)] });
        case 'consumables': return interaction.reply({ embeds: [consumablesEmbed(h)] });
        case 'materials':   return paginate(interaction, materialsPages(h));
        default:            return interaction.reply({ embeds: [overviewEmbed(interaction, h)] });
    }
}

// ── /hunt equip <number> ──────────────────────────────────────────────────────

async function executeEquip(interaction) {
    const user = await loadHunt(interaction);
    if (!user) return;
    const h = user.hunt;

    const num   = interaction.options.getInteger('number');
    const index = num - 1;

    if (index < 0 || index >= h.weapons.length) {
        return interaction.reply({ content: `Invalid weapon number. You have ${h.weapons.length} weapon(s). Use \`/hunt inv category:weapons\` to see them.`, flags: MessageFlags.Ephemeral });
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

// ── /hunt discard <number> ────────────────────────────────────────────────────

async function executeDiscard(interaction) {
    const user = await loadHunt(interaction);
    if (!user) return;
    const h = user.hunt;

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
        .setFooter({ text: h.weapons.length === 0 ? 'Buy a new weapon with /hunt shop weapon' : 'Use /hunt inv category:weapons to view remaining weapons' });

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    WEAPON_SEPARATOR,
    buildWeaponPages,
    executeInv,
    executeEquip,
    executeDiscard,
    // Exposed for tests: the pure per-category and overview builders, which take
    // a plain hunt-data object and return embeds without touching the database.
    __test__: {
        orderedWeapons,
        weaponsPages,
        ammoEmbed,
        consumablesEmbed,
        materialsPages,
        overviewEmbed,
    },
};
