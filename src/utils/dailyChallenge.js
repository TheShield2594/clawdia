const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const MATH_PROBLEMS = [
    { question: '6 × 7', answer: 42 },
    { question: '8 × 9', answer: 72 },
    { question: '7 × 8', answer: 56 },
    { question: '4 × 9', answer: 36 },
    { question: '6 × 8', answer: 48 },
    { question: '5 × 7', answer: 35 },
    { question: '9 × 9', answer: 81 },
    { question: '3 × 8', answer: 24 },
    { question: '11 × 7', answer: 77 },
    { question: '11 × 6', answer: 66 },
];

const DECOY_EMOJIS = ['🌸', '🎲', '🌟', '🎯', '🌈', '🎪', '🎭', '🌺'];

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function generateWrongAnswers(correct, count) {
    const offsets = [-15, -10, -8, -6, -5, 5, 6, 8, 10, 15, -3, 3, -12, 12];
    const wrong = new Set();
    for (const offset of shuffle(offsets)) {
        if (wrong.size >= count) break;
        const candidate = correct + offset;
        if (candidate !== correct && candidate > 0 && candidate < 150) wrong.add(candidate);
    }
    // Bounded, then filled deterministically: the offsets above cover the usual
    // case, and this only runs when they were all rejected. Unbounded, it spins
    // forever on any run of rolls that keeps producing the same candidate
    // (#786).
    let attempts = 0;
    while (wrong.size < count && attempts < 50) {
        attempts++;
        const candidate = correct + Math.floor(Math.random() * 20) - 10;
        if (candidate !== correct && candidate > 0) wrong.add(candidate);
    }
    for (let fallback = 1; wrong.size < count; fallback++) {
        wrong.add(correct + fallback + offsets.length);
    }
    return [...wrong].slice(0, count);
}

/**
 * Returns a challenge descriptor for the /daily bonus mini-game.
 * Types: 'emoji_pick', 'quick_math', 'react_fast'
 *
 * Returned object shape:
 *   type, description, row (ActionRowBuilder), correctId, timeLimit (ms)
 *   react_fast only: activeRow (enabled row), activateDelay (ms)
 */
function generateDailyChallenge() {
    const types = ['emoji_pick', 'quick_math', 'react_fast'];
    const type = types[Math.floor(Math.random() * types.length)];

    if (type === 'emoji_pick') {
        const decoys = shuffle(DECOY_EMOJIS).slice(0, 2);
        const buttons = shuffle([
            new ButtonBuilder().setCustomId('daily_challenge_correct').setLabel('🍀').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('daily_challenge_wrong1').setLabel(decoys[0]).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('daily_challenge_wrong2').setLabel(decoys[1]).setStyle(ButtonStyle.Secondary),
        ]);
        return {
            type,
            description: 'Click the **🍀** to earn a bonus!',
            row: new ActionRowBuilder().addComponents(...buttons),
            correctId: 'daily_challenge_correct',
            timeLimit: 15_000,
        };
    }

    if (type === 'quick_math') {
        const problem = MATH_PROBLEMS[Math.floor(Math.random() * MATH_PROBLEMS.length)];
        const wrong = generateWrongAnswers(problem.answer, 2);
        const buttons = shuffle([
            new ButtonBuilder().setCustomId('daily_challenge_correct').setLabel(String(problem.answer)).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('daily_challenge_wrong1').setLabel(String(wrong[0])).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('daily_challenge_wrong2').setLabel(String(wrong[1])).setStyle(ButtonStyle.Secondary),
        ]);
        return {
            type,
            description: `What is **${problem.question}**?`,
            row: new ActionRowBuilder().addComponents(...buttons),
            correctId: 'daily_challenge_correct',
            timeLimit: 15_000,
        };
    }

    // react_fast — button is disabled until activateDelay has elapsed
    const activateDelay = 2000 + Math.floor(Math.random() * 1000);
    const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('daily_challenge_correct').setLabel('⚡ CLAIM').setStyle(ButtonStyle.Success).setDisabled(true),
    );
    const activeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('daily_challenge_correct').setLabel('⚡ CLAIM').setStyle(ButtonStyle.Success),
    );
    return {
        type,
        description: 'Click **⚡ CLAIM** when the button activates!',
        row: disabledRow,
        activeRow,
        activateDelay,
        correctId: 'daily_challenge_correct',
        timeLimit: 15_000,
    };
}

module.exports = { generateDailyChallenge };
