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
const { ensureMineData, durabilityBar, pickaxeStatusEmoji } = require('../../../services/mineService');
const { packFieldsCapped, chunkByLength } = require('../../../utils/embedFields');
const { paginate } = require('../../../utils/paginator');
const { BLAST_PACKS, CONSUMABLES, MATERIAL_NAMES } = require('../../../data/mineData');
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

function chargeLines(m) {
    return BLAST_PACKS
        .map(b => ({ b, stock: m.charges[b.chargeType] ?? 0 }))
        .filter(({ stock }) => stock > 0)
        .map(({ b }) => `${b.emoji} ${b.chargeType.replace(/_/g, ' ')}: **${m.charges[b.chargeType] ?? 0}**`);
}

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

// ─── Overview: every category in one embed ────────────────────────────────────

function overviewEmbed(interaction, m) {
    const embed = new EmbedBuilder()
        .setColor('#b5651d')
        .setTitle(`⛏️ ${interaction.user.username}'s Mining Inventory`)
        .setTimestamp();

    if (!m.pickaxes.length) {
        embed.addFields({ name: '🪓 Pickaxes', value: 'None — buy one with `/mine shop pickaxe`', inline: false });
    } else {
        const lines = m.pickaxes.map((p, i) => {
            const isEquipped = i === m.equippedPickaxeIndex;
            const bar = durabilityBar(p.currentDurability, p.maxDurability);
            const upgradeStr = p.upgrade ? ` [${p.upgrade.replace(/_/g, ' ')}]` : '';
            return `**Slot ${i + 1}**${isEquipped ? ' *(equipped)*' : ''} — ${p.name}${upgradeStr} ${pickaxeStatusEmoji(p.status)}\n> ${bar} ${p.currentDurability}/${p.maxDurability}`;
        });
        // Nothing caps how many pickaxes a miner accumulates and each entry runs
        // ~85 characters, so a single field ran out of room around the twelfth one
        // and Discord rejected the whole embed. Spill into continuation fields —
        // but only so many: an embed also has a 6,000-character budget across all
        // of its fields, which unbounded spilling would eventually blow instead.
        const PICKAXE_FIELDS = 3;
        const { fields, omitted } = packFieldsCapped('🪓 Pickaxes', lines, { maxFields: PICKAXE_FIELDS });
        embed.addFields(...fields);
        if (omitted > 0) {
            embed.addFields({
                name: '…and more',
                value: `${omitted} further pickaxe(s) not shown — \`/mine inv category:pickaxes\` for the full list. \`/mine discard\` clears broken and condemned ones.`,
                inline: false
            });
        }

        const junk = m.pickaxes.filter(p => p.status === 'broken' || p.status === 'condemned').length;
        if (junk > 0) {
            embed.addFields({
                name: '🗑️ Unusable',
                value: `${junk} pickaxe${junk === 1 ? ' is' : 's are'} broken or condemned — clear ${junk === 1 ? 'it' : 'them'} out with \`/mine discard\`.`,
                inline: false
            });
        }
    }

    const charges = chargeLines(m);
    embed.addFields({ name: '💥 Blast Charges', value: charges.length ? charges.join('\n') : 'None', inline: true });

    const consumables = consumableLines(m);
    embed.addFields({ name: '🎒 Consumables', value: consumables.length ? consumables.join('\n') : 'None', inline: true });

    embed.addFields({ name: '🔋 Active Buffs', value: buffLines(m).join('\n') || 'None', inline: false });

    const mats = materialLines(m);
    embed.addFields({ name: '🪨 Materials', value: mats.length ? mats.join('\n') : 'None — find them by mining rare ores', inline: false });

    embed.setFooter({ text: 'Open a section with /mine inv category:<name> • Equip /mine equip <slot> • Discard /mine discard <slot>' });
    return embed;
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
        const upgradeStr = p.upgrade ? ` [${p.upgrade.replace(/_/g, ' ')}]` : '';
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
        default:            return interaction.reply({ embeds: [overviewEmbed(interaction, m)] });
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
                    { name: 'Upgrade',    value: pickaxe.upgrade ? pickaxe.upgrade.replace(/_/g, ' ') : 'None', inline: true }
                )
                .setTimestamp()
        ]
    });
}

// ─── /mine discard <slot> ─────────────────────────────────────────────────────

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
        m.equippedPickaxeIndex = m.pickaxes.length > 0 ? 0 : -1;
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
};
