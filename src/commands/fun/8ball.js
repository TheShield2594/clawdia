'use strict';

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    escapeMarkdown,
} = require('discord.js');
const { delay } = require('../../utils/delay');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b1.png';

const MAX_QUESTION   = 200;
const SHAKE_FRAME_MS = 260;

// A session survives repeated shakes, but an interaction token dies 15 minutes
// after the command was invoked — every follow-up here is an editReply on that
// token. Cap the collector below that so the buttons come off while they still
// can, instead of failing on the edit that was meant to clear them.
const SESSION_IDLE_MS = 60_000;
const SESSION_MAX_MS  = 13 * 60_000;
const MODAL_WAIT_MS   = 120_000;

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

// One message, one collector, for as long as the owner keeps shaking. The
// alternative — a fresh max:1 collector per shake — left a window on the
// "New Question" path where the buttons were still on screen with nothing
// listening, so a second click died as "This interaction failed".
async function runSession(interaction, firstQuestion) {
    const ids = {
        again: `8ball_again_${interaction.id}`,
        newq:  `8ball_newq_${interaction.id}`,
    };

    const deadline = Date.now() + SESSION_MAX_MS;
    let question   = firstQuestion;
    let shakes     = 0;
    let modalSeq   = 0;
    let busy       = false;
    let collector  = null;

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
            components: collector?.ended ? [] : [buttonRow(ids)],
        });
    }

    const message = await shake();

    collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i => i.customId === ids.again || i.customId === ids.newq,
        idle:   SESSION_IDLE_MS,
        time:   SESSION_MAX_MS,
    });

    collector.on('collect', async i => {
        try {
            // Rejecting these in the collector filter instead would show every
            // other member a bare "This interaction failed".
            if (i.user.id !== interaction.user.id) {
                return await i.reply({
                    content: `That 8-ball is ${interaction.user}'s — run \`/8ball\` to ask your own.`,
                    flags:   MessageFlags.Ephemeral,
                });
            }

            if (busy) return await i.deferUpdate().catch(() => {});

            if (i.customId === ids.again) {
                busy = true;
                await i.deferUpdate();
                await shake();
                return;
            }

            // New question — collected through a modal. The buttons stay live
            // while it's open, so dismissing the modal doesn't strand the message.
            const modalId = `8ball_modal_${interaction.id}_${++modalSeq}`;
            await i.showModal(questionModal(modalId));

            const submitted = await i.awaitModalSubmit({
                // Matching the custom id matters: a filter on the user alone
                // would swallow a modal this user submitted for another command.
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

            busy = true;
            await submitted.deferUpdate();
            question = next;
            // Typing into a modal isn't a collected interaction, so the idle
            // timer has been running the whole time. Restart it — but against
            // the original deadline, never past the interaction token's life.
            if (!collector.ended) {
                collector.resetTimer({ idle: SESSION_IDLE_MS, time: Math.max(1_000, deadline - Date.now()) });
            }
            await shake();
        } catch (error) {
            // Nothing above is awaited by execute(), so an unhandled rejection
            // here would surface as a process-level warning instead of a log.
            console.error('[8ball] component handler error:', error);
        } finally {
            busy = false;
        }
    });

    collector.on('end', () => {
        // A render in flight sets the final components itself (see shake()).
        if (busy) return;
        interaction.editReply({ components: [] }).catch(() => {});
    });
}
