const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require('discord.js');
const axios = require('axios');
const User = require('../../models/User');

// Difficulty-scaled rewards: correct = big win, wrong/timeout = small fee
const REWARDS = {
    easy:   { win: 250,  lose: 50  },
    medium: { win: 500,  lose: 100 },
    hard:   { win: 1000, lose: 150 },
};

const TIMER_SECONDS = 30;
const OPENTDB_URL   = 'https://opentdb.com/api.php';

// OpenTDB returns HTML-encoded text; decode the common entities
function decodeHtml(str) {
    return str
        .replace(/&amp;/g,   '&')
        .replace(/&lt;/g,    '<')
        .replace(/&gt;/g,    '>')
        .replace(/&quot;/g,  '"')
        .replace(/&#039;/g,  "'")
        .replace(/&ldquo;/g, '“')
        .replace(/&rdquo;/g, '”')
        .replace(/&lsquo;/g, '‘')
        .replace(/&rsquo;/g, '’')
        .replace(/&ndash;/g, '–')
        .replace(/&mdash;/g, '—')
        .replace(/&deg;/g,   '°')
        .replace(/&hellip;/g,'…');
}

async function fetchQuestion(difficulty) {
    const params = { amount: 1, type: 'multiple' };
    if (difficulty !== 'any') params.difficulty = difficulty;

    const { data } = await axios.get(OPENTDB_URL, { params, timeout: 8000 });

    if (data.response_code !== 0 || !data.results?.length) {
        throw new Error(`OpenTDB response_code: ${data.response_code}`);
    }
    return data.results[0];
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

function categoryEmoji(category) {
    if (category.includes('Science'))                        return '🔬';
    if (category.includes('History'))                        return '📜';
    if (category.includes('Geography'))                      return '🌍';
    if (category.includes('Sports'))                         return '⚽';
    if (category.includes('Music'))                          return '🎵';
    if (category.includes('Film') || category.includes('Television')) return '🎬';
    if (category.includes('Art'))                            return '🎨';
    if (category.includes('Mythology'))                      return '⚡';
    if (category.includes('Politics'))                       return '🏛️';
    if (category.includes('Mathematics'))                    return '🔢';
    if (category.includes('Computers'))                      return '💻';
    if (category.includes('Animals'))                        return '🐾';
    if (category.includes('Vehicles'))                       return '🚗';
    if (category.includes('Celebrities'))                    return '⭐';
    if (category.includes('Anime') || category.includes('Manga')) return '🎌';
    if (category.includes('Video Games'))                    return '🎮';
    if (category.includes('Board Games'))                    return '♟️';
    return '🎯';
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Embeds ────────────────────────────────────────────────────────────────

function questionEmbed(question, category, difficulty, rewards, balance, username) {
    const diffEmoji  = DIFF_EMOJI[difficulty] ?? '⚪';
    const catEmoji   = categoryEmoji(category);

    return new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎓 Trivia Quiz')
        .setDescription(`**${question}**`)
        .addFields(
            { name: `${catEmoji} Category`,    value: category,                                           inline: true  },
            { name: `${diffEmoji} Difficulty`, value: capitalize(difficulty),                             inline: true  },
            { name: '⏱️ Time Limit',           value: `${TIMER_SECONDS} seconds`,                        inline: true  },
            { name: '✅ Correct',              value: `+${rewards.win.toLocaleString()} coins`,          inline: true  },
            { name: '❌ Wrong / Timeout',      value: `-${rewards.lose.toLocaleString()} coins`,         inline: true  },
            { name: '💰 Your Balance',         value: `${balance.toLocaleString()} coins`,               inline: true  },
        )
        .setFooter({ text: `${username} • ${TIMER_SECONDS}s to answer — pick from the menu below` });
}

function resultEmbed(isCorrect, question, correctAnswer, chosenAnswer, difficulty, rewards, netChange, newBalance, username) {
    const diffEmoji = DIFF_EMOJI[difficulty] ?? '⚪';
    const color     = isCorrect ? '#00cc66' : '#ff3333';
    const title     = isCorrect ? '🎓 ✅ Correct!' : '🎓 ❌ Wrong!';
    const netStr    = netChange >= 0 ? `+${netChange.toLocaleString()}` : netChange.toLocaleString();

    const fields = [
        { name: '✅ Correct Answer',               value: correctAnswer,                     inline: false },
        { name: `${diffEmoji} Difficulty`,          value: capitalize(difficulty),            inline: true  },
        { name: isCorrect ? '🏆 Earned' : '💸 Lost', value: `${netStr} coins`,               inline: true  },
        { name: '💰 New Balance',                   value: `${newBalance.toLocaleString()} coins`, inline: true },
    ];

    if (!isCorrect) {
        fields.splice(1, 0, { name: '❌ Your Answer', value: chosenAnswer, inline: false });
    }

    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(`**${question}**`)
        .addFields(fields)
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
}

function timeoutEmbed(question, correctAnswer, difficulty, penaltyApplied, newBalance, username) {
    const diffEmoji = DIFF_EMOJI[difficulty] ?? '⚪';

    return new EmbedBuilder()
        .setColor('#ff9900')
        .setTitle('🎓 ⏱️ Time\'s Up!')
        .setDescription(`**${question}**`)
        .addFields(
            { name: '✅ Correct Answer',       value: correctAnswer                                                   },
            { name: `${diffEmoji} Difficulty`, value: capitalize(difficulty),                    inline: true          },
            { name: '💸 Penalty',              value: penaltyApplied ? `-${penaltyApplied.toLocaleString()} coins` : '0 coins', inline: true },
            { name: '💰 New Balance',          value: `${newBalance.toLocaleString()} coins`,   inline: true          },
        )
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
}

// ─── Command ───────────────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('quiz')
        .setDescription('Answer a trivia question to win coins — or lose some if you\'re wrong!')
        .addStringOption(opt =>
            opt.setName('difficulty')
                .setDescription('Question difficulty (default: random)')
                .setRequired(false)
                .addChoices(
                    { name: '🟢 Easy   — Win 250,  Lose 50',  value: 'easy'   },
                    { name: '🟡 Medium — Win 500,  Lose 100', value: 'medium' },
                    { name: '🔴 Hard   — Win 1000, Lose 150', value: 'hard'   },
                    { name: '⚪ Random (any difficulty)',      value: 'any'    },
                )),
    cooldown: 20,

    async execute(interaction) {
        const diffChoice = interaction.options.getString('difficulty') ?? 'any';
        await interaction.deferReply();

        // ── Load / create user ──────────────────────────────────────────────
        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });

        // ── Fetch question from Open Trivia Database ────────────────────────
        let raw;
        try {
            raw = await fetchQuestion(diffChoice);
        } catch (err) {
            console.error('[Quiz] fetch error:', err.message);
            return interaction.editReply({
                content: '⚠️ Couldn\'t reach the trivia server right now. Please try again in a moment.',
            });
        }

        const difficulty    = raw.difficulty;                          // actual difficulty from API
        const rewards       = REWARDS[difficulty] ?? REWARDS.medium;
        const category      = decodeHtml(raw.category);
        const question      = decodeHtml(raw.question);
        const correctAnswer = decodeHtml(raw.correct_answer);
        const allAnswers    = shuffleArray([correctAnswer, ...raw.incorrect_answers.map(decodeHtml)]);

        // ── Build select menu ───────────────────────────────────────────────
        const menuId = `quiz_${interaction.id}`;

        const select = new StringSelectMenuBuilder()
            .setCustomId(menuId)
            .setPlaceholder('Choose your answer…')
            .addOptions(
                allAnswers.map((ans, idx) =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(truncate(ans))
                        .setValue(`a${idx}`),
                ),
            );

        const row = new ActionRowBuilder().addComponents(select);

        await interaction.editReply({
            embeds:     [questionEmbed(question, category, difficulty, rewards, user.balance, interaction.user.username)],
            components: [row],
        });

        const message   = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === menuId,
            max:    1,
            time:   TIMER_SECONDS * 1000,
        });

        // ── Answer selected ─────────────────────────────────────────────────
        collector.on('collect', async i => {
            const selectedIndex = parseInt(i.values[0].slice(1), 10); // 'a0' → 0
            const chosenAnswer  = allAnswers[selectedIndex];
            const isCorrect     = chosenAnswer === correctAnswer;

            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

            let netChange;
            if (isCorrect) {
                netChange = rewards.win;
                freshUser.balance += rewards.win;
            } else {
                const actual = Math.min(rewards.lose, freshUser.balance);
                netChange = -actual;
                freshUser.balance = Math.max(0, freshUser.balance - rewards.lose);
            }
            await freshUser.save();

            await i.update({
                embeds:     [resultEmbed(isCorrect, question, correctAnswer, chosenAnswer, difficulty, rewards, netChange, freshUser.balance, interaction.user.username)],
                components: [],
            });
        });

        // ── Timeout ─────────────────────────────────────────────────────────
        collector.on('end', async (collected, reason) => {
            if (reason === 'limit') return; // answered — handled above

            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const penalty   = Math.min(rewards.lose, freshUser.balance);
            freshUser.balance = Math.max(0, freshUser.balance - rewards.lose);
            await freshUser.save();

            await interaction.editReply({
                embeds:     [timeoutEmbed(question, correctAnswer, difficulty, penalty, freshUser.balance, interaction.user.username)],
                components: [],
            }).catch(() => {});
        });
    },
};
