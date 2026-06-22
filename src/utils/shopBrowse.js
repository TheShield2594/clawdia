'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, AttachmentBuilder, MessageFlags
} = require('discord.js');

const ItemImage = require('../models/ItemImage');
const Guild = require('../models/Guild');
const { renderCategoryBanner, getTheme } = require('./shopBanner');

const COLOR_HEX = {
    hunt:          '#27ae60',
    fish:          '#2980b9',
    mine:          '#b5651d',
    shop_common:   '#7f8c8d',
    shop_uncommon: '#27ae60',
    shop_rare:     '#2980b9',
    shop_epic:     '#9b59b6',
    shop_mythic:   '#e67e22',
};

function toBuffer(raw) {
    if (!raw) return null;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer || raw);
    return buf.length ? buf : null;
}

async function loadImagesByItemIds(itemIds, guildId = null) {
    const out = {};
    const ids = [...new Set(itemIds.filter(Boolean))];
    if (!ids.length) return out;

    // Guild shop items store their image on the shop sub-document itself.
    // Check there first so dashboard-uploaded icons appear in /shop view.
    if (guildId) {
        const guild = await Guild.findOne({ guildId }, { shop: 1 }).lean();
        if (guild?.shop) {
            for (const item of guild.shop) {
                if (!ids.includes(item.itemId)) continue;
                const buf = toBuffer(item.imageData);
                if (buf) out[item.itemId] = buf;
            }
        }
    }

    const missing = ids.filter(id => !out[id]);
    if (missing.length) {
        const docs = await ItemImage.find({ itemId: { $in: missing } });
        for (const d of docs) {
            const buf = toBuffer(d.imageData);
            if (buf) out[d.itemId] = buf;
        }
    }
    return out;
}

/**
 * Render a paginated shop browse UI.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object}   config
 * @param {string}   config.activity   'hunt' | 'fish' | 'mine'
 * @param {string}   config.title      e.g. 'Hunt Shop'
 * @param {string}   config.currency   currency symbol/emoji
 * @param {string}   [config.footer]   footer help text
 * @param {Array}    config.pages      ordered page descriptors
 *
 * Each page:
 * {
 *   id:       string,
 *   label:    string,            // category label
 *   emoji:    string,            // for select menu
 *   subtitle: string,            // shown on banner under title
 *   items:    [{ id?: string, imageId?: string, name, price?, emoji, subline?, badge? }],
 *   listText: string             // text block shown below banner (buy commands etc.)
 * }
 */
async function runShopBrowse(interaction, config) {
    const { activity, title, currency, pages, footer, guildId } = config;
    const colorHex = COLOR_HEX[activity] || '#f39c12';

    const imageCache = new Map();
    async function hydrate(page) {
        const wanted = page.items.map(it => it.imageId).filter(Boolean);
        const missing = wanted.filter(id => !imageCache.has(id));
        if (missing.length) {
            const fetched = await loadImagesByItemIds(missing, guildId);
            for (const id of missing) imageCache.set(id, fetched[id] || null);
        }
        return page.items.map(it => ({
            ...it,
            imageBuffer: it.imageId ? imageCache.get(it.imageId) : null
        }));
    }

    let pageIdx = 0;

    async function buildMessage(idx) {
        const page  = pages[idx];
        const items = await hydrate(page);

        const buffer = await renderCategoryBanner({
            activity,
            title:    `${title} — ${page.label}`,
            subtitle: page.subtitle,
            items,
            currency
        });
        const filename   = `${activity}-shop-${page.id}.png`;
        const attachment = new AttachmentBuilder(buffer, { name: filename });

        const embed = new EmbedBuilder()
            .setColor(colorHex)
            .setImage(`attachment://${filename}`);

        if (page.listText) {
            embed.setDescription(page.listText.slice(0, 4000));
        }

        embed.setFooter({
            text: `Page ${idx + 1}/${pages.length} • ${footer || 'Use the menu to switch categories'}`
        });

        const prev = new ButtonBuilder()
            .setCustomId('shop_prev')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(idx === 0);
        const next = new ButtonBuilder()
            .setCustomId('shop_next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(idx === pages.length - 1);
        const close = new ButtonBuilder()
            .setCustomId('shop_close')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger);

        const select = new StringSelectMenuBuilder()
            .setCustomId('shop_cat')
            .setPlaceholder('Jump to category…')
            .addOptions(pages.map((p, i) => ({
                label:   p.label.slice(0, 100),
                value:   String(i),
                emoji:   p.emoji,
                default: i === idx
            })));

        return {
            embeds:     [embed],
            files:      [attachment],
            components: [
                new ActionRowBuilder().addComponents(prev, next, close),
                new ActionRowBuilder().addComponents(select)
            ]
        };
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
    }
    let reply;
    try {
        const initial = await buildMessage(pageIdx);
        reply = await interaction.editReply(initial);
    } catch (err) {
        console.error('[shopBrowse] initial render error:', err);
        await interaction.editReply({ content: 'Failed to render the shop. Please try again.', embeds: [], components: [], files: [] }).catch(() => {});
        return;
    }

    const collector = reply.createMessageComponentCollector({ time: 5 * 60_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'These controls aren\'t for you — run the command yourself.', flags: MessageFlags.Ephemeral });
        }
        if (btn.customId === 'shop_close') {
            collector.stop('closed');
            return btn.update({ components: [] }).catch(() => {});
        }
        if (btn.customId === 'shop_prev') pageIdx = Math.max(0, pageIdx - 1);
        else if (btn.customId === 'shop_next') pageIdx = Math.min(pages.length - 1, pageIdx + 1);
        else if (btn.customId === 'shop_cat')  pageIdx = Number(btn.values?.[0] ?? pageIdx);
        try {
            await btn.deferUpdate();
            const updated = await buildMessage(pageIdx);
            await interaction.editReply(updated);
        } catch (err) {
            console.error('[shopBrowse] update error:', err);
        }
    });

    collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
    });
}

module.exports = { runShopBrowse, getTheme };
