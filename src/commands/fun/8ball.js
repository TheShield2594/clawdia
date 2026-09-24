'use strict';

const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    TextDisplayBuilder,
    ComponentType,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    AttachmentBuilder,
    escapeMarkdown,
} = require('discord.js');
const { delay } = require('../../utils/delay');
const { renderEightBall, renderShakeClip } = require('../../utils/eightBallImage');
const { BoundedRateLimiter } = require('../../utils/boundedRateLimiter');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { getPolicyDecision } = require('../../utils/commandPolicy');

const BALL_FILE  = '8ball.png';
const SHAKE_FILE = '8ball-shaking.gif';

const MAX_QUESTION = 200;

// How long the shake plays before the answer surfaces. Long enough for the clip
// to load and loop a little, short enough that nobody waits on a toy.
const SHAKE_MS = 1_400;

// The buttons outlive the command that created them, so shaking is bounded per
// user rather than per message: a year-old 8-ball is still a live button. The
// slash command spends from the same budget, so re-running /8ball is not a way
// round it.
const SHAKE_WINDOW_MS = 60_000;
const SHAKE_LIMIT     = 12;
const shakeLimiter    = new BoundedRateLimiter(5_000);

// ── Copy ─────────────────────────────────────────────────────────────────────
//
// Everything a player reads, per language. The language is the asker's own
// Discord client language (`interaction.locale`), matching the Spanish command
// name in src/locales/es-ES.json. The answer tables line up index for index, so
// a roll picks the same answer in every language.

const STRINGS = {
    en: {
        heading:     '### 🎱 Magic 8-Ball',
        surfacing:   '## *The answer is surfacing…*',
        clouded:     '## 🌫️ The ball clouded over.',
        cloudedHint: 'Couldn\'t make out an answer. Give it another shake.',
        askedBy:     id => `Asked by <@${id}>`,
        shakes:      n => (n >= 10 ? `shaken ×${n}, the ball needs a lie down`
            : n >= 5 ? `shaken ×${n}, the ball is getting impatient`
                : `shaken ×${n}`),
        shakeAgain:  'Shake Again',
        shaking:     'Shaking…',
        newQuestion: 'New Question',
        askOwn:      'Ask Your Own',
        modalTitle:  '🎱 Ask the Magic 8-Ball',
        inputLabel:  'Your yes/no question',
        placeholder: 'Will I win the lottery?',
        noQuestion:  'The ball stares back at you. Ask it something.',
        tooHard:     'The liquid needs to settle. Try again in a bit.',
        settling:    'The ball is still settling. Give it a second, then ask again.',
        notYours:    id => `This ball answers to <@${id}>. Press **Ask Your Own** to get one of your own.`,
        settingsDown: 'Could not load server settings. Try again in a moment.',
        ballAlt:     text => `A magic 8-ball, its window reading "${text}"`,
        shakingAlt:  'A magic 8-ball being shaken, its answer hidden in the churning liquid',
        answers: {
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
        },
    },
    es: {
        heading:     '### 🎱 Bola mágica 8',
        surfacing:   '## *La respuesta está saliendo…*',
        clouded:     '## 🌫️ La bola se ha enturbiado.',
        cloudedHint: 'No se distingue la respuesta. Agítala otra vez.',
        askedBy:     id => `Pregunta de <@${id}>`,
        shakes:      n => (n >= 10 ? `agitada ×${n}, la bola necesita descansar`
            : n >= 5 ? `agitada ×${n}, la bola se está impacientando`
                : `agitada ×${n}`),
        shakeAgain:  'Agitar otra vez',
        shaking:     'Agitando…',
        newQuestion: 'Nueva pregunta',
        askOwn:      'Pregunta tú',
        modalTitle:  '🎱 Pregunta a la bola mágica 8',
        inputLabel:  'Tu pregunta de sí o no',
        placeholder: '¿Me tocará la lotería?',
        noQuestion:  'La bola te mira fijamente. Pregúntale algo.',
        tooHard:     'El líquido necesita asentarse. Inténtalo en un rato.',
        settling:    'La bola aún se está asentando. Espera un segundo y vuelve a preguntar.',
        notYours:    id => `Esta bola responde a <@${id}>. Pulsa **Pregunta tú** para tener la tuya.`,
        settingsDown: 'No se pudo cargar la configuración del servidor. Inténtalo en un momento.',
        ballAlt:     text => `Una bola mágica 8, en su ventana se lee "${text}"`,
        shakingAlt:  'Una bola mágica 8 agitándose, con la respuesta oculta en el líquido',
        answers: {
            positive: [
                'Es cierto.',
                'Decididamente así es.',
                'Sin duda.',
                'Sí, definitivamente.',
                'Puedes confiar en ello.',
                'Como yo lo veo, sí.',
                'Lo más probable.',
                'Buen pronóstico.',
                'Sí.',
                'Las señales dicen que sí.',
            ],
            neutral: [
                'Respuesta confusa, prueba otra vez.',
                'Pregunta más tarde.',
                'Mejor no te lo digo ahora.',
                'No puedo predecirlo ahora.',
                'Concéntrate y vuelve a preguntar.',
            ],
            negative: [
                'No cuentes con ello.',
                'Mi respuesta es no.',
                'Mis fuentes dicen que no.',
                'El pronóstico no es bueno.',
                'Muy dudoso.',
            ],
        },
    },
};

