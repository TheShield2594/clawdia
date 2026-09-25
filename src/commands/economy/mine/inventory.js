'use strict';

// The /mine inventory surface — one read-only /mine inv that shows pickaxes,
// charges, consumables and materials at a glance, with a `category` option that
// opens one of them in full, plus /mine equip and /mine discard as their own
// top-level subcommands.
//
// It was a subcommand group (/mine inv view / equip / discard); the group
// collapsed because Discord will not run a subcommand *group* on its own, so
// /mine inv had to become a plain subcommand to be runnable, and the two
// mutating actions moved up a level with it.

const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureMineData, durabilityBar, isCondemned, pickaxeStatusEmoji } = require('../../../services/mineService');
const { chunkByLength } = require('../../../utils/embedFields');
const { paginate } = require('../../../utils/paginator');
const { BLAST_PACKS, CONSUMABLES, MATERIAL_NAMES, PICKAXE_BY_TIER, PICKAXE_BY_SLUG, PICKAXE_UPGRADES } = require('../../../data/mineData');
const { renderAttachment, pagePayload, stockLine, titleCase } = require('../../../utils/grindProfileView');
const { createGrindInventoryCard } = require('../../../utils/grindProfileCard');
const COLORS = require('../../../utils/embedColors');

// ─── Shared loader ──────────────────────────────────────────────────────────

// Loads the user's mining data, or replies and returns null when the economy is
// off. Every /mine inv, /mine equip and /mine discard invocation starts here.
async function loadMine(interaction) {
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
    ensureMineData(user);
    return user;
}

// ─── Section helpers ──────────────────────────────────────────────────────────

function consumableLines(m) {
    return Object.entries(m.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            return def ? `${def.emoji} ${def.name}: **${qty}**` : `${id}: **${qty}**`;
        });
}

function buffLines(m) {
    const buffs = [];
    if (m.activeMagnet)   buffs.push(`🧲 ${m.activeMagnet.replace(/_/g, ' ')} (${m.activeMagnetMinesLeft} mines left)`);
    if (m.activeLamp)     buffs.push(`🪔 Miner's Lamp (${m.activeLampMinesLeft} mines left)`);
    if (m.activeInstinct) buffs.push(`🎯 Miner's Instinct (queued)`);
    if (m.activeXpScroll) buffs.push(`📜 XP Scroll (queued)`);
    return buffs;
}

function materialLines(m) {
    return Object.entries(m.materials ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);
}

// ─── Overview: a tool-belt card and its text half ─────────────────────────────

const OVERVIEW_PICKAXE_PREVIEW = 5;
const OVERVIEW_MATERIAL_TILES = 16;

/** Everything the overview shows, as data both halves read. */
function inventoryStock(m) {
    const charges = BLAST_PACKS
        .map(pack => ({ iconId: `mine:${pack.id}`, name: titleCase(pack.chargeType), count: m.charges?.[pack.chargeType] ?? 0 }))
        .filter(e => e.count > 0);
    const consumables = Object.entries(m.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => ({ iconId: CONSUMABLES[id] ? `mine:${id}` : null, name: CONSUMABLES[id]?.name ?? titleCase(id), count: qty }));
    const materials = Object.entries(m.materials ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => ({ iconId: `mine:${id}`, name: MATERIAL_NAMES[id] ?? titleCase(id), count: qty }));
    return { charges, consumables, materials };
}

/** Plain buff names — the card cannot draw emoji, and the text matches it. */
function buffPills(m) {
    const pills = [];
    if (m.activeMagnet)   pills.push(`${CONSUMABLES[m.activeMagnet]?.name ?? titleCase(m.activeMagnet)} (${m.activeMagnetMinesLeft} mines left)`);
    if (m.activeLamp)     pills.push(`Miner's Lamp (${m.activeLampMinesLeft} mines left)`);
    if (m.activeInstinct) pills.push("Miner's Instinct queued");
    if (m.activeXpScroll) pills.push('XP Scroll queued');
    return pills;
}

const upgradeName = id => (id ? (PICKAXE_UPGRADES[id]?.name ?? titleCase(id)) : null);

// Equipped first, then by tier, carrying the slot number /mine equip takes.
function orderedPickaxes(m) {
    return m.pickaxes
        .map((p, index) => ({ p, index }))
        .sort((a, b) => {
            if (a.index === m.equippedPickaxeIndex) return -1;
            if (b.index === m.equippedPickaxeIndex) return 1;
            return (b.p.tier ?? 0) - (a.p.tier ?? 0);
        });
}

