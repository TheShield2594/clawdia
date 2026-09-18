'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, AttachmentBuilder, MessageFlags
} = require('discord.js');

const ItemImage = require('../models/ItemImage');
const { renderCategoryBanner, getTheme } = require('./shopBanner');
const { shopImageId, shopItemIdOf } = require('../models/itemImageKeys');

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

    // One query for all three kinds of row, which is what #888 bought: a guild
    // shop item's image used to live on the guild settings document, so this
    // read the whole of it — every other item's Buffer included — before it
    // could look at the ItemImage collection at all.
    //
    // Activity images are per guild since #561, with the pre-#561 shared rows
    // (guildId: null) still readable as a fallback. The sort is what resolves
    // the precedence: shared first, then the guild's own activity image over
    // it, then the guild's shop image over that, each overwriting the last
    // rather than racing it.
    const docs = await ItemImage.find({
        itemId: { $in: [...ids, ...ids.map(shopImageId)] },
        guildId: { $in: [guildId || null, null] },
    });
    const rank = d => (shopItemIdOf(d.itemId) ? 2 : d.guildId == null ? 0 : 1);
    for (const d of [...docs].sort((a, b) => rank(a) - rank(b))) {
        const buf = toBuffer(d.imageData);
        if (buf) out[shopItemIdOf(d.itemId) ?? d.itemId] = buf;
    }
    return out;
}

/**
 * Render a paginated shop browse UI.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object}   config
 * @param {string}   [config.activity]  banner theme when a page/section sets none
 * @param {string}   config.title       e.g. 'Hunt Shop'
 * @param {string}   config.currency    currency symbol/emoji
 * @param {string}   [config.footer]    footer help text
 * @param {Array}    [config.pages]     ordered page descriptors (single-section shop)
 * @param {Array}    [config.sections]  ordered sections (a multi-shop storefront);
 *                                       when given, a section select is shown and
 *                                       `config.pages`/`config.activity` are ignored
 *
 * Each section:
 * {
 *   id:       string,            // stable id (used in image filenames)
 *   label:    string,            // shown in the section select
 *   title?:   string,            // banner title (defaults to label)
 *   emoji?:   string,            // for the section select
 *   activity?:string,            // banner theme for this section's pages
 *   pages:    [page]
 * }
 *
 * Each page:
 * {
 *   id:       string,
 *   label:    string,            // category label
 *   emoji:    string,            // for select menu
 *   subtitle: string,            // shown on banner under title
 *   activity?:string,            // banner theme override for this page
 *   items:    [{ id?: string, imageId?: string, name, price?, emoji, subline?, badge?, buyId? }],
 *   listText: string,            // text block shown below banner (buy commands etc.)
 *   onBuy?:   (interaction, buyId) => Promise<void>
 *                                // when set, a "Buy an item…" select is rendered for
 *                                // the page's items that carry a `buyId`; picking one
 *                                // calls onBuy with the component interaction and that
 *                                // buyId. onBuy owns its own reply (it should answer the
 *                                // passed interaction) — the browse message is left as-is.
 * }
 */
