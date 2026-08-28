const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } = require('discord.js');
const { ownedBy } = require('../utils/collectorOwner');

/**
 * Split a list into fixed-size chunks — one per page, typically, before each
 * chunk is rendered into an embed and the set handed to `paginate`.
 *
 * @param {Array} items
 * @param {number} chunkSize
 * @returns {Array[]} empty when `items` is not an array or `chunkSize` is not
 *   positive, rather than throwing: callers page over query results that may
 *   legitimately be empty
 */
function chunkArray(items, chunkSize) {
    if (!Array.isArray(items) || chunkSize <= 0) return [];
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
}

/**
 * The previous/next row, with the button at either end of the range disabled.
 * The interaction id is in the custom ids so two paginated replies in the same
 * channel cannot collect each other's clicks.
 *
 * @param {number} page zero-based
 * @param {number} totalPages
 * @param {string} interactionId
 * @returns {import('discord.js').ActionRowBuilder}
 */
function buildControls(page, totalPages, interactionId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`paginate_prev_${interactionId}`)
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`paginate_next_${interactionId}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1)
    );
}

/**
 * The same row with everything disabled, left behind when the collector expires
 * so the buttons read as dead rather than unresponsive.
 *
 * @param {number} page
 * @param {number} totalPages
 * @param {string} interactionId
 * @returns {import('discord.js').ActionRowBuilder}
 */
function buildDisabledControls(page, totalPages, interactionId) {
    const row = buildControls(page, totalPages, interactionId);
    row.components.forEach(component => component.setDisabled(true));
    return row;
}

/**
 * Reply with a page-through-able set of embeds.
 *
 * Owns the whole interaction: it sends the reply, so the caller must not have
 * replied or deferred. Each embed's footer gains `Page n / m`, appended to
 * whatever footer it already carried. A single page is sent without controls,
 * and an empty set gets an ephemeral "Nothing to display" rather than an error.
 *
 * Only the member who ran the command can page — someone else's click is
 * refused by `ownedBy` with a note telling them to run it themselves. The
 * collector lives 2 minutes; when it ends the buttons are disabled in place.
 *
 * Resolves once the reply is sent, not when paging finishes: the collector
 * outlives the call.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction an
 *   unreplied, undeferred interaction
 * @param {import('discord.js').EmbedBuilder[]} pages one embed per page
 * @returns {Promise<void>}
 */
async function paginate(interaction, pages) {
    if (!pages?.length) {
        return interaction.reply({ content: 'Nothing to display.', flags: MessageFlags.Ephemeral });
    }

    const normalizedPages = pages.map((embed, index) => {
        const clone = EmbedBuilder.from(embed);
        const originalFooterText = clone.data?.footer?.text;
        const pageText = `Page ${index + 1} / ${pages.length}`;
        const footerText = originalFooterText ? `${originalFooterText} • ${pageText}` : pageText;
        return clone.setFooter({ text: footerText });
    });

    if (normalizedPages.length === 1) {
        return interaction.reply({ embeds: [normalizedPages[0]] });
    }

    const prevId = `paginate_prev_${interaction.id}`;
    const nextId = `paginate_next_${interaction.id}`;
    let page = 0;
    const message = await interaction.reply({
        embeds: [normalizedPages[page]],
        components: [buildControls(page, normalizedPages.length, interaction.id)],
        fetchReply: true
    });

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: ownedBy(
            interaction.user.id,
            btn => btn.customId === prevId || btn.customId === nextId,
            "This isn't your list — run the command yourself to page through your own.",
        ),
        time: 120_000
    });

    collector.on('collect', async btn => {
        if (btn.customId === prevId) page = Math.max(0, page - 1);
        if (btn.customId === nextId) page = Math.min(normalizedPages.length - 1, page + 1);

        await btn.update({
            embeds: [normalizedPages[page]],
            components: [buildControls(page, normalizedPages.length, interaction.id)]
        });
    });

    collector.on('end', async () => {
        await interaction.editReply({
            components: [buildDisabledControls(page, normalizedPages.length, interaction.id)]
        }).catch(() => {});
    });
}

module.exports = {
    chunkArray,
    paginate
};
