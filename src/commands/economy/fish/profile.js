'use strict';

// /fish profile, /fish prestige, /fish inv and /fish equip: what the player has
// and what they have become.

const User = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { attachGrind } = require('../../../utils/grindProfile');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    ensureFishingData,
    applyStaminaRegen,
    getMaxStamina,
    applyDailyReset,
    rodStatusEmoji,
    durabilityBar
} = require('../../../services/fishService');
const {
    PRESTIGE_BONUSES,
    ROD_UPGRADES,
    ROD_BY_SLUG,
    ROD_BY_TIER,
    BAIT_PACKS,
    CONSUMABLES,
    MATERIAL_NAMES
} = require('../../../data/fishData');
const { chunkByLength } = require('../../../utils/embedFields');
const { paginate } = require('../../../utils/paginator');
const { MAX_PRESTIGE, PRESTIGE_LABELS } = require('./shared');
const { formatPrestigeBonuses } = require('./embeds');
const { sendProfileTabs, renderAttachment, pagePayload } = require('../../../utils/grindProfileView');
const { createGrindInventoryCard } = require('../../../utils/grindProfileCard');
const { readCatalog, fishOverviewPage, fishCatalogPage, fishProgressPage } = require('./profilePages');
const COLORS = require('../../../utils/embedColors');
const { ascendGrind } = require('../../../utils/grindPrestige');
const { checkGrandPrestige } = require('../../../services/grandPrestigeService');
const { ownedBy } = require('../../../utils/collectorOwner');

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: target.id, guildId: interaction.guild.id }),
        getGuildSettings(interaction.guild.id)
    ]);
    await attachGrind(userData);

    const currency = guildSettings?.economy?.currency ?? '💰';

    if (!userData) {
        return interaction.reply({
            content: isSelf
                ? "You haven't started fishing yet! Buy a rod with `/fish shop rod` and use `/fish cast` to begin."
                : `${target.username} hasn't started fishing yet.`,
            flags: MessageFlags.Ephemeral
        });
    }

    ensureFishingData(userData);
    if (isSelf) applyStaminaRegen(userData);
    // Read-only, but Today should show a window that has already rolled over
    // as the fresh one it is rather than yesterday's numbers.
    applyDailyReset(userData);

    const ctx = { target, isSelf, userData, currency, catalog: readCatalog(userData.fishing) };

    return sendProfileTabs(interaction, [
        { id: 'overview', label: 'Overview', emoji: '🎣', build: () => fishOverviewPage(ctx) },
        { id: 'catalog',  label: 'Catalog',  emoji: '📖', build: () => fishCatalogPage(ctx) },
        { id: 'progress', label: 'Progress', emoji: '🎖️', build: () => fishProgressPage(ctx) },
    ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESTIGE
// ═══════════════════════════════════════════════════════════════════════════════

async function handlePrestige(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);
    const f = user.fishing;

    if (f.level < 50) {
        return interaction.reply({
            content: `You need Fisher Level **50** to prestige. You are currently Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const currentPrestige = f.prestige ?? 0;
    if (currentPrestige >= MAX_PRESTIGE) {
        return interaction.reply({
            content: `You have already reached the maximum prestige (**P${MAX_PRESTIGE} — Diamond Angler**). You are a true legend of the sea! 💎`,
            flags: MessageFlags.Ephemeral
        });
    }

    const nextPrestige   = currentPrestige + 1;
    const currentBonuses = PRESTIGE_BONUSES[currentPrestige];
    const nextBonuses    = PRESTIGE_BONUSES[nextPrestige];

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('⚠️ Fishing Prestige Confirmation')
        .setDescription(
            `You are about to prestige from **P${currentPrestige}** → **P${nextPrestige}** (${PRESTIGE_LABELS[nextPrestige]}).\n\n` +
            `**Your fisher level and XP will reset to 1.**\n` +
            `Rods, bait, materials, balance, location unlocks, and trophies are all kept.`
        )
        .addFields(
            { name: `Current Bonuses (P${currentPrestige})`, value: formatPrestigeBonuses(currentBonuses), inline: true },
            { name: `New Bonuses (P${nextPrestige})`,        value: formatPrestigeBonuses(nextBonuses),    inline: true }
        )
        .setFooter({ text: 'This action cannot be undone! You have 30 seconds to confirm.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('fishprestige_confirm')
            .setLabel('Prestige Now!')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('fishprestige_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });

    const collector = reply.createMessageComponentCollector({
        filter: ownedBy(
            interaction.user.id,
            i => ['fishprestige_confirm', 'fishprestige_cancel'].includes(i.customId),
            "This isn't your prestige confirmation.",
        ),
        time:   30_000,
        max:    1
    });

    collector.on('collect', async i => {
        if (i.customId === 'fishprestige_cancel') {
            await i.update({ content: 'Prestige cancelled.', embeds: [], components: [] });
            return;
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);
        const ff = freshUser.fishing;

        if (ff.level < 50 || (ff.prestige ?? 0) >= MAX_PRESTIGE) {
            await i.update({
                content: 'Prestige conditions are no longer met (level changed, or already prestiged).',
                embeds: [], components: []
            });
            return;
        }

        // One conditional update, not a save() of the profile read here (#873,
        // pass 20): this runs after execute has released the economy lock, so a
        // cast mid-run could save over the prestige, or this over the cast.
        const fromRank = ff.prestige ?? 0;
        const trophy   = PRESTIGE_LABELS[fromRank + 1];
        let ascended;
        try {
            ascended = await ascendGrind({
                userId: interaction.user.id, guildId: interaction.guild.id, system: 'fishing',
                minLevel: 50, fromRank, trophy,
            });
        } catch (err) {
            console.error('[fishprestige] ascend error:', err);
            await i.update({ content: 'Something went wrong saving your prestige. Please try again.', embeds: [], components: [] });
            return;
        }
        if (!ascended) {
            await i.update({
                content: 'Prestige conditions are no longer met (level changed, or already prestiged).',
                embeds: [], components: []
            });
            return;
        }
        ff.prestige = fromRank + 1;
        ff.level    = 1;
        ff.xp       = 0;

        checkGrandPrestige(i.client, interaction.user.id, interaction.guildId, interaction.guild);

        const resultEmbed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle(`✨ Fishing Prestige ${ff.prestige} Achieved!`)
            .setDescription(
                `You are now **${PRESTIGE_LABELS[ff.prestige]}**!\n\n` +
                `Your fisher level has been reset to **1**. Prove yourself again from the water's edge.`
            )
            .addFields(
                { name: 'Prestige Bonuses', value: formatPrestigeBonuses(PRESTIGE_BONUSES[ff.prestige]), inline: false },
                { name: '🏆 Trophy Earned', value: trophy,                                                inline: true  },
                { name: '⚡ Max Stamina',   value: `${getMaxStamina(freshUser)}`,                         inline: true  }
            )
            .setFooter({ text: 'Use /fish profile to see your updated stats' })
            .setTimestamp();

        await i.update({ embeds: [resultEmbed], components: [] });
    });

    collector.on('end', collected => {
        if (collected.size === 0) {
            interaction.editReply({ content: 'Prestige timed out. No changes were made.', embeds: [], components: [] })
                .catch(() => {});
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INV
// ═══════════════════════════════════════════════════════════════════════════════

// The /fish inventory surface — one read-only /fish inv that shows rods, bait
// and materials at a glance, with a `category` option that opens one of them in
// full, plus /fish equip as its own top-level subcommand. It was a subcommand
// group (/fish inv rods / equip / bait / materials); the group collapsed because
// Discord will not run a subcommand *group* on its own, so /fish inv had to
// become a plain subcommand to be runnable.

// Loads the user's fishing data, or replies and returns null when the economy is
// off. Every /fish inv and /fish equip invocation starts here.
async function loadFishing(interaction) {
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
    ensureFishingData(user);
    applyStaminaRegen(user);
    return user;
}

// Rods sorted equipped-first, then by tier, carrying the original index so the
// number a player reads is the one /fish equip takes.
function orderedRods(f) {
    return f.rods
        .map((rod, index) => ({ rod, index }))
        .sort((a, b) => {
            if (a.index === f.equippedRodIndex) return -1;
            if (b.index === f.equippedRodIndex) return 1;
            return (b.rod.tier ?? 0) - (a.rod.tier ?? 0);
        });
}

async function handleInv(interaction) {
    const user = await loadFishing(interaction);
    if (!user) return;

    const category = interaction.options.getString('category');
    switch (category) {
        case 'rods':      return paginate(interaction, rodPages(interaction, user));
        case 'bait':      return interaction.reply({ embeds: [baitEmbed(interaction, user)] });
        case 'materials': return interaction.reply({ embeds: [materialsEmbed(interaction, user)] });
        default:          return interaction.reply(await overviewPayload(interaction, user));
    }
}

function rodPages(interaction, user) {
    const f = user.fishing;

    if (!f.rods.length) {
        return [new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle(`🎣 ${interaction.user.username}'s Rods`)
            .setDescription("You don't own any rods yet. Buy one with `/fish shop rod`.")];
    }

    // Paged for the same reason /hunt inv is: rods accumulate without limit —
    // nothing forces a working spare out of the inventory — and one joined
    // description overflows the 4096-character embed cap somewhere past thirty
    // rods, which fails the whole command rather than truncating it. The number
    // in each heading is what /fish equip takes, so trimming the tail would put
    // those rods permanently out of reach.
    const lines = orderedRods(f).map(({ rod, index }) => {
        const equipped    = index === f.equippedRodIndex ? ' **[EQUIPPED]**' : '';
        const statusEmoji = rodStatusEmoji(rod.status);
        const bar         = durabilityBar(rod.currentDurability, rod.maxDurability, 8);
        const upgradeStr  = rod.upgrade ? ` | ${ROD_UPGRADES[rod.upgrade]?.emoji ?? ''} ${rod.upgrade.replace(/_/g, ' ')}` : '';
        return `**${index + 1}.** ${rod.name}${equipped}\n   ${statusEmoji} ${bar} ${rod.currentDurability}/${rod.maxDurability}${upgradeStr}`;
    });

    return chunkByLength(lines, { separator: '\n\n', maxPerChunk: 8 }).map((chunk, _i, all) => new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(all.length > 1 ? `🎣 ${interaction.user.username}'s Rods (${f.rods.length})` : `🎣 ${interaction.user.username}'s Rods`)
        .setDescription(chunk.join('\n\n'))
        .setFooter({ text: 'Use /fish equip <number> to equip a rod • /fish shop repair to repair' })
        .setTimestamp());
}

async function handleEquip(interaction) {
    const user = await loadFishing(interaction);
    if (!user) return;

    const f      = user.fishing;
    const number = interaction.options.getInteger('number');
    const index  = number - 1;

    if (index < 0 || index >= f.rods.length) {
        return interaction.reply({ content: `Invalid rod number. You have **${f.rods.length}** rod(s).`, flags: MessageFlags.Ephemeral });
    }

    const rod = f.rods[index];
    if (rod.status === 'broken') {
        return interaction.reply({ content: `Your **${rod.name}** is broken and cannot be equipped. Repair it first with \`/fish shop repair\`.`, flags: MessageFlags.Ephemeral });
    }

    f.equippedRodIndex = index;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fish equip] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('✅ Rod Equipped')
                .setDescription(`You equipped **${rod.name}** (Slot ${number}).`)
                .addFields({ name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: true })
                .setTimestamp()
        ]
    });
}

function baitStockLines(f) {
    return Object.entries(f.bait ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([type, qty]) => {
            const pack = BAIT_PACKS.find(b => b.baitType === type);
            return `${pack?.emoji ?? '🪱'} **${type.replace(/_/g, ' ')}**: ${qty}`;
        });
}

function consumableStockLines(f) {
    return Object.entries(f.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            return `${def?.emoji ?? '📦'} **${def?.name ?? id}**: ${qty}`;
        });
}