function overviewEmbed(interaction, m) {
    const embed = new EmbedBuilder()
        .setColor('#b5651d')
        .setTitle(`⛏️ ${interaction.user.username}'s Tool Belt`)
        .setTimestamp();

    if (!m.pickaxes.length) {
        embed.addFields({ name: '🪓 Pickaxes', value: 'None — buy one with `/mine shop pickaxe`', inline: false });
    } else {
        const ordered = orderedPickaxes(m);
        const preview = ordered.slice(0, OVERVIEW_PICKAXE_PREVIEW).map(({ p, index }) => {
            const equipped = index === m.equippedPickaxeIndex ? ' · **equipped**' : '';
            const upgrade  = p.upgrade ? ` · ${upgradeName(p.upgrade)}` : '';
            return `**Slot ${index + 1}** ${p.name}${equipped} — ${pickaxeStatusEmoji(p.status)} ${p.currentDurability}/${p.maxDurability}${upgrade}`;
        });
        const extra = ordered.length - preview.length;
        if (extra > 0) preview.push(`…and ${extra} more — \`/mine inv category:pickaxes\` for the full list`);
        embed.addFields({ name: `🪓 Pickaxes (${m.pickaxes.length})`, value: preview.join('\n'), inline: false });

        // Only a pickaxe that is broken *and* condemned is junk. A condemned one
        // still digs until it breaks, and a broken one that is not condemned is a
        // repair away — telling either to discard itself threw away a working tool.
        const junk = m.pickaxes.filter(p => p.status === 'broken' && isCondemned(p)).length;
        const repairable = m.pickaxes.filter(p => p.status === 'broken' && !isCondemned(p)).length;
        if (junk > 0) {
            embed.addFields({
                name: '🗑️ Beyond Repair',
                value: `${junk} pickaxe${junk === 1 ? ' is' : 's are'} broken and condemned — clear ${junk === 1 ? 'it' : 'them'} out with \`/mine discard\`.`,
                inline: false
            });
        }
        if (repairable > 0) {
            embed.addFields({
                name: '🔧 Broken',
                value: `${repairable} pickaxe${repairable === 1 ? ' needs' : 's need'} a repair — equip it and use \`/mine shop repair\`.`,
                inline: false
            });
        }
    }

    const { charges, consumables, materials } = inventoryStock(m);
    embed.addFields(
        { name: '💥 Blast Charges', value: stockLine(charges, 'None'),     inline: false },
        { name: '🎒 Consumables',   value: stockLine(consumables, 'None'), inline: false },
    );

    const buffs = buffPills(m);
    if (buffs.length) embed.addFields({ name: '🔋 Active Buffs', value: buffs.join(' · '), inline: false });

    embed.addFields({ name: '🪨 Materials', value: stockLine(materials, 'None — find them by mining rare ores'), inline: false });

    embed.setFooter({ text: 'Open a section with /mine inv category:<name> • Equip /mine equip <slot> • Discard /mine discard <slot>' });
    return embed;
}

function renderInventoryCard(interaction, m) {
    const { charges, consumables, materials } = inventoryStock(m);
    const ordered = orderedPickaxes(m);
    const pickaxes = ordered.slice(0, OVERVIEW_PICKAXE_PREVIEW).map(({ p, index }) => {
        const slug = p.slug && PICKAXE_BY_SLUG[p.slug] ? p.slug : PICKAXE_BY_TIER[p.tier]?.slug;
        return {
            iconId:   slug ? `mine:${slug}` : null,
            name:     p.name,
            number:   index + 1,
            current:  p.currentDurability,
            max:      p.maxDurability,
            status:   p.status,
            equipped: index === m.equippedPickaxeIndex,
            tag:      upgradeName(p.upgrade),
        };
    });
    const matTiles = materials.slice(0, OVERVIEW_MATERIAL_TILES);
    const sum = list => list.reduce((n, e) => n + e.count, 0);
    const subtitle = [
        `${m.pickaxes.length} pickaxe${m.pickaxes.length === 1 ? '' : 's'}`,
        `${sum(charges).toLocaleString('en-US')} charges`,
        `${sum(consumables).toLocaleString('en-US')} consumables`,
        `${sum(materials).toLocaleString('en-US')} materials`,
    ].join(' · ');

    const describe = list => list.map(e => `${e.name} ${e.count}`).join(', ') || 'none';
    const alt = `Mining inventory for ${interaction.user.username}. `
        + `Pickaxes: ${pickaxes.map(p => `${p.name} ${p.current} of ${p.max}${p.equipped ? ' (equipped)' : ''}`).join(', ') || 'none'}. `
        + `Charges: ${describe(charges)}. Consumables: ${describe(consumables)}. Materials: ${describe(materials)}.`;

    return renderAttachment(() => createGrindInventoryCard({
        activity: 'mine',
        title:    `${interaction.user.username}'s Tool Belt`,
        subtitle,
        buffs:    buffPills(m),
        gear: {
            label:   'Pickaxes',
            count:   m.pickaxes.length,
            entries: pickaxes,
            more:    ordered.length - pickaxes.length,
            empty:   'No pickaxes yet — buy one with /mine shop pickaxe.',
        },
        sections: [
            { label: 'Blast Charges', entries: charges,     empty: 'No charges — the Wooden Pickaxe digs without them.' },
            { label: 'Consumables',   entries: consumables, empty: 'No consumables — see /mine shop.' },
            { label: 'Materials',     entries: matTiles,    count: materials.length || null, more: materials.length - matTiles.length,
                empty: 'None yet — mine rare ores for drops.' },
        ],
    }), 'mine-inventory.png', alt);
}