// Discord reports Spanish as es-ES or es-419; everything else reads English.
function langOf(interaction) {
    return String(interaction?.locale ?? '').startsWith('es') ? 'es' : 'en';
}

const RESPONSES = STRINGS.en.answers;

// The physical toy carries 20 answers — 10 affirmative, 5 non-committal, 5
// negative — each equally likely. Rolling the category first (50/25/25) and
// then a line inside it reproduces that 1-in-20 uniformity exactly, and keeps
// the tone balance fixed if a line is ever added to one of the pools.
function pickResponse(rng = Math.random, lang = 'en') {
    const r = rng();
    const type = r < 0.5 ? 'positive' : r < 0.75 ? 'neutral' : 'negative';
    const pool = STRINGS[lang].answers[type];
    const index = Math.floor(rng() * pool.length);
    return { type, index, text: pool[index] };
}

// The accent stripe is where the outlook shows. The die itself stays the toy's
// blue, so the words are the reveal (see utils/eightBallImage).
const TYPE_CONFIG = {
    positive: { color: '#43b581' },
    neutral:  { color: '#faa61a' },
    negative: { color: '#f04747' },
};
const SHAKING_COLOR = '#5865f2';
const CLOUDED_COLOR = '#4f545c';

// ── Custom IDs ───────────────────────────────────────────────────────────────
//
// These are routed centrally in events/interactionCreate rather than held by a
// collector, so they keep working across restarts and for as long as the
// message exists. That means no closure state: everything a click needs is
// either in the id or readable back off the message.

const AGAIN_PREFIX = '8ball_again_';
const NEWQ_PREFIX  = '8ball_newq_';
const MODAL_PREFIX = '8ball_modal_';
// "Ask Your Own" belongs to nobody — anyone may press it — so its button and
// the modal it opens carry no owner.
const OWN_BUTTON = '8ball_own';
const OWN_MODAL  = '8ball_ownq';
const QUESTION_INPUT = 'question_input';

const isEightBallButton = customId =>
    customId === OWN_BUTTON || customId.startsWith(AGAIN_PREFIX) || customId.startsWith(NEWQ_PREFIX);
const isEightBallModal = customId => customId === OWN_MODAL || customId.startsWith(MODAL_PREFIX);

const ownerOf = customId => customId.slice(customId.lastIndexOf('_') + 1);

// ── Question handling ────────────────────────────────────────────────────────

// Questions land inside a single-line block quote. Collapsing whitespace keeps
// a pasted newline from ending the quote early, and the length cap is applied
// here as well as on the option/modal because neither covers the other's path.
function normalizeQuestion(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
}

// Escaped, so a question full of asterisks or backticks can't reformat the
// message. Masked links are escaped too — they are off by default in
// escapeMarkdown, and a `[harmless text](https://elsewhere)` link inside a
// message the bot posted would lend that link the bot's credibility. The escaped
// form is what gets carried forward from one shake to the next — re-escaping an
// already-escaped question would pile up backslashes.
function quoteQuestion(question) {
    return `> *"${escapeMarkdown(question, { maskedLink: true })}"*`;
}

// ── Reading a shake's context back off the message ───────────────────────────
//
// A Components V2 message has no embed to read state out of, so the question
// and the shake count are recovered from the text the last render wrote. The
// owner never needs recovering — it rides in the button's custom id.