function activeBuffLines(f) {
    const activeLines = [];
    if (f.activeBait) {
        const activeDef = CONSUMABLES[f.activeBait];
        const activeName = activeDef?.name ?? f.activeBait.replace(/_/g, ' ');
        activeLines.push(`${activeDef?.emoji ?? '🐟'} ${activeName} active (${f.activeBaitCastsLeft} casts left)`);
    }
    if (f.activeLuck)     activeLines.push(`🍀 Angler's Luck queued`);
    if (f.activeXpScroll) activeLines.push(`📜 XP Scroll queued`);
    return activeLines;
}

function baitEmbed(interaction, user) {
    const f = user.fishing;
    const baitLines = baitStockLines(f);
    const consumableLines = consumableStockLines(f);
    const activeLines = activeBuffLines(f);

    return new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`🎒 ${interaction.user.username}'s Fishing Supplies`)
        .addFields(
            { name: '🪱 Bait Stock', value: baitLines.length ? baitLines.join('\n') : 'None', inline: false },
            { name: '🧪 Consumables', value: consumableLines.length ? consumableLines.join('\n') : 'None', inline: false },
            { name: '⚡ Active Buffs', value: activeLines.length ? activeLines.join('\n') : 'None', inline: false }
        )
        .setFooter({ text: 'Use /fish shop to buy supplies • /use <item> to activate consumables' })
        .setTimestamp();
}

