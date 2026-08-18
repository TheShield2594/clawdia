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
const { BoundedRateLimiter } = require('../../utils/boundedRateLimiter');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3b1.png';

const MAX_QUESTION   = 200;
const SHAKE_FRAME_MS = 260;

// The buttons outlive the command that created them, so shaking is bounded per
// user rather than per message: a year-old 8-ball is still a live button.
const SHAKE_WINDOW_MS = 60_000;
const SHAKE_LIMIT     = 12;
const shakeLimiter    = new BoundedRateLimiter(5_000);

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

// ── Custom IDs ───────────────────────────────────────────────────────────────
//
// These are routed centrally in events/interactionCreate rather than held by a
// collector, so they keep working across restarts and for as long as the
// message exists. That means no closure state: everything a click needs is
// either in the id or readable back off the message.

const AGAIN_PREFIX = '8ball_again_';
const NEWQ_PREFIX  = '8ball_newq_';
const MODAL_PREFIX = '8ball_modal_';
const QUESTION_INPUT = 'question_input';

const isEightBallButton = customId =>
    customId.startsWith(AGAIN_PREFIX) || customId.startsWith(NEWQ_PREFIX);
const isEightBallModal = customId => customId.startsWith(MODAL_PREFIX);

const ownerOf = customId => customId.slice(customId.lastIndexOf('_') + 1);

// ── Question handling ────────────────────────────────────────────────────────

// Questions land inside a single-line block quote. Collapsing whitespace keeps
// a pasted newline from ending the quote early, and the length cap is applied
// here as well as on the option/modal because neither covers the other's path.
function normalizeQuestion(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
}

// Escaped, so a question full of asterisks or backticks can't reformat the
// message. The escaped form is what gets carried forward from one shake to the
// next — re-escaping an already-escaped question would pile up backslashes.
function quoteQuestion(question) {
    return `> *"${escapeMarkdown(question)}"*`;
}

// ── Reading a shake's context back off the message ───────────────────────────

const SHAKES_FIELD = '🌀 Shakes';

function readState(message) {
    const embed = message?.embeds?.[0];
    const shakesRaw = embed?.fields?.find(f => f.name === SHAKES_FIELD)?.value ?? '';
    const shakes = Number.parseInt(shakesRaw.replace(/\D/g, ''), 10);

    return {
        // Already escaped when it was written; reused verbatim.
        quoted: embed?.description ?? '> *"…"*',
        shakes: Number.isFinite(shakes) && shakes > 0 ? shakes : 0,
        // discord.js's Embed exposes iconURL; the raw gateway payload it is built
        // from spells the same field icon_url. Read either.
        author: embed?.author
            ? { name: embed.author.name, iconURL: embed.author.iconURL ?? embed.author.icon_url }
            : null,
    };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function baseEmbed(author) {
    const embed = new EmbedBuilder().setThumbnail(THUMB).setTitle('🎱 Magic 8-Ball');
    return author ? embed.setAuthor(author) : embed;
}

function shakingEmbed(author, quoted, frame) {
    return baseEmbed(author)
        .setColor('#5865F2')
        .setDescription(`${SHAKE_FRAMES[frame % SHAKE_FRAMES.length]}\n\n${quoted}`)
        .setFooter({ text: 'Shaking…' });
}

function resultEmbed(author, quoted, response, shakes) {
    const { color, emoji, outlook } = TYPE_CONFIG[response.type];

    return baseEmbed(author)
        .setColor(color)
        .setDescription(quoted)
        .addFields(
            { name: `${emoji} The 8-Ball Says`, value: `**${response.text}**`, inline: false },
            { name: '🔮 Outlook',               value: outlook,               inline: true  },
            { name: SHAKES_FIELD,               value: `**${shakes}**`,       inline: true  },
        )
        .setFooter({ text: 'Shake again for a new answer — or ask it something else' })
        .setTimestamp();
}

function buttonRow(ownerId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${AGAIN_PREFIX}${ownerId}`)
            .setEmoji('🎱')
            .setLabel('Shake Again')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${NEWQ_PREFIX}${ownerId}`)
            .setEmoji('❓')
            .setLabel('New Question')
            .setStyle(ButtonStyle.Primary),
    );
}

function questionModal(ownerId) {
    return new ModalBuilder()
        .setCustomId(`${MODAL_PREFIX}${ownerId}`)
        .setTitle('🎱 Ask the Magic 8-Ball')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(QUESTION_INPUT)
                    .setLabel('Your yes/no question')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Will I win the lottery?')
                    .setRequired(true)
                    .setMaxLength(MAX_QUESTION),
            ),
        );
}

