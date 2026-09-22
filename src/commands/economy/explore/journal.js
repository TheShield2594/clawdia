'use strict';

// /explore journal — reread the expedition log, most recent finds first, with
// optional region and event-type filters.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { LIMITS, REGIONS } = require('../../../data/exploreData');
const { chunkByLength } = require('../../../utils/embedFields');
const { paginate } = require('../../../utils/paginator');
const { loadReadContext, EVENT_TYPE_EMOJI } = require('./shared');

// Entries per journal page. Ten timestamped lines sit far under the 4096
// description budget even when every summary runs long; chunkByLength backstops
// the pathological case regardless.
const JOURNAL_PAGE_SIZE = 10;

async function handleJournal(interaction) {
    const ctx = await loadReadContext(interaction);
    if (!ctx) return;
    const { user: userData } = ctx;

    const journal = userData?.exploration?.journal ?? [];
    if (!journal.length) {
        return interaction.reply({
            content: 'Your journal is empty. Every page is still possible. `/explore go` writes the first one.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // Both filters run on data every entry already carries — the type each find
    // was tagged with at write time, and the region it was written in.
    const regionFilter = interaction.options.getString('region');
    const typeFilter   = interaction.options.getString('type');
    const entries = journal.slice(0, LIMITS.JOURNAL_CAP).filter(entry =>
        (!regionFilter || entry.regionId === regionFilter)
        && (!typeFilter || entry.eventType === typeFilter));

    if (!entries.length) {
        const filterRegion = REGIONS[regionFilter];
        const wanted = [
            typeFilter ? `${EVENT_TYPE_EMOJI[typeFilter]} ${typeFilter}` : 'matching',
            filterRegion ? `entries from ${filterRegion.emoji} **${filterRegion.name}**` : 'entries',
        ].join(' ');
        return interaction.reply({
            content: `No ${wanted} in the last ${journal.length} journal entries. The wilds keep their own schedule.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const lines = entries.map(entry => {
        const region = REGIONS[entry.regionId];
        const stamp = `<t:${Math.floor(new Date(entry.at).getTime() / 1000)}:R>`;
        return `${EVENT_TYPE_EMOJI[entry.eventType] ?? '🥾'} ${region?.emoji ?? ''} **${region?.name ?? entry.regionId}** — ${entry.summary} *(${stamp})*`;
    });

    const filterNote = [
        typeFilter ? `${typeFilter} only` : null,
        REGIONS[regionFilter] ? `${REGIONS[regionFilter].name} only` : null,
    ].filter(Boolean).join(' · ');
    const footer = `${filterNote ? `${filterNote} • ` : ''}The last ${LIMITS.JOURNAL_CAP} entries are kept. The rest live in the retelling.`;

    // chunkByLength keeps each page inside the description budget even if a run
    // of long relic and secret summaries stacks up — discord.js throws rather
    // than truncating, so this used to be a latent way to lose the whole command.
    const pages = chunkByLength(lines, { maxPerChunk: JOURNAL_PAGE_SIZE }).map(pageLines =>
        new EmbedBuilder()
            .setColor('#8d6e63')
            .setTitle(`📔 Expedition Journal — ${interaction.user.username}`)
            .setDescription(pageLines.join('\n'))
            .setFooter({ text: footer })
            .setTimestamp());

    return paginate(interaction, pages);
}

module.exports = {
    handleJournal,
};
