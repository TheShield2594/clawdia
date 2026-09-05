const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
} = require('discord.js');
const { request, discardBody } = require('../../utils/httpFetch');
const User  = require('../../models/User');
const { advanceMissions } = require('../../services/seasonMissionService');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const FALLBACK_QUESTIONS = require('../../data/quizFallback');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { debitUpTo } = require('../../utils/balanceDebit');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');

const THUMB         = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f393.png';
const TIMER_SECONDS = 30;
const OPENTDB_URL   = 'https://opentdb.com/api.php';

const REWARDS = {
    easy:   { win: 250, lose: 50  },
    medium: { win: 500, lose: 100 },
    hard:   { win: 750, lose: 150 },
};

// Daily attempt caps per difficulty (resets midnight UTC). Easy/medium were
// previously uncapped, making them the highest-EV uncapped coin faucet in the
// bot at a 5-minute cooldown — capping them closes that exploit.
const DAILY_LIMITS = { easy: 40, medium: 30, hard: 20 };
const COUNT_FIELD = { easy: 'dailyQuizEasy', medium: 'dailyQuizMedium', hard: 'dailyQuizHard' };
const RESET_FIELD = { easy: 'dailyQuizEasyReset', medium: 'dailyQuizMediumReset', hard: 'dailyQuizHardReset' };

// The command's `cooldown: 300` is the in-memory pre-check; this is the value
// the database claim enforces, and the two must stay in step.
const QUIZ_COOLDOWN_MS = 300 * 1000;

// Returns midnight UTC for today (used to detect daily reset)
function todayUTC() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function decodeHtml(str) {
    return str
        .replace(/&amp;/g,   '&').replace(/&lt;/g,    '<').replace(/&gt;/g,    '>')
        .replace(/&quot;/g,  '"').replace(/&#039;/g,  "'").replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"').replace(/&lsquo;/g, '‘').replace(/&rsquo;/g, '’')
        .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&deg;/g,   '°')
        .replace(/&hellip;/g,'…');
}