async function runShopBrowse(interaction, config) {
    const { title, currency, footer, guildId } = config;

    // A flat `pages` config is just a one-section storefront with no section
    // select — that keeps every single-shop caller (hunt/fish/mine list, the
    // old /shop view) working unchanged.
    const sections = Array.isArray(config.sections) && config.sections.length
        ? config.sections
        : [{ id: '_', label: title, title, activity: config.activity, pages: config.pages || [] }];
    const multiSection = sections.length > 1;

    const activityOf = (section, page) => page?.activity ?? section?.activity ?? config.activity;

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

    let sectionIdx = 0;
    let pageIdx = 0;

    // The control rows. Split out from buildMessage so a purchase can reset the
    // buy select without re-rendering the banner: a string select emits nothing
    // when the choice is unchanged, so a resent select with no default lets the
    // same item be bought again. Uses the raw page items (name/buyId/price), so
    // it needs no image hydration.
    function buildComponents(sIdx, pIdx) {
        const section  = sections[sIdx];
        const secPages = section.pages;
        const page     = secPages[pIdx];

        const prev = new ButtonBuilder()
            .setCustomId('shop_prev')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pIdx === 0);
        const next = new ButtonBuilder()
            .setCustomId('shop_next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pIdx === secPages.length - 1);
        const close = new ButtonBuilder()
            .setCustomId('shop_close')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger);

        const components = [new ActionRowBuilder().addComponents(prev, next, close)];

        // The section select switches shops (Server / Hunt / Fish / Mine). Only
        // shown for a real storefront — a single shop has nothing to switch to.
        if (multiSection) {
            const sectionSelect = new StringSelectMenuBuilder()
                .setCustomId('shop_section')
                .setPlaceholder('Switch shop…')
                .addOptions(sections.map((s, i) => {
                    const opt = { label: s.label.slice(0, 100), value: String(i), default: i === sIdx };
                    if (s.emoji) opt.emoji = s.emoji;
                    return opt;
                }));
            components.push(new ActionRowBuilder().addComponents(sectionSelect));
        }

        const select = new StringSelectMenuBuilder()
            .setCustomId('shop_cat')
            .setPlaceholder('Jump to category…')
            .addOptions(secPages.map((p, i) => ({
                label:   p.label.slice(0, 100),
                value:   String(i),
                emoji:   p.emoji,
                default: i === pIdx
            })));
        components.push(new ActionRowBuilder().addComponents(select));

        // When a page opts into buying, offer its buyable items in a select so a
        // shopper can purchase from the view they're already looking at instead
        // of retyping a slash command. Discord caps a select at 25 options; the
        // listText still advertises the slash command for anything past that.
        // Item emojis are deliberately left off these options — they come from
        // free-form item data, and one unresolvable emoji would reject the whole
        // message.
        const buyable = page.onBuy ? (page.items || []).filter(it => it.buyId != null) : [];
        if (buyable.length) {
            const buySelect = new StringSelectMenuBuilder()
                .setCustomId('shop_buy')
                .setPlaceholder('🛒 Buy an item…')
                .addOptions(buyable.slice(0, 25).map(it => {
                    const opt = {
                        label: String(it.name).slice(0, 100),
                        value: String(it.buyId).slice(0, 100),
                    };
                    if (it.price != null) {
                        opt.description = `${currency}${Number(it.price).toLocaleString()}`.slice(0, 100);
                    }
                    return opt;
                }));
            components.push(new ActionRowBuilder().addComponents(buySelect));
        }

        return components;
    }

    async function buildMessage(sIdx, pIdx) {
        const section  = sections[sIdx];
        const page     = section.pages[pIdx];
        const activity = activityOf(section, page);
        const colorHex = COLOR_HEX[activity] || '#f39c12';
        const bannerTitle = section.title || section.label || title;
        const items = await hydrate(page);

        const buffer = await renderCategoryBanner({
            activity,
            title:    `${bannerTitle} — ${page.label}`,
            subtitle: page.subtitle,
            items,
            currency
        });
        const filename   = `${activity}-${section.id}-${page.id}.png`;
        // Discord caps alt text at 1024 characters and rejects the upload over
        // it, so the item list — the one part of this that grows with the page —
        // is trimmed rather than allowed to fail the whole message.
        const shown = items.map(i => i.name).filter(Boolean).join(', ');
        const altText = `${bannerTitle} — ${page.label}: a banner showing `
            + (shown ? `${shown}.` : 'no items.');
        const attachment = new AttachmentBuilder(buffer, {
            name: filename,
            description: altText.slice(0, 1024),
        });

        const embed = new EmbedBuilder()
            .setColor(colorHex)
            .setImage(`attachment://${filename}`);

        if (page.listText) {
            embed.setDescription(page.listText.slice(0, 4000));
        }

        const sectionTag = multiSection ? `${section.label} • ` : '';
        embed.setFooter({
            text: `${sectionTag}Page ${pIdx + 1}/${section.pages.length} • ${footer || 'Use the menu to switch categories'}`
        });

        return {
            embeds:     [embed],
            files:      [attachment],
            components: buildComponents(sIdx, pIdx)
        };
    }

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
    }
    let reply;
    try {
        const initial = await buildMessage(sectionIdx, pageIdx);
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
        // A buy select hands off to the page's own purchase flow, which answers
        // the component interaction itself (typically an ephemeral confirm). The
        // browse message is left untouched — we must not defer or edit it here,
        // or the handoff would double-acknowledge the same interaction.
        if (btn.customId === 'shop_buy') {
            const page  = sections[sectionIdx].pages[pageIdx];
            const buyId = btn.values?.[0];
            if (page?.onBuy && buyId != null) {
                try {
                    await page.onBuy(btn, buyId);
                } catch (err) {
                    console.error('[shopBrowse] buy handler error:', err);
                    if (!btn.replied && !btn.deferred) {
                        btn.reply({
                            content: 'Something went wrong starting that purchase. Please try again.',
                            flags: MessageFlags.Ephemeral,
                        }).catch(() => {});
                    }
                }
                // Reset the buy select (via the original interaction — btn owns its
                // own reply) so the same item can be picked again; components only,
                // so the banner isn't re-rendered on every purchase.
                interaction.editReply({ components: buildComponents(sectionIdx, pageIdx) }).catch(() => {});
            }
            return;
        }
        if (btn.customId === 'shop_section') {
            // Switching shops resets to the new section's first page.
            const next = Number(btn.values?.[0]);
            if (Number.isInteger(next) && next >= 0 && next < sections.length) {
                sectionIdx = next;
                pageIdx = 0;
            }
        } else {
            const secPages = sections[sectionIdx].pages;
            if (btn.customId === 'shop_prev') pageIdx = Math.max(0, pageIdx - 1);
            else if (btn.customId === 'shop_next') pageIdx = Math.min(secPages.length - 1, pageIdx + 1);
            else if (btn.customId === 'shop_cat') {
                const next = Number(btn.values?.[0]);
                if (Number.isInteger(next) && next >= 0 && next < secPages.length) pageIdx = next;
            }
        }
        try {
            await btn.deferUpdate();
            const updated = await buildMessage(sectionIdx, pageIdx);
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