function fishingMaterialLines(user) {
    const f = user.fishing;
    const matLines = Object.entries(f.materials ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}**: ${qty}`);

    const huntMats = user.hunt?.materials ?? {};
    const huntMatLines = ['rabbits_foot', 'feather'].map(id => {
        const qty = huntMats[id] ?? 0;
        if (!qty) return null;
        return `• **${id.replace(/_/g, ' ')}** (hunt): ${qty}`;
    }).filter(Boolean);

    return { matLines, huntMatLines };
}

function materialsEmbed(interaction, user) {
    const { matLines, huntMatLines } = fishingMaterialLines(user);

    const embed = new EmbedBuilder()
        .setColor(COLORS.NEUTRAL)
        .setTitle(`🪨 ${interaction.user.username}'s Fishing Materials`)
        .addFields(
            { name: 'Fishing Materials', value: matLines.length ? matLines.join('\n') : 'None yet — catch fish for material drops!', inline: false }
        );

    if (huntMatLines.length) {
        embed.addFields({ name: 'Hunt Materials (cross-system)', value: huntMatLines.join('\n'), inline: false });
    }

    embed.setFooter({ text: 'Materials are used in crafting recipes. Use /fish craft list to see what you can make.' });
    embed.setTimestamp();
    return embed;
}

