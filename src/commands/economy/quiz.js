const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const axios = require('axios');
const User  = require('../../models/User');

const THUMB         = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f393.png';
const TIMER_SECONDS = 30;
const OPENTDB_URL   = 'https://opentdb.com/api.php';

const REWARDS = {
    easy:   { win: 250,  lose: 50  },
    medium: { win: 500,  lose: 100 },
    hard:   { win: 1000, lose: 150 },
};

function decodeHtml(str) {
    return str
        .replace(/&amp;/g,   '&').replace(/&lt;/g,    '<').replace(/&gt;/g,    '>')
        .replace(/&quot;/g,  '"').replace(/&#039;/g,  "'").replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"').replace(/&lsquo;/g, ''').replace(/&rsquo;/g, ''')
        .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&deg;/g,   '°')
        .replace(/&hellip;/g,'…');
}

async function fetchQuestion(difficulty) {
    const params = { amount: 1, type: 'multiple' };
    if (difficulty !== 'any') params.difficulty = difficulty;
    const { data } = await axios.get(OPENTDB_URL, { params, timeout: 8000 });
    if (data.response_code !== 0 || !data.results?.length)
        throw new Error(`OpenTDB response_code: ${data.response_code}`);
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

function questionEmbed(question, category, difficulty, rewards, balance, interaction, elapsed = 0) {
    const diffEmoji = DIFF_EMOJI[difficulty] ?? '⚪';
    const catEmoji  = categoryEmoji(category);
    const color     = DIFF_COLOR[difficulty] ?? '#5865F2';

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
        .setFooter({ text: `${TIMER_SECONDS}s to answer — pick from the menu below` });
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
        .setColor('#ff9900')
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
                    { name: '🟢 Easy   — Win 250,  Lose 50',  value: 'easy'   },
                    { name: '🟡 Medium — Win 500,  Lose 100', value: 'medium' },
                    { name: '🔴 Hard   — Win 1000, Lose 150', value: 'hard'   },
                    { name: '⚪ Random (any difficulty)',      value: 'any'    },
                )),
    cooldown: 20,

    async execute(interaction) {
        const diffChoice = interaction.options.getString('difficulty') ?? 'any';
        await interaction.deferReply();

        let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!user) user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });

        let raw;
        try {
            raw = await fetchQuestion(diffChoice);
        } catch (err) {
            console.error('[Quiz] fetch error:', err.message);
            return interaction.editReply({ content: '⚠️ Couldn\'t reach the trivia server right now. Please try again in a moment.' });
        }

        const difficulty    = raw.difficulty;
        const rewards       = REWARDS[difficulty] ?? REWARDS.medium;
        const category      = decodeHtml(raw.category);
        const question      = decodeHtml(raw.question);
        const correctAnswer = decodeHtml(raw.correct_answer);
        const allAnswers    = shuffleArray([correctAnswer, ...raw.incorrect_answers.map(decodeHtml)]);
        const menuId        = `quiz_${interaction.id}`;

        const select = new StringSelectMenuBuilder()
            .setCustomId(menuId)
            .setPlaceholder('Choose your answer…')
            .addOptions(allAnswers.map((ans, idx) =>
                new StringSelectMenuOptionBuilder().setLabel(truncate(ans)).setValue(`a${idx}`),
            ));

        const menuRow = new ActionRowBuilder().addComponents(select);

        const startTime = Date.now();
        await interaction.editReply({
            embeds:     [questionEmbed(question, category, difficulty, rewards, user.balance, interaction, 0)],
            components: [menuRow],
        });

        // Update the timer bar every ~8 seconds (safe under rate limits)
        const timerInterval = setInterval(async () => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            if (elapsed >= TIMER_SECONDS) { clearInterval(timerInterval); return; }
            await interaction.editReply({
                embeds:     [questionEmbed(question, category, difficulty, rewards, user.balance, interaction, elapsed)],
                components: [menuRow],
            }).catch(() => clearInterval(timerInterval));
        }, 8_000);

        const message   = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === menuId,
            max:    1,
            time:   TIMER_SECONDS * 1000,
        });

        collector.on('collect', async i => {
            clearInterval(timerInterval);
            const selectedIndex = parseInt(i.values[0].slice(1), 10);
            const chosenAnswer  = allAnswers[selectedIndex];
            const isCorrect     = chosenAnswer === correctAnswer;
            const userFilter    = { userId: interaction.user.id, guildId: interaction.guild.id };
            let netChange, updated;

            if (isCorrect) {
                netChange = rewards.win;
                updated   = await User.findOneAndUpdate(userFilter, { $inc: { balance: rewards.win } }, { new: true });
            } else {
                const freshUser = await User.findOne(userFilter);
                const penalty   = Math.min(rewards.lose, freshUser?.balance ?? 0);
                netChange = -penalty;
                updated   = await User.findOneAndUpdate(userFilter, { $inc: { balance: -penalty } }, { new: true });
            }

            const replayId = `quiz_replay_${interaction.id}_${Date.now()}`;
            const replayRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(replayId).setLabel('🎓 Play Again').setStyle(ButtonStyle.Primary),
            );

            await i.update({
                embeds:     [resultEmbed(interaction, isCorrect, question, correctAnswer, chosenAnswer, difficulty, rewards, netChange, updated?.balance ?? 0)],
                components: [replayRow],
            });

            message.createMessageComponentCollector({
                filter: ri => ri.user.id === interaction.user.id && ri.customId === replayId,
                max: 1, time: 60_000,
            }).on('collect', async ri => {
                await ri.deferUpdate();
                // Re-run the command's execute logic by re-fetching a question
                let newRaw;
                try { newRaw = await fetchQuestion(diffChoice); }
                catch { return interaction.editReply({ content: '⚠️ Couldn\'t reach the trivia server. Try again.', components: [] }); }

                const newDiff    = newRaw.difficulty;
                const newRewards = REWARDS[newDiff] ?? REWARDS.medium;
                const newCat     = decodeHtml(newRaw.category);
                const newQ       = decodeHtml(newRaw.question);
                const newCorrect = decodeHtml(newRaw.correct_answer);
                const newAnswers = shuffleArray([newCorrect, ...newRaw.incorrect_answers.map(decodeHtml)]);
                const newMenuId  = `quiz_${interaction.id}_r${Date.now()}`;

                const freshUser  = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                const newSelect  = new StringSelectMenuBuilder()
                    .setCustomId(newMenuId)
                    .setPlaceholder('Choose your answer…')
                    .addOptions(newAnswers.map((ans, idx) =>
                        new StringSelectMenuOptionBuilder().setLabel(truncate(ans)).setValue(`a${idx}`),
                    ));
                const newMenuRow = new ActionRowBuilder().addComponents(newSelect);

                await interaction.editReply({
                    embeds:     [questionEmbed(newQ, newCat, newDiff, newRewards, freshUser?.balance ?? 0, interaction, 0)],
                    components: [newMenuRow],
                });

                const newMsg       = await interaction.fetchReply();
                const newStartTime = Date.now();

                const newTimerInterval = setInterval(async () => {
                    const elapsed = Math.floor((Date.now() - newStartTime) / 1000);
                    if (elapsed >= TIMER_SECONDS) { clearInterval(newTimerInterval); return; }
                    await interaction.editReply({
                        embeds: [questionEmbed(newQ, newCat, newDiff, newRewards, freshUser?.balance ?? 0, interaction, elapsed)],
                        components: [newMenuRow],
                    }).catch(() => clearInterval(newTimerInterval));
                }, 8_000);

                const newCollector = newMsg.createMessageComponentCollector({
                    filter: ni => ni.user.id === interaction.user.id && ni.customId === newMenuId,
                    max: 1, time: TIMER_SECONDS * 1000,
                });

                newCollector.on('collect', async ni => {
                    clearInterval(newTimerInterval);
                    const idx       = parseInt(ni.values[0].slice(1), 10);
                    const chosen    = newAnswers[idx];
                    const correct   = chosen === newCorrect;
                    const uf        = { userId: interaction.user.id, guildId: interaction.guild.id };
                    let nc, upd;
                    if (correct) {
                        nc  = newRewards.win;
                        upd = await User.findOneAndUpdate(uf, { $inc: { balance: newRewards.win } }, { new: true });
                    } else {
                        const fu  = await User.findOne(uf);
                        const pen = Math.min(newRewards.lose, fu?.balance ?? 0);
                        nc  = -pen;
                        upd = await User.findOneAndUpdate(uf, { $inc: { balance: -pen } }, { new: true });
                    }
                    await ni.update({
                        embeds:     [resultEmbed(interaction, correct, newQ, newCorrect, chosen, newDiff, newRewards, nc, upd?.balance ?? 0)],
                        components: [],
                    });
                });

                newCollector.on('end', async (col, reason) => {
                    clearInterval(newTimerInterval);
                    if (reason === 'limit') return;
                    const uf  = { userId: interaction.user.id, guildId: interaction.guild.id };
                    const fu  = await User.findOne(uf);
                    const pen = Math.min(newRewards.lose, fu?.balance ?? 0);
                    const upd = await User.findOneAndUpdate(uf, { $inc: { balance: -pen } }, { new: true });
                    await interaction.editReply({
                        embeds:     [timeoutEmbed(interaction, newQ, newCorrect, newDiff, pen, upd?.balance ?? 0)],
                        components: [],
                    }).catch(() => {});
                });
            }).on('end', (_, reason) => {
                if (reason !== 'limit') interaction.editReply({ components: [] }).catch(() => {});
            });
        });

        collector.on('end', async (collected, reason) => {
            clearInterval(timerInterval);
            if (reason === 'limit') return;

            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };
            const freshUser  = await User.findOne(userFilter);
            const penalty    = Math.min(rewards.lose, freshUser?.balance ?? 0);
            const updated    = await User.findOneAndUpdate(userFilter, { $inc: { balance: -penalty } }, { new: true });

            await interaction.editReply({
                embeds:     [timeoutEmbed(interaction, question, correctAnswer, difficulty, penalty, updated?.balance ?? 0)],
                components: [],
            }).catch(() => {});
        });
    },
};