// Shake, then settle on an answer. `responder` is whichever interaction is
// driving this edit — the slash command, a button, or a modal submission.
async function shake(responder, { author, quoted, shakes, ownerId }) {
    // Animation frames are cosmetic, and dropping the buttons for their
    // duration is what stops a click landing mid-shake. A transient failure on
    // one of these edits shouldn't cost the user their answer.
    for (let f = 0; f < SHAKE_FRAMES.length; f++) {
        await responder.editReply({
            embeds:     [shakingEmbed(author, quoted, f)],
            components: [],
        }).catch(() => {});
        await delay(SHAKE_FRAME_MS);
    }

    return responder.editReply({
        embeds:     [resultEmbed(author, quoted, pickResponse(), shakes)],
        components: [buttonRow(ownerId)],
    });
}

// One shake at a time per message. Two clicks landing together would otherwise
// interleave their animation frames on the same message. In-memory only: losing
// the set on restart just means a stale lock can't outlive the process.
const shaking = new Set();

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleButton(interaction) {
    const ownerId = ownerOf(interaction.customId);

    if (interaction.user.id !== ownerId) {
        return interaction.reply({
            content: `That 8-ball is <@${ownerId}>'s — run \`/8ball\` to ask your own.`,
            flags:   MessageFlags.Ephemeral,
        });
    }

    if (interaction.customId.startsWith(NEWQ_PREFIX)) {
        return interaction.showModal(questionModal(ownerId));
    }

    if (!shakeLimiter.check(interaction.user.id, SHAKE_WINDOW_MS, SHAKE_LIMIT)) {
        return interaction.reply({
            content: 'You are shaking that ball awfully hard. Give it a moment.',
            flags:   MessageFlags.Ephemeral,
        });
    }

    const messageId = interaction.message.id;
    if (shaking.has(messageId)) return interaction.deferUpdate().catch(() => {});
    shaking.add(messageId);

    try {
        await interaction.deferUpdate();
        const state = readState(interaction.message);
        await shake(interaction, {
            author:  state.author,
            quoted:  state.quoted,
            shakes:  state.shakes + 1,
            ownerId,
        });
    } finally {
        shaking.delete(messageId);
    }
}

async function handleModal(interaction) {
    const ownerId = ownerOf(interaction.customId);

    // Only modals opened from an 8-ball message can edit one.
    if (!interaction.isFromMessage() || interaction.user.id !== ownerId) return;

    const question = normalizeQuestion(interaction.fields.getTextInputValue(QUESTION_INPUT));
    if (!question) {
        return interaction.reply({
            content: 'The 8-ball needs an actual question to work with.',
            flags:   MessageFlags.Ephemeral,
        });
    }

    if (!shakeLimiter.check(interaction.user.id, SHAKE_WINDOW_MS, SHAKE_LIMIT)) {
        return interaction.reply({
            content: 'You are shaking that ball awfully hard. Give it a moment.',
            flags:   MessageFlags.Ephemeral,
        });
    }

    const messageId = interaction.message.id;
    if (shaking.has(messageId)) return interaction.deferUpdate().catch(() => {});
    shaking.add(messageId);

    try {
        await interaction.deferUpdate();
        // A new question restarts the count; it's a new thing being asked.
        await shake(interaction, {
            author:  readState(interaction.message).author,
            quoted:  quoteQuestion(question),
            shakes:  1,
            ownerId,
        });
    } finally {
        shaking.delete(messageId);
    }
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
                flags:   MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply();
        await shake(interaction, {
            author:  embedAuthor(interaction),
            quoted:  quoteQuestion(question),
            shakes:  1,
            ownerId: interaction.user.id,
        });
    },

    // Routed from events/interactionCreate — see the custom-id note above.
    isEightBallButton,
    isEightBallModal,
    handleEightBallButton: handleButton,
    handleEightBallModal:  handleModal,

    __test__: {
        RESPONSES, TYPE_CONFIG, MAX_QUESTION, SHAKE_LIMIT, SHAKE_WINDOW_MS,
        pickResponse, normalizeQuestion, quoteQuestion, readState, ownerOf,
        isEightBallButton, isEightBallModal, buttonRow, resultEmbed,
        handleButton, handleModal, shaking, shakeLimiter,
    },
};
