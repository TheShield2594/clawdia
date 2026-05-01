const { SlashCommandBuilder } = require('discord.js');
const { lookupVerse, getDailyVerse, createVerseEmbed } = require('../../services/bibleService');

module.exports = {
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
                            { name: 'American Standard Version (ASV)', value: 'asv' },
                            { name: 'World English Bible (WEB)', value: 'web' },
                            { name: "Young's Literal Translation (YLT)", value: 'ylt' },
                            { name: 'Darby', value: 'darby' }
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

            const embed = createVerseEmbed(verseData, '📖 Daily Bible Verse');
            await interaction.editReply({ embeds: [embed] });
        }
    }
};