async function overviewPayload(interaction, m) {
    const embed = overviewEmbed(interaction, m);
    const card = await renderInventoryCard(interaction, m);
    return pagePayload(embed, card);
}

// ─── Focused category views ───────────────────────────────────────────────────

function pickaxePages(m) {
    if (!m.pickaxes.length) {
        return [new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle('🪓 Your Pickaxes')
            .setDescription('None — buy one with `/mine shop pickaxe`.')];
    }

    const lines = m.pickaxes.map((p, i) => {
        const isEquipped = i === m.equippedPickaxeIndex;
        const bar = durabilityBar(p.currentDurability, p.maxDurability);
        const upgradeStr = p.upgrade ? ` [${upgradeName(p.upgrade)}]` : '';
        return `**Slot ${i + 1}**${isEquipped ? ' *(equipped)*' : ''} — ${p.name}${upgradeStr} ${pickaxeStatusEmoji(p.status)}\n> ${bar} ${p.currentDurability}/${p.maxDurability}`;
    });

    return chunkByLength(lines, { separator: '\n\n', maxPerChunk: 8 }).map((chunk, _i, all) => new EmbedBuilder()
        .setColor('#b5651d')
        .setTitle(all.length > 1 ? `🪓 Your Pickaxes (${m.pickaxes.length})` : '🪓 Your Pickaxes')
        .setDescription(chunk.join('\n\n'))
        .setFooter({ text: 'Use /mine equip <slot> to change pickaxe • /mine shop repair to restore durability' }));
}

function chargesEmbed(m) {
    // Every charge type, including empty stocks, so a miner can see what a pack
    // would fill rather than only what they hold.
    const lines = BLAST_PACKS.map(b => `${b.emoji} ${b.chargeType.replace(/_/g, ' ')}: **${m.charges[b.chargeType] ?? 0}**`);
    return new EmbedBuilder()
        .setColor('#b5651d')
        .setTitle('💥 Blast Charges')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Buy charge packs with /mine shop buy <item>' });
}

function consumablesEmbed(m) {
    const consumables = consumableLines(m);
    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('🎒 Consumables')
        .addFields({ name: 'In Stock', value: consumables.length ? consumables.join('\n') : 'None', inline: false });

    const buffs = buffLines(m);
    if (buffs.length) embed.addFields({ name: '🔋 Active Buffs', value: buffs.join('\n'), inline: false });

    embed.setFooter({ text: 'Buy from /mine shop • Activate with /mine shop use <item>' });
    return embed;
}

function materialsPages(m) {
    const mats = materialLines(m).map(line => `• ${line}`);
    const footer = 'Materials feed crafting recipes — see /craft list.';
    if (!mats.length) {
        return [new EmbedBuilder()
            .setColor('#1abc9c')
            .setTitle('🪨 Mining Materials')
            .setDescription('None yet — mine rare ores to find special drops!')
            .setFooter({ text: footer })];
    }
    return chunkByLength(mats).map(chunk => new EmbedBuilder()
        .setColor('#1abc9c')
        .setTitle('🪨 Mining Materials')
        .setDescription(chunk.join('\n'))
        .setFooter({ text: footer }));
}

// ─── /mine inv [category] ─────────────────────────────────────────────────────