// Anchored to the meta line's own prefix rather than matching anywhere: the
// question is rendered as a block quote on a single line, so it can never start
// with "-#", and therefore can't spoof the counter by containing the same
// characters. `×n` is the current form, written in every language; `Shake #n`
// is what messages from before it carry.
const META_LINE   = /^-# 🔮 /m;
const SHAKE_COUNT = /^-# .*?(?:×|\bShake #)(\d+)/m;
const QUOTED_LINE = /^> .*$/m;

// Text displays can be nested inside sections inside containers; walk the lot.
function textContents(message) {
    const found = [];

    const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (node.type === ComponentType.TextDisplay && typeof node.content === 'string') {
            found.push(node.content);
        }
        walk(node.components);
        walk(node.accessory);
    };

    const top = message?.components ?? [];
    walk(top.map(c => (typeof c?.toJSON === 'function' ? c.toJSON() : c)));
    return found;
}

function readState(message) {
    const text = textContents(message).join('\n');
    const counted = Number.parseInt(text.match(SHAKE_COUNT)?.[1] ?? '', 10);
    // The first answer on a ball carries no count at all — "shaken ×1" is noise —
    // so a meta line with no number on it is one shake.
    const shakes = Number.isFinite(counted) && counted > 0 ? counted : META_LINE.test(text) ? 1 : 0;

    return {
        // Already escaped when it was written; reused verbatim, because
        // re-escaping on each shake would pile up backslashes.
        quoted: text.match(QUOTED_LINE)?.[0] ?? '> *"…"*',
        shakes,
    };
}

// ── Rendering ────────────────────────────────────────────────────────────────
//
// The shaking view and the answer share one layout — heading and question, the
// ball, a headline, a meta line, the buttons — so the message never changes
// height between them. The clip is swapped for the still, the headline for the
// answer, and that is all that moves.

const V2_FLAGS = MessageFlags.IsComponentsV2;

// The asker is named with a mention so it renders as a pill, but a shake is not
// a reason to ping someone — least of all on a message that stays clickable
// indefinitely.
const NO_PINGS = { parse: [] };

const accent = hex => Number.parseInt(hex.slice(1), 16);

function metaLine(strings, ownerId, shakes) {
    const parts = [strings.askedBy(ownerId)];
    if (shakes > 1) parts.push(strings.shakes(shakes));
    return `-# 🔮 ${parts.join(' · ')}`;
}

function ballView({ color, header, file, alt, headline, meta, buttons }) {
    return new ContainerBuilder()
        .setAccentColor(accent(color))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`attachment://${file}`).setDescription(alt),
            ),
        )
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${headline}\n${meta}`))
        .addActionRowComponents(buttons);
}

function shakingView(quoted, shakes, ownerId, lang = 'en') {
    const strings = STRINGS[lang];
    return ballView({
        color:    SHAKING_COLOR,
        header:   `${strings.heading}\n${quoted}`,
        file:     SHAKE_FILE,
        alt:      strings.shakingAlt,
        headline: strings.surfacing,
        meta:     metaLine(strings, ownerId, shakes),
        buttons:  buttonRow(ownerId, { lang, shaking: true }),
    });
}

function resultView(quoted, response, shakes, ownerId, lang = 'en') {
    const strings = STRINGS[lang];
    return ballView({
        color:    TYPE_CONFIG[response.type].color,
        header:   `${strings.heading}\n${quoted}`,
        file:     BALL_FILE,
        alt:      strings.ballAlt(response.text),
        headline: `## ${response.text}`,
        meta:     metaLine(strings, ownerId, shakes),
        buttons:  buttonRow(ownerId, { lang, hazy: response.type === 'neutral' }),
    });
}

// What a shake leaves behind when it could not finish: no picture to show, but
// the buttons are back, so the ball can always be shaken again.
function cloudedView(quoted, shakes, ownerId, lang = 'en') {
    const strings = STRINGS[lang];
    return new ContainerBuilder()
        .setAccentColor(accent(CLOUDED_COLOR))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `${strings.heading}\n${quoted}\n${strings.clouded}\n-# ${strings.cloudedHint}\n${metaLine(strings, ownerId, shakes)}`,
            ),
        )
        .addActionRowComponents(buttonRow(ownerId, { lang }));
}

