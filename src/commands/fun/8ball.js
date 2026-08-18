'use strict';

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    escapeMarkdown,
} = require('discord.js');
const { delay } = require('../../utils/delay');
const { createReplaySession } = require('../../utils/replaySession');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b1.png';

const MAX_QUESTION   = 200;
const SHAKE_FRAME_MS = 260;

const MODAL_WAIT_MS = 120_000;

// The ball sloshing to the window before it settles.
const SHAKE_FRAMES = [
    '🎱 ‧ ‧ ‧',
    '‧ 🎱 ‧ ‧',
    '‧ ‧ 🎱 ‧',
];

const RESPONSES = {
    positive: [
        'It is certain.',
        'It is decidedly so.',
        'Without a doubt.',
        'Yes, definitely.',
        'You may rely on it.',
        'As I see it, yes.',
        'Most likely.',
        'Outlook good.',
        'Yes.',
        'Signs point to yes.',
    ],
    neutral: [
        'Reply hazy, try again.',
        'Ask again later.',
        'Better not tell you now.',
        'Cannot predict now.',
        'Concentrate and ask again.',
    ],
    negative: [
        "Don't count on it.",
        'My reply is no.',
        'My sources say no.',
        'Outlook not so good.',
        'Very doubtful.',
    ],
};

// The physical toy carries 20 answers — 10 affirmative, 5 non-committal, 5
// negative — each equally likely. Rolling the category first (50/25/25) and
// then a line inside it reproduces that 1-in-20 uniformity exactly, and keeps
// the tone balance fixed if a line is ever added to one of the pools.
function pickResponse(rng = Math.random) {
    const r = rng();
    const type = r < 0.5 ? 'positive' : r < 0.75 ? 'neutral' : 'negative';
    const pool = RESPONSES[type];
    return { type, text: pool[Math.floor(rng() * pool.length)] };
}

const TYPE_CONFIG = {
    positive: { color: '#2ecc71', emoji: '✅', outlook: 'Positive'  },
    neutral:  { color: '#f39c12', emoji: '🤔', outlook: 'Uncertain' },
    negative: { color: '#e74c3c', emoji: '❌', outlook: 'Negative'  },
};

// Questions land inside a single-line block quote. Collapsing whitespace keeps
// a pasted newline from ending the quote early, and the length cap is applied
// here as well as on the option/modal because neither covers the other's path.
function normalizeQuestion(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
}

// Escaped, so a question full of asterisks or backticks can't reformat the embed.
function quoteQuestion(question) {
    return `> *"${escapeMarkdown(question)}"*`;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function baseEmbed(interaction) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setTitle('🎱 Magic 8-Ball');
}

function shakingEmbed(interaction, question, frame) {
    return baseEmbed(interaction)
        .setColor('#5865F2')
        .setDescription(`${SHAKE_FRAMES[frame % SHAKE_FRAMES.length]}\n\n${quoteQuestion(question)}`)
        .setFooter({ text: 'Shaking…' });
}

function resultEmbed(interaction, question, response, shakes) {
    const { color, emoji, outlook } = TYPE_CONFIG[response.type];

    return baseEmbed(interaction)
        .setColor(color)
        .setDescription(quoteQuestion(question))
        .addFields(
            { name: `${emoji} The 8-Ball Says`, value: `**${response.text}**`, inline: false },
            { name: '🔮 Outlook',               value: outlook,               inline: true  },
            { name: '🌀 Shakes',                value: `**${shakes}**`,       inline: true  },
        )
        .setFooter({ text: 'Shake again for a new answer — or ask it something else' })
        .setTimestamp();
}

function buttonRow(ids) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(ids.again)
            .setEmoji('🎱')
            .setLabel('Shake Again')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(ids.newq)
            .setEmoji('❓')
            .setLabel('New Question')
            .setStyle(ButtonStyle.Primary),
    );
}

function questionModal(customId) {
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle('🎱 Ask the Magic 8-Ball')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('question_input')
                    .setLabel('Your yes/no question')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Will I win the lottery?')
                    .setRequired(true)
                    .setMaxLength(MAX_QUESTION),
            ),
        );
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('8ball')
        .setDescription('Ask the magic 8-ball a yes/no question')
        .addStringOption(opt =>
            opt.setName('question')
                .setDescription('Your yes/no question')
                .setRequired(true)
                .setMaxLength(MAX_QUESTION)),

    async execute(interaction) {
        const question = normalizeQuestion(interaction.options.getString('question'));
        if (!question) {
            return interaction.reply({
                content: 'The 8-ball needs an actual question to work with.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply();
        await runSession(interaction, question);
    },

    __test__: { RESPONSES, TYPE_CONFIG, pickResponse, normalizeQuestion, quoteQuestion, MAX_QUESTION },
};

// One message, one session, for as long as the owner keeps shaking. The
// collector boilerplate — owner check, overlap guard, timers, error handling —
// lives in utils/replaySession, shared with /coinflip and /roll.
async function runSession(interaction, firstQuestion) {
    const ids = {
        again: `8ball_again_${interaction.id}`,
        newq:  `8ball_newq_${interaction.id}`,
    };

    let question = firstQuestion;
    let shakes   = 0;
    let modalSeq = 0;
    let session  = null;

    async function shake() {
        shakes += 1;

        // Animation frames are cosmetic, and dropping the buttons for their
        // duration is what stops a click landing mid-shake. A transient failure
        // on one of these edits shouldn't cost the user their answer.
        for (let f = 0; f < SHAKE_FRAMES.length; f++) {
            await interaction.editReply({
                embeds:     [shakingEmbed(interaction, question, f)],
                components: [],
            }).catch(() => {});
            await delay(SHAKE_FRAME_MS);
        }

        return interaction.editReply({
            embeds:     [resultEmbed(interaction, question, pickResponse(), shakes)],
            components: session?.ended ? [] : [buttonRow(ids)],
        });
    }

    const message = await shake();

    session = createReplaySession({
        interaction,
        message,
        customIds: [ids.again, ids.newq],
        label:     '8ball',
        claim:     `That 8-ball is ${interaction.user}'s — run \`/8ball\` to ask your own.`,

        async onCollect(button, ctl) {
            if (button.customId === ids.again) {
                await button.deferUpdate();
                await shake();
                return;
            }

            // New question — collected through a modal. The member has to
            // dismiss the modal before they can reach the buttons again, so
            // hold nothing while it's open.
            const modalId = `8ball_modal_${interaction.id}_${++modalSeq}`;
            await button.showModal(questionModal(modalId));
            ctl.release();

            const submitted = await button.awaitModalSubmit({
                // Matching the custom id matters: a filter on the user alone
                // would swallow a modal they submitted for another command.
                filter: mi => mi.customId === modalId && mi.user.id === interaction.user.id,
                time:   MODAL_WAIT_MS,
            }).catch(() => null);

            if (!submitted) return; // dismissed or timed out — nothing to undo

            const next = normalizeQuestion(submitted.fields.getTextInputValue('question_input'));
            if (!next) {
                return await submitted.reply({
                    content: 'The 8-ball needs an actual question to work with.',
                    flags:   MessageFlags.Ephemeral,
                });
            }

            // A shake may have started while the modal was open.
            if (!ctl.hold()) return await submitted.deferUpdate().catch(() => {});

            await submitted.deferUpdate();
            question = next;
            // Typing into a modal isn't a collected interaction, so the idle
            // timer has been running the whole time.
            ctl.extend();
            await shake();
        },
    });
}
