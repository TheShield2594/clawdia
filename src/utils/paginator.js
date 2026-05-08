const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

function chunkArray(items, chunkSize) {
    if (!Array.isArray(items) || chunkSize <= 0) return [];
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
}

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

function buildDisabledControls(page, totalPages, interactionId) {
    const row = buildControls(page, totalPages, interactionId);
    row.components.forEach(component => component.setDisabled(true));
    return row;
}

async function paginate(interaction, pages) {
    if (!pages?.length) {
        return interaction.reply({ content: 'Nothing to display.', ephemeral: true });
    }

    const normalizedPages = pages.map((embed, index) => {
        const clone = embed.data ? embed.constructor.from(embed) : embed;
        return clone.setFooter({ text: `Page ${index + 1} / ${pages.length}` });
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
        filter: btn => btn.user.id === interaction.user.id && (btn.customId === prevId || btn.customId === nextId),
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
