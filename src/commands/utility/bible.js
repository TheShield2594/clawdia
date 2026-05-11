const { SlashCommandBuilder } = require('discord.js');
const { lookupVerse, getDailyVerse, createVerseEmbed } = require('../../services/bibleService');
const Guild = require('../../models/Guild');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('bible')
        .setDescription('Look up a Bible verse or get today\'s daily verse')
        .addSubcommand(sub =>
            sub.setName('verse')
                .setDescription('Look up a specific Bible verse')
                .addStringOption(opt =>
                    opt.setName('reference')
                        .setDescription('Verse reference, e.g. John 3:16 or Romans 8:28')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('translation')
                        .setDescription('Bible translation (default: KJV)')
                        .addChoices(
                            { name: 'King James Version (KJV)', value: 'kjv' },
                            { name: 'New International Version (NIV)', value: 'niv' },
                            { name: 'American Standard Version (ASV)', value: 'asv' },
                            { name: 'World English Bible (WEB)', value: 'web' },
                            { name: "Young's Literal Translation (YLT)", value: 'ylt' },
                            { name: 'Darby', value: 'darby' },
                            { name: 'Bible in Basic English (BBE)', value: 'bbe' },
                            { name: 'World English Bible British Edition (WEBBE)', value: 'webbe' }
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('daily')
                .setDescription("Get today's daily Bible verse")
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const sub = interaction.options.getSubcommand();

        if (sub === 'verse') {
            const reference = interaction.options.getString('reference');
            const translation = interaction.options.getString('translation') || 'kjv';

            if (translation === 'niv') {
                return interaction.editReply({
                    content: `NIV is not available for on-demand verse lookup (it's a copyrighted translation). Use \`/bible daily\` to see today's verse in NIV, or choose a free translation like KJV, ASV, or WEB.`
                });
            }

            const verseData = await lookupVerse(reference, translation);
            if (!verseData?.text) {
                return interaction.editReply({
                    content: `Could not find **${reference}**. Please check the reference and try again.\nExample: \`John 3:16\`, \`Romans 8:28\`, \`Psalms 23:1-6\``
                });
            }

            const embed = createVerseEmbed(verseData);
            await interaction.editReply({ embeds: [embed] });

        } else if (sub === 'daily') {
            const verseData = await getDailyVerse();
            if (!verseData) {
                return interaction.editReply({
                    content: 'Could not fetch today\'s daily verse. Please try again later.'
                });
            }

            const guildSettings = await Guild.findOne({ guildId: interaction.guildId });
            const translation = guildSettings?.bibleVerse?.translation || 'kjv';

            let displayVerse = verseData;
            if (translation !== 'kjv' && translation !== 'niv' && verseData.reference) {
                const translated = await lookupVerse(verseData.reference, translation);
                if (translated?.text) displayVerse = translated;
            }

            const embed = createVerseEmbed(displayVerse, '📖 Daily Bible Verse');
            await interaction.editReply({ embeds: [embed] });
        }
    }
};