const OVERVIEW_ROD_PREVIEW = 5;

// The overview's text half lists every number the card draws (#672) but
// leaves the per-item emoji to the category views: the card carries the art,
// and the emoji doubled up (Lure shared 🎣 with the Rods heading, Premium
// Chum and Shrimp Bait were both 🦐). One emoji per heading, plus the rod
// status mark, which is information rather than decoration.

const titleCase = id => String(id).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Medallion colours for the materials, which have no baked art yet (#1168). */
const MATERIAL_COLORS = {
    fish_scale:     '#5dade2',
    rare_scale:     '#3498db',
    mythic_scale:   '#9b59b6',
    pearl:          '#ecf0f1',
    seaweed_bundle: '#27ae60',
    driftwood:      '#a0785a',
    old_coin:       '#f1c40f',
    shark_tooth:    '#bdc3c7',
    tentacle_ink:   '#34495e',
    coral_fragment: '#ff7f7f',
    rabbits_foot:   '#d7bde2',
    feather:        '#f5f5f5',
};

// Hunt drops that fishing recipes also take.
const HUNT_MATERIAL_NAMES = { rabbits_foot: "Rabbit's Foot", feather: 'Feather' };

const rodIconId = rod => {
    const slug = rod.slug ?? ROD_BY_TIER[rod.tier]?.slug;
    return slug && ROD_BY_SLUG[slug] ? `fish:${slug}` : null;
};

/** Everything /fish inv shows, as data both halves of the overview read. */
function inventoryStock(user) {
    const f = user.fishing;
    const bait = Object.entries(f.bait ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([type, qty]) => {
            const pack = BAIT_PACKS.find(b => b.baitType === type);
            return { iconId: pack ? `fish:${pack.id}` : null, name: titleCase(type), count: qty };
        });
    const consumables = Object.entries(f.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => ({ iconId: CONSUMABLES[id] ? `fish:${id}` : null, name: CONSUMABLES[id]?.name ?? titleCase(id), count: qty }));
    const materials = Object.entries(f.materials ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => ({ iconId: `fish:${id}`, name: MATERIAL_NAMES[id] ?? titleCase(id), count: qty, color: MATERIAL_COLORS[id] }));
    const huntMats = user.hunt?.materials ?? {};
    for (const id of Object.keys(HUNT_MATERIAL_NAMES)) {
        const qty = huntMats[id] ?? 0;
        if (qty) materials.push({ iconId: null, name: HUNT_MATERIAL_NAMES[id], source: 'hunt', count: qty, color: MATERIAL_COLORS[id] });
    }
    return { bait, consumables, materials };
}

/** "Worm Bait ×40 · Lure ×12", or the fallback when there is nothing. */
function stockLine(entries, empty) {
    return entries.length
        ? entries.map(e => `${e.name}${e.source ? ` (${e.source})` : ''} ×${e.count.toLocaleString('en-US')}`).join(' · ')
        : empty;
}

function overviewEmbed(interaction, user) {
    const f = user.fishing;
    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(`🎒 ${interaction.user.username}'s Tackle Box`)
        .setTimestamp();

    // Rods — a short preview, equipped first, pointing at the full list.
    if (!f.rods.length) {
        embed.addFields({ name: '🎣 Rods', value: 'None — buy one with `/fish shop rod`', inline: false });
    } else {
        const ordered = orderedRods(f);
        const preview = ordered.slice(0, OVERVIEW_ROD_PREVIEW).map(({ rod, index }) => {
            const equipped = index === f.equippedRodIndex ? ' · **equipped**' : '';
            const upgrade  = rod.upgrade ? ` · ${ROD_UPGRADES[rod.upgrade]?.name ?? titleCase(rod.upgrade)}` : '';
            return `**${index + 1}.** ${rod.name}${equipped} — ${rodStatusEmoji(rod.status)} ${rod.currentDurability}/${rod.maxDurability}${upgrade}`;
        });
        const extra = ordered.length - preview.length;
        if (extra > 0) preview.push(`…and ${extra} more — \`/fish inv category:rods\` for the full list`);
        embed.addFields({ name: `🎣 Rods (${f.rods.length})`, value: preview.join('\n'), inline: false });
    }

    const { bait, consumables, materials } = inventoryStock(user);
    embed.addFields(
        { name: '🪱 Bait',        value: stockLine(bait, 'None'),        inline: false },
        { name: '🧪 Consumables', value: stockLine(consumables, 'None'), inline: false },
    );

    const buffs = buffPills(f);
    if (buffs.length) embed.addFields({ name: '⚡ Active Buffs', value: buffs.join(' · '), inline: false });

    embed.addFields({ name: '🪨 Materials', value: stockLine(materials, 'None yet — catch fish for drops'), inline: false });

    embed.setFooter({ text: 'Open a section with /fish inv category:<name> • Equip a rod with /fish equip <number>' });
    return embed;
}

/** Plain buff names for the card, which cannot draw emoji. */
function buffPills(f) {
    const pills = [];
    if (f.activeBait) {
        const name = CONSUMABLES[f.activeBait]?.name ?? titleCase(f.activeBait);
        pills.push(`${name} (${f.activeBaitCastsLeft} casts left)`);
    }
    if (f.activeLuck)     pills.push("Angler's Luck queued");
    if (f.activeXpScroll) pills.push('XP Scroll queued');
    return pills;
}

function renderInventoryCard(interaction, user) {
    const f = user.fishing;
    const { bait, consumables, materials } = inventoryStock(user);
    const ordered = orderedRods(f);
    const rods = ordered.slice(0, OVERVIEW_ROD_PREVIEW).map(({ rod, index }) => ({
        iconId:   rodIconId(rod),
        name:     rod.name,
        number:   index + 1,
        current:  rod.currentDurability,
        max:      rod.maxDurability,
        status:   rod.status,
        equipped: index === f.equippedRodIndex,
        tag:      rod.upgrade ? (ROD_UPGRADES[rod.upgrade]?.name ?? titleCase(rod.upgrade)) : null,
    }));
    const sum = list => list.reduce((n, e) => n + e.count, 0);
    const subtitle = [
        `${f.rods.length} rod${f.rods.length === 1 ? '' : 's'}`,
        `${sum(bait).toLocaleString('en-US')} bait`,
        `${sum(consumables).toLocaleString('en-US')} consumables`,
        `${sum(materials).toLocaleString('en-US')} materials`,
    ].join(' · ');

    const describe = list => list.map(e => `${e.name} ${e.count}`).join(', ') || 'none';
    const alt = `Fishing inventory for ${interaction.user.username}. `
        + `Rods: ${rods.map(r => `${r.name} ${r.current} of ${r.max}${r.equipped ? ' (equipped)' : ''}`).join(', ') || 'none'}. `
        + `Bait: ${describe(bait)}. Consumables: ${describe(consumables)}. Materials: ${describe(materials)}.`;

    return renderAttachment(() => createGrindInventoryCard({
        activity: 'fish',
        title:    `${interaction.user.username}'s Tackle Box`,
        subtitle,
        buffs:    buffPills(f),
        gear: {
            label:   'Rods',
            count:   f.rods.length,
            entries: rods,
            more:    ordered.length - rods.length,
            empty:   'No rods yet — buy one with /fish shop rod.',
        },
        sections: [
            { label: 'Bait',        entries: bait,        empty: 'No bait — the Bamboo Rod fishes without it.' },
            { label: 'Consumables', entries: consumables, empty: 'No consumables — see /fish shop.' },
            { label: 'Materials',   entries: materials,   empty: 'None yet — catch fish for material drops.' },
        ],
    }), 'fish-inventory.png', alt);
}

async function overviewPayload(interaction, user) {
    const embed = overviewEmbed(interaction, user);
    const card = await renderInventoryCard(interaction, user);
    return pagePayload(embed, card);
}

module.exports = {
    handleEquip,
    handleInv,
    handlePrestige,
    handleProfile,
    __test__: { overviewEmbed, overviewPayload, inventoryStock },
};