async function handleInv(interaction) {
    const user = await loadMine(interaction);
    if (!user) return;
    const m = user.mining;

    const category = interaction.options.getString('category');
    switch (category) {
        case 'pickaxes':    return paginate(interaction, pickaxePages(m));
        case 'charges':     return interaction.reply({ embeds: [chargesEmbed(m)] });
        case 'consumables': return interaction.reply({ embeds: [consumablesEmbed(m)] });
        case 'materials':   return paginate(interaction, materialsPages(m));
        default:            return interaction.reply(await overviewPayload(interaction, m));
    }
}

// ─── /mine equip <slot> ───────────────────────────────────────────────────────

async function handleEquip(interaction) {
    const user = await loadMine(interaction);
    if (!user) return;
    const m = user.mining;

    const slot = interaction.options.getInteger('slot') - 1;

    if (!m.pickaxes[slot]) {
        return interaction.reply({ content: `No pickaxe in slot ${slot + 1}.`, flags: MessageFlags.Ephemeral });
    }

    const pickaxe = m.pickaxes[slot];
    if (pickaxe.status === 'broken') {
        return interaction.reply({ content: `**${pickaxe.name}** is broken and can't be equipped. Repair it first with \`/mine shop repair\`.`, flags: MessageFlags.Ephemeral });
    }

    m.equippedPickaxeIndex = slot;
    user.markModified('mining');
    await user.save();

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('⛏️ Pickaxe Equipped')
                .setDescription(`You equipped **${pickaxe.name}**.`)
                .addFields(
                    { name: 'Durability', value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                    { name: 'Status',     value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true },
                    { name: 'Upgrade',    value: upgradeName(pickaxe.upgrade) ?? 'None', inline: true }
                )
                .setTimestamp()
        ]
    });
}

// ─── /mine discard <slot> ─────────────────────────────────────────────────────

// Which pickaxe to hand the miner when the one in their hand is discarded: the
// best one that can still dig, so a discard never swaps a broken pickaxe for
// another broken one while a working one sits further down the belt. Falls back
// to the first slot, broken or not, so /mine dig can say "repair it" rather than
// "you have no pickaxe".
function replacementIndex(pickaxes) {
    let best = -1;
    pickaxes.forEach((p, i) => {
        if (p.status === 'broken' || !(p.currentDurability > 0)) return;
        if (best === -1 || (p.tier ?? 0) > (pickaxes[best].tier ?? 0)) best = i;
    });
    if (best !== -1) return best;
    return pickaxes.length > 0 ? 0 : -1;
}

async function handleDiscard(interaction) {
    const user = await loadMine(interaction);
    if (!user) return;
    const m = user.mining;

    const index = interaction.options.getInteger('slot') - 1;

    if (index < 0 || index >= m.pickaxes.length) {
        return interaction.reply({
            content: `No pickaxe in slot ${index + 1}. You have ${m.pickaxes.length} pickaxe(s).`,
            flags: MessageFlags.Ephemeral
        });
    }

    const pickaxe = m.pickaxes[index];
    if (pickaxe.status !== 'broken' && pickaxe.status !== 'condemned') {
        return interaction.reply({
            content: `**${pickaxe.name}** is not broken or condemned. You can only discard unusable pickaxes.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Splicing shifts every later slot down by one, so the equipped index has to
    // move with it or the miner silently ends up wielding a different pickaxe.
    const wasEquipped = m.equippedPickaxeIndex === index;
    m.pickaxes.splice(index, 1);

    if (wasEquipped) {
        m.equippedPickaxeIndex = replacementIndex(m.pickaxes);
    } else if (m.equippedPickaxeIndex > index) {
        m.equippedPickaxeIndex -= 1;
    }

    user.markModified('mining');
    await user.save();

    const nowEquipped = m.pickaxes[m.equippedPickaxeIndex];
    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.ERROR)
                .setTitle('🗑️ Pickaxe Discarded')
                .setDescription(
                    `**${pickaxe.name}** has been discarded.` +
                    (wasEquipped && nowEquipped ? `\nYou are now wielding **${nowEquipped.name}**.` : '')
                )
                .setFooter({ text: m.pickaxes.length === 0
                    ? 'Buy a new pickaxe with /mine shop pickaxe'
                    : 'Use /mine inv to see your remaining pickaxes' })
                .setTimestamp()
        ]
    });
}

module.exports = {
    handleInv,
    handleEquip,
    handleDiscard,
    // Exposed for tests: the pure per-category and overview builders, which take
    // a plain mining-data object and return embeds without touching the database.
    __test__: {
        overviewEmbed,
        overviewPayload,
        replacementIndex,
        inventoryStock,
        pickaxePages,
        chargesEmbed,
        consumablesEmbed,
        materialsPages,
    },
};
