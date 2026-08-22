const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

// The catalog is derived from the commands this process actually loaded, not
// from a list kept alongside them — see utils/helpCatalog.js for why (#665).
const { buildCategories } = require('../../utils/helpCatalog');

const TIMEOUT_MS = 3 * 60 * 1000;
const PAGE_SIZE = 10;
const COLOR = '#5865F2';

function buildLandingEmbed(categories) {
    const lines = categories.map(cat =>
        `${cat.emoji} **${cat.label}** — ${cat.commands.length} commands: ${cat.preview}`
    );
    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🐾 Clawdia Help')
        .setDescription(
            'Select a category below to see available commands.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            lines.join('\n') +
            '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        )
        .setFooter({ text: 'Select a category from the dropdown below' });
}

function buildCategoryEmbed(cat, page) {
    const totalPages = Math.ceil(cat.commands.length / PAGE_SIZE);
    const slice = cat.commands.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const lines = slice.map(cmd =>
        cmd.mention
            ? `\`${cmd.name}\` — ${cmd.description}`
            : `\`/${cmd.name}\` — ${cmd.description}`
    );
    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`${cat.emoji} ${cat.label} Commands`)
        .setDescription(
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            lines.join('\n') +
            '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        )
        .setFooter({ text: `Page ${page + 1} of ${totalPages} • ${cat.commands.length} commands total` });
}

function buildSelectRow(categories, disabled = false) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('help_category')
        .setPlaceholder('Select a category…')
        .setDisabled(disabled)
        .addOptions(
            categories.map(cat =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${cat.emoji} ${cat.label}`)
                    .setDescription(cat.summary)
                    .setValue(cat.id)
            )
        );
    return new ActionRowBuilder().addComponents(menu);
}

function buildNavRow(id, cat, page, disabled = false) {
    const totalPages = Math.ceil(cat.commands.length / PAGE_SIZE);
    const backBtn = new ButtonBuilder()
        .setCustomId(`help_back_${id}`)
        .setLabel('↩ Back')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);

    if (totalPages <= 1) {
        return new ActionRowBuilder().addComponents(backBtn);
    }

    const prevBtn = new ButtonBuilder()
        .setCustomId(`help_prev_${id}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || page === 0);

    const nextBtn = new ButtonBuilder()
        .setCustomId(`help_next_${id}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || page >= totalPages - 1);

    return new ActionRowBuilder().addComponents(prevBtn, backBtn, nextBtn);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Browse all bot commands by category'),
    async execute(interaction) {
        const id = interaction.id;
        const categories = buildCategories(interaction.client?.commands?.values?.() || []);

        // Only reachable if the collection is empty, which startup refuses to
        // run with — but a select menu with no options is a Discord API error
        // rather than an empty menu, so it cannot just fall through.
        if (!categories.length) {
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(COLOR)
                    .setTitle('🐾 Clawdia Help')
                    .setDescription('No commands are loaded right now. Try again in a moment.')],
            });
            return;
        }

        const findCategory = catId => categories.find(c => c.id === catId);
        const state = { view: 'landing', catId: null, page: 0 };

        await interaction.reply({
            embeds: [buildLandingEmbed(categories)],
            components: [buildSelectRow(categories)],
        });

        const message = await interaction.fetchReply();

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: TIMEOUT_MS,
        });

        collector.on('collect', async i => {
            if (i.customId === 'help_category') {
                const cat = findCategory(i.values[0]);
                if (!cat) return;
                state.view = 'category';
                state.catId = cat.id;
                state.page = 0;
                await i.update({
                    embeds: [buildCategoryEmbed(cat, 0)],
                    components: [buildNavRow(id, cat, 0)],
                });
            } else if (i.customId === `help_back_${id}`) {
                state.view = 'landing';
                state.catId = null;
                state.page = 0;
                await i.update({
                    embeds: [buildLandingEmbed(categories)],
                    components: [buildSelectRow(categories)],
                });
            } else if (i.customId === `help_prev_${id}` || i.customId === `help_next_${id}`) {
                const cat = findCategory(state.catId);
                if (!cat) return;
                const step = i.customId === `help_next_${id}` ? 1 : -1;
                const totalPages = Math.ceil(cat.commands.length / PAGE_SIZE);
                state.page = Math.max(0, Math.min(state.page + step, totalPages - 1));
                await i.update({
                    embeds: [buildCategoryEmbed(cat, state.page)],
                    components: [buildNavRow(id, cat, state.page)],
                });
            }
        });

        collector.on('end', async (_, reason) => {
            if (reason !== 'time') return;
            const cat = state.view === 'landing' ? null : findCategory(state.catId);
            const components = cat
                ? [buildNavRow(id, cat, state.page, true)]
                : [buildSelectRow(categories, true)];
            await interaction.editReply({ components }).catch(() => {});
        });
    },
};