async function fetchQuestion(difficulty) {
    const params = new URLSearchParams({ amount: '1', type: 'multiple' });
    if (difficulty !== 'any') params.set('difficulty', difficulty);
    // Every failure here lands in the same place — the caller falls back to the
    // offline bank — so a refusal is thrown rather than inspected. `fetch` only
    // rejects for a transport failure, so the status is the caller's to check.
    const response = await request(`${OPENTDB_URL}?${params}`, { timeout: 4000 });
    if (!response.ok) {
        await discardBody(response);
        throw new Error(`OpenTDB returned HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data.response_code !== 0 || !data.results?.length)
        throw new Error(`OpenTDB response_code: ${data.response_code}`);
    return { raw: data.results[0], offline: false };
}

function fetchFallbackQuestion(difficulty) {
    const key = difficulty === 'any' ? ['easy', 'medium', 'hard'][Math.floor(Math.random() * 3)] : difficulty;
    const bank = FALLBACK_QUESTIONS[key] ?? FALLBACK_QUESTIONS.medium;
    const raw  = bank[Math.floor(Math.random() * bank.length)];
    return { raw: { ...raw, difficulty: key, category: 'General Knowledge' }, offline: true };
}

function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function truncate(str, max = 100) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

const DIFF_EMOJI = { easy: '🟢', medium: '🟡', hard: '🔴' };
const DIFF_COLOR = { easy: '#2ecc71', medium: '#f1c40f', hard: '#e74c3c' };

function categoryEmoji(cat) {
    if (cat.includes('Science'))    return '🔬';
    if (cat.includes('History'))    return '📜';
    if (cat.includes('Geography'))  return '🌍';
    if (cat.includes('Sports'))     return '⚽';
    if (cat.includes('Music'))      return '🎵';
    if (cat.includes('Film') || cat.includes('Television')) return '🎬';
    if (cat.includes('Art'))        return '🎨';
    if (cat.includes('Mythology'))  return '⚡';
    if (cat.includes('Politics'))   return '🏛️';
    if (cat.includes('Mathematics'))return '🔢';
    if (cat.includes('Computers'))  return '💻';
    if (cat.includes('Animals'))    return '🐾';
    if (cat.includes('Vehicles'))   return '🚗';
    if (cat.includes('Celebrities'))return '⭐';
    if (cat.includes('Anime') || cat.includes('Manga')) return '🎌';
    if (cat.includes('Video Games'))return '🎮';
    if (cat.includes('Board Games'))return '♟️';
    return '🎯';
}

function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

// Visual timer bar: fills from full to empty based on elapsed seconds
function timerBar(elapsedSeconds) {
    const total   = 20;
    const elapsed = Math.min(elapsedSeconds, TIMER_SECONDS);
    const filled  = Math.round(((TIMER_SECONDS - elapsed) / TIMER_SECONDS) * total);
    const empty   = total - filled;
    const bar     = '█'.repeat(filled) + '░'.repeat(empty);
    const left    = TIMER_SECONDS - elapsed;
    return `\`${bar}\` **${left}s**`;
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function questionEmbed(question, category, difficulty, rewards, balance, interaction, elapsed = 0, offline = false) {
    const diffEmoji = DIFF_EMOJI[difficulty] ?? '⚪';
    const catEmoji  = categoryEmoji(category);
    const color     = DIFF_COLOR[difficulty] ?? '#5865F2';
    const footerText = offline
        ? `${TIMER_SECONDS}s to answer — pick from the menu below  •  ⚠️ Using offline question bank`
        : `${TIMER_SECONDS}s to answer — pick from the menu below`;

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle('🎓 Trivia Quiz')
        .setDescription(`**${question}**\n\n⏱️ ${timerBar(elapsed)}`)
        .addFields(
            { name: `${catEmoji} Category`,    value: category,                                   inline: true },
            { name: `${diffEmoji} Difficulty`, value: capitalize(difficulty),                     inline: true },
            { name: '​',                       value: '​',                                         inline: false },
            { name: '✅ Correct',              value: `**+${rewards.win.toLocaleString()}** coins`, inline: true },
            { name: '❌ Wrong / Timeout',      value: `**−${rewards.lose.toLocaleString()}** coins`, inline: true },
            { name: '💰 Balance',              value: `**${balance.toLocaleString()}** coins`,    inline: true },
        )
        .setFooter({ text: footerText });
}

function resultEmbed(interaction, isCorrect, question, correctAnswer, chosenAnswer, difficulty, rewards, netChange, newBalance) {
    const diffEmoji = DIFF_EMOJI[difficulty] ?? '⚪';
    const color     = isCorrect ? '#00cc66' : '#ff3333';
    const title     = isCorrect ? '🎓 ✅ Correct!' : '🎓 ❌ Wrong!';
    const netStr    = netChange >= 0 ? `+${netChange.toLocaleString()}` : netChange.toLocaleString();

    const celebration = isCorrect
        ? (difficulty === 'hard' ? '\n\n🏆 *Hard question — impressive!*' : '\n\n🎉 *Well done!*')
        : '\n\n📖 *Study up for next time!*';

    const fields = [
        { name: '✅ Correct Answer',                value: correctAnswer,               inline: false },
        ...(isCorrect ? [] : [{ name: '❌ Your Answer', value: chosenAnswer,           inline: false }]),
        { name: `${diffEmoji} Difficulty`,           value: capitalize(difficulty),     inline: true  },
        { name: isCorrect ? '🏆 Earned' : '💸 Lost', value: `**${netStr}** coins`,     inline: true  },
        { name: '💰 New Balance',                    value: `**${newBalance.toLocaleString()}** coins`, inline: true },
    ];

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(color)
        .setTitle(title)
        .setDescription(`**${question}**${celebration}`)
        .addFields(fields)
        .setTimestamp();
}

function timeoutEmbed(interaction, question, correctAnswer, difficulty, penalty, newBalance) {
    const diffEmoji = DIFF_EMOJI[difficulty] ?? '⚪';
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(COLORS.WARN)
        .setTitle('🎓 ⏱️ Time\'s Up!')
        .setDescription(`**${question}**\n\n*You ran out of time!*`)
        .addFields(
            { name: '✅ Correct Answer',        value: correctAnswer,                                                                     inline: false },
            { name: `${diffEmoji} Difficulty`,  value: capitalize(difficulty),                                                            inline: true  },
            { name: '💸 Penalty',               value: penalty ? `**−${penalty.toLocaleString()}** coins` : '**0** coins',               inline: true  },
            { name: '💰 New Balance',           value: `**${newBalance.toLocaleString()}** coins`,                                        inline: true  },
        )
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('quiz')
        .setDescription('Answer a trivia question to win coins — or lose some if you\'re wrong!')
        .addStringOption(opt =>
            opt.setName('difficulty')
                .setDescription('Question difficulty (default: random)')
                .setRequired(false)
                .addChoices(
                    { name: '🟢 Easy   — Win 250, Lose 50 (cap 40/day)',  value: 'easy'   },
                    { name: '🟡 Medium — Win 500, Lose 100 (cap 30/day)', value: 'medium' },
                    { name: '🔴 Hard   — Win 750, Lose 150 (cap 20/day)', value: 'hard'   },
                    { name: '⚪ Random (any difficulty)',            value: 'any'    },
                )),
    cooldown: 300,

    async execute(interaction) {
        const MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000;
        if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: '❌ Your Discord account must be at least 7 days old to play the quiz.',
                flags: MessageFlags.Ephemeral,
            });
        }
        const guildSettings = await getGuildSettings(interaction.guild.id);
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.quizEnabled === false) {
            return interaction.reply({ content: 'The quiz command is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        const diffChoice = interaction.options.getString('difficulty') ?? 'any';
        await interaction.deferReply();
        await runQuiz(interaction, diffChoice, guildSettings);
    },
};

async function runQuiz(interaction, diffChoice, guildSettings = null) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

    await User.findOneAndUpdate(userFilter, { $setOnInsert: userFilter }, { upsert: true, new: true });

    // Claim the cooldown window in the database, not just in the interaction
    // handler's in-memory map. That map is a per-process pre-check: it is empty
    // after a restart and unshared between instances, and /quiz pays coins, so
    // on its own it let a player burn a whole day's question allowance at once.
    // The daily per-difficulty caps below still bound the total; this bounds the
    // rate. Same shape as the claims in /work, /daily and /snowball.
    const claimNow      = new Date();
    const cooldownFloor = new Date(claimNow.getTime() - QUIZ_COOLDOWN_MS);
    const user = await User.findOneAndUpdate(
        {
            ...userFilter,
            $or: [{ lastQuiz: null }, { lastQuiz: { $exists: false } }, { lastQuiz: { $lte: cooldownFloor } }],
        },
        { $set: { lastQuiz: claimNow } },
        { new: true },
    );

    if (!user) {
        // The window is still open. Read the winning timestamp back so the
        // countdown reflects the attempt that actually took the slot.
        const current = await User.findOne(userFilter).select('lastQuiz').lean().catch(() => null);
        const nextAt  = new Date(new Date(current?.lastQuiz ?? claimNow).getTime() + QUIZ_COOLDOWN_MS);
        return interaction.editReply({
            embeds: [buildCooldownEmbed({
                title: '🎓 Still Thinking It Over',
                description: 'Give the quizmaster a moment to dig out another question.',
                color: '#9b59b6',
                nextAt,
            })],
        });
    }

    return runQuizWithUser(interaction, diffChoice, user, guildSettings);
}

async function runQuizWithUser(interaction, diffChoice, user, guildSettings = null) {
    const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

    let raw, offline;
    try {
        ({ raw, offline } = await fetchQuestion(diffChoice));
    } catch (err) {
        console.error('[Quiz] fetch error — using fallback:', err.message);
        ({ raw, offline } = fetchFallbackQuestion(diffChoice));
    }

    const difficulty    = raw.difficulty;

    // Enforce daily per-difficulty attempt cap (resets at midnight UTC). The slot is
    // claimed atomically up front (reset-if-stale, then increment-if-under-limit in a
    // single findOneAndUpdate) so two concurrent /quiz calls can't both pass a stale
    // in-memory count before either write commits.
    {
        const countField = COUNT_FIELD[difficulty];
        const resetField = RESET_FIELD[difficulty];
        const limit       = DAILY_LIMITS[difficulty] ?? DAILY_LIMITS.medium;
        const today       = todayUTC();
        const needsReset  = !user[resetField] || user[resetField] < today;
        if (needsReset) {
            await User.updateOne(userFilter, { $set: { [countField]: 0, [resetField]: today } });
            user[countField] = 0;
        }

        const claimedSlot = await User.findOneAndUpdate(
            { ...userFilter, [countField]: { $lt: limit } },
            { $inc: { [countField]: 1 } },
            { new: true },
        );
        if (!claimedSlot) {
            const tomorrow = new Date(todayUTC().getTime() + 86_400_000);
            return interaction.editReply({
                embeds: [buildCooldownEmbed({
                    title: `🎓 ${capitalize(difficulty)} Cap Reached`,
                    description: `You've answered all **${limit}** ${difficulty} questions allowed today.\nYour brain deserves the rest.`,
                    color: '#9b59b6',
                    nextAt: tomorrow,
                    nextRewardPreview: `Tomorrow: ${limit} more ${capitalize(difficulty)} questions · ${REWARDS[difficulty]?.win ?? REWARDS.medium.win} coins each for correct answers`,
                })],
                components: [],
            });
        }
        user[countField] = claimedSlot[countField];
    }
    const rewards       = REWARDS[difficulty] ?? REWARDS.medium;
    const category      = decodeHtml(raw.category);
    const question      = decodeHtml(raw.question);
    const correctAnswer = decodeHtml(raw.correct_answer);
    const allAnswers    = shuffleArray([correctAnswer, ...raw.incorrect_answers.map(decodeHtml)]);
    const menuId        = `quiz_${interaction.id}_${Date.now()}`;

    const select = new StringSelectMenuBuilder()
        .setCustomId(menuId)
        .setPlaceholder('Choose your answer…')
        .addOptions(allAnswers.map((ans, idx) =>
            new StringSelectMenuOptionBuilder().setLabel(truncate(ans)).setValue(`a${idx}`),
        ));

    const menuRow = new ActionRowBuilder().addComponents(select);

    const startTime = Date.now();
    await interaction.editReply({
        embeds:     [questionEmbed(question, category, difficulty, rewards, user.balance, interaction, 0, offline)],
        components: [menuRow],
    });

    const timerInterval = setInterval(async () => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed >= TIMER_SECONDS) { clearInterval(timerInterval); return; }
        await interaction.editReply({
            embeds:     [questionEmbed(question, category, difficulty, rewards, user.balance, interaction, elapsed, offline)],
            components: [menuRow],
        }).catch(() => clearInterval(timerInterval));
    }, 8_000);

    const message   = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, i => i.customId === menuId, "This isn't your quiz."),
        max:    1,
        time:   TIMER_SECONDS * 1000,
    });

    collector.on('collect', async i => {
        clearInterval(timerInterval);
        const selectedIndex = parseInt(i.values[0].slice(1), 10);
        const chosenAnswer  = allAnswers[selectedIndex];
        const isCorrect     = chosenAnswer === correctAnswer;
        let netChange, updated;

        if (isCorrect) {
            netChange = rewards.win;
            updated   = await User.findOneAndUpdate(userFilter, { $inc: { balance: rewards.win } }, { new: true });
        } else {
            // Clamped inside the update rather than against a separate read: a
            // read-then-clamp-then-$inc takes the amount the read justified even
            // if the wallet emptied in between, which walks the balance negative.
            const { taken, balance } = await debitUpTo(User, userFilter, rewards.lose);
            netChange = -taken;
            updated   = { balance };
        }

        // Season pass: "Answer a quiz question" counts the answer, not the score.
        advanceMissions(User, userFilter, 'quiz', 1, guildSettings)
            .catch(err => console.error('[quiz] season mission error:', err));

        // No replay button: quiz is a net-positive income command, so a replay
        // chain would bypass the command cooldown and become an unbounded faucet.
        await i.update({
            embeds:     [resultEmbed(interaction, isCorrect, question, correctAnswer, chosenAnswer, difficulty, rewards, netChange, updated?.balance ?? 0)],
            components: [],
        });
    });

    collector.on('end', async (collected, reason) => {
        clearInterval(timerInterval);
        if (reason === 'limit') return;

        // Same clamp-in-the-update as the wrong-answer branch. This one runs
        // after the whole question window, so the read it replaced was stale by
        // however long the player sat on the prompt.
        const { taken: penalty, balance } = await debitUpTo(User, userFilter, rewards.lose);
        const updated = { balance };

        await interaction.editReply({
            embeds:     [timeoutEmbed(interaction, question, correctAnswer, difficulty, penalty, updated?.balance ?? 0)],
            components: [],
        }).catch(() => {});
    });
}