// Shake Again is greyed out while a shake plays — the lock would swallow the
// press anyway, and a disabled button says so. New Question stays live: it is
// the way back into a message a restart left mid-shake. After a non-committal
// answer ("Reply hazy, try again."), shaking again is the obvious next move, so
// it takes the highlight.
function buttonRow(ownerId, { lang = 'en', shaking = false, hazy = false } = {}) {
    const strings = STRINGS[lang];
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${AGAIN_PREFIX}${ownerId}`)
            .setEmoji('🎱')
            .setLabel(shaking ? strings.shaking : strings.shakeAgain)
            .setStyle(hazy ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(shaking),
        new ButtonBuilder()
            .setCustomId(`${NEWQ_PREFIX}${ownerId}`)
            .setEmoji('❓')
            .setLabel(strings.newQuestion)
            .setStyle(hazy ? ButtonStyle.Secondary : ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(OWN_BUTTON)
            .setEmoji('🔮')
            .setLabel(strings.askOwn)
            .setStyle(ButtonStyle.Secondary),
    );
}

function questionModal(customId, lang = 'en') {
    const strings = STRINGS[lang];
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(strings.modalTitle)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(QUESTION_INPUT)
                    .setLabel(strings.inputLabel)
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder(strings.placeholder)
                    .setRequired(true)
                    .setMaxLength(MAX_QUESTION),
            ),
        );
}

function shakingPayload(ctx) {
    return {
        components:      [shakingView(ctx.quoted, ctx.shakes, ctx.ownerId, ctx.lang)],
        flags:           V2_FLAGS,
        files:           [new AttachmentBuilder(renderShakeClip(), {
            name:        SHAKE_FILE,
            description: STRINGS[ctx.lang].shakingAlt,
        })],
        // Drops the previous answer's still; without it Discord keeps both and
        // the message grows an image per click.
        attachments:     [],
        allowedMentions: NO_PINGS,
    };
}

// Let the shake play, then surface the answer. `responder` is whichever
// interaction is driving this edit — the slash command, a button, or a modal
// submission — and the shaking view is already on the message.
//
// If the answer cannot be drawn or delivered, the message is put back into a
// state with live buttons before the error goes on to the router's log. The
// alternative is a ball frozen mid-shake with Shake Again greyed out.
async function settle(responder, ctx) {
    await delay(SHAKE_MS);

    try {
        const response = pickResponse(Math.random, ctx.lang);
        const ball = new AttachmentBuilder(renderEightBall(response.text, response.type), {
            name: BALL_FILE,
            description: STRINGS[ctx.lang].ballAlt(response.text),
        });

        return await responder.editReply({
            components:      [resultView(ctx.quoted, response, ctx.shakes, ctx.ownerId, ctx.lang)],
            flags:           V2_FLAGS,
            files:           [ball],
            attachments:     [],
            allowedMentions: NO_PINGS,
        });
    } catch (err) {
        await responder.editReply({
            components:      [cloudedView(ctx.quoted, ctx.shakes, ctx.ownerId, ctx.lang)],
            flags:           V2_FLAGS,
            files:           [],
            attachments:     [],
            allowedMentions: NO_PINGS,
        }).catch(() => {});
        throw err;
    }
}

// One shake at a time per message. Two clicks landing together would otherwise
// interleave their edits on the same message. In-memory only: losing the set on
// restart just means a stale lock can't outlive the process.
const shaking = new Set();

async function withLock(messageId, run) {
    shaking.add(messageId);
    try {
        return await run();
    } finally {
        shaking.delete(messageId);
    }
}

// ── Gates ────────────────────────────────────────────────────────────────────

// The buttons and modals are routed around the command dispatcher, so the
// server's command policy is applied here too — otherwise a ball posted before
// an admin blocked /8ball in a channel would keep answering there, and Ask Your
// Own would be a fresh /8ball in all but name. Returns a refusal, or null.
async function policyRefusal(interaction, strings) {
    if (!interaction.guild) return null;
    let guildSettings;
    try {
        guildSettings = await getGuildSettings(interaction.guild.id);
    } catch {
        return strings.settingsDown;
    }
    const policy = getPolicyDecision(interaction, guildSettings, '8ball');
    return policy.allowed ? null : policy.reason;
}

const refuse = (interaction, content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });

const overLimit = userId => !shakeLimiter.check(userId, SHAKE_WINDOW_MS, SHAKE_LIMIT);

// A brand-new ball: the slash command, or a bystander's Ask Your Own. Posts the
// shaking view as the interaction's reply, then settles it.
async function askFresh(interaction, question, lang) {
    const quoted = quoteQuestion(question);
    const ctx = { quoted, shakes: 1, ownerId: interaction.user.id, lang };

    const response = await interaction.reply({ ...shakingPayload(ctx), withResponse: true });
    const messageId = response?.resource?.message?.id;
    if (!messageId) return settle(interaction, ctx);
    return withLock(messageId, () => settle(interaction, ctx));
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleButton(interaction) {
    const lang = langOf(interaction);
    const strings = STRINGS[lang];
    const { customId } = interaction;

    if (customId === OWN_BUTTON) {
        const refusal = await policyRefusal(interaction, strings);
        if (refusal) return refuse(interaction, refusal);
        return interaction.showModal(questionModal(OWN_MODAL, lang));
    }

    const ownerId = ownerOf(customId);
    if (interaction.user.id !== ownerId) return refuse(interaction, strings.notYours(ownerId));

    const refusal = await policyRefusal(interaction, strings);
    if (refusal) return refuse(interaction, refusal);

    if (customId.startsWith(NEWQ_PREFIX)) {
        return interaction.showModal(questionModal(`${MODAL_PREFIX}${ownerId}`, lang));
    }

    // Checked ahead of the rate limit, so a double-click that the lock drops
    // doesn't also spend a shake from the budget.
    const messageId = interaction.message.id;
    if (shaking.has(messageId)) return interaction.deferUpdate().catch(() => {});
    if (overLimit(interaction.user.id)) return refuse(interaction, strings.tooHard);

    return withLock(messageId, async () => {
        await interaction.deferUpdate();
        const state = readState(interaction.message);
        const ctx = { quoted: state.quoted, shakes: state.shakes + 1, ownerId, lang };
        // The shaking view is cosmetic: if it fails to land, the answer still can.
        await interaction.editReply(shakingPayload(ctx)).catch(() => {});
        await settle(interaction, ctx);
    });
}

async function handleModal(interaction) {
    const lang = langOf(interaction);
    const strings = STRINGS[lang];
    const isOwn = interaction.customId === OWN_MODAL;
    const ownerId = isOwn ? interaction.user.id : ownerOf(interaction.customId);

    // A New Question modal can only re-ask on the 8-ball message it was opened
    // from, and only for that ball's owner.
    if (!isOwn && (!interaction.isFromMessage() || interaction.user.id !== ownerId)) {
        return refuse(interaction, strings.notYours(ownerId));
    }

    const question = normalizeQuestion(interaction.fields.getTextInputValue(QUESTION_INPUT));
    if (!question) return refuse(interaction, strings.noQuestion);

    const refusal = await policyRefusal(interaction, strings);
    if (refusal) return refuse(interaction, refusal);

    if (isOwn) {
        if (overLimit(interaction.user.id)) return refuse(interaction, strings.tooHard);
        return askFresh(interaction, question, lang);
    }

    // Refused out loud rather than dropped: the player typed this question.
    const messageId = interaction.message.id;
    if (shaking.has(messageId)) return refuse(interaction, strings.settling);
    if (overLimit(interaction.user.id)) return refuse(interaction, strings.tooHard);

    return withLock(messageId, async () => {
        await interaction.deferUpdate();
        // A new question restarts the count; it's a new thing being asked.
        const ctx = { quoted: quoteQuestion(question), shakes: 1, ownerId, lang };
        await interaction.editReply(shakingPayload(ctx)).catch(() => {});
        await settle(interaction, ctx);
    });
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
        const lang = langOf(interaction);
        const strings = STRINGS[lang];

        const question = normalizeQuestion(interaction.options.getString('question'));
        if (!question) return refuse(interaction, strings.noQuestion);
        if (overLimit(interaction.user.id)) return refuse(interaction, strings.tooHard);

        // Replying straight into a Components V2 message rather than deferring:
        // the flag belongs to the message from the moment it exists.
        return askFresh(interaction, question, lang);
    },

    // Routed from events/interactionCreate — see the custom-id note above.
    isEightBallButton,
    isEightBallModal,
    handleEightBallButton: handleButton,
    handleEightBallModal:  handleModal,

    __test__: {
        STRINGS, RESPONSES, TYPE_CONFIG, MAX_QUESTION, SHAKE_LIMIT, SHAKE_WINDOW_MS, SHAKE_MS,
        pickResponse, normalizeQuestion, quoteQuestion, readState, ownerOf, langOf,
        BALL_FILE, SHAKE_FILE, OWN_BUTTON, OWN_MODAL,
        isEightBallButton, isEightBallModal, buttonRow, resultView, shakingView, cloudedView,
        textContents, handleButton, handleModal, shaking, shakeLimiter,
    },
};
