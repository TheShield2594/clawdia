const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const SCRAMBLE_POOL = [
    { word: 'BUDGET',  display: 'Budget',  wrong: ['Gadget',  'Basket']  },
    { word: 'PROFIT',  display: 'Profit',  wrong: ['Forfeit', 'Import']  },
    { word: 'CAREER',  display: 'Career',  wrong: ['Create',  'Radar']   },
    { word: 'REPORT',  display: 'Report',  wrong: ['Resort',  'Deport']  },
    { word: 'INVOICE', display: 'Invoice', wrong: ['Involve', 'Finance'] },
    { word: 'MEETING', display: 'Meeting', wrong: ['Mailing', 'Beating'] },
    { word: 'SALARY',  display: 'Salary',  wrong: ['Galaxy',  'Safety']  },
    { word: 'PROJECT', display: 'Project', wrong: ['Subject', 'Protect'] },
];

const CRISIS_POOL = [
    {
        question: 'A client complaint just came in. How do you handle it?',
        correct: 'Apologize and offer a fix',
        wrong: ['Blame a coworker', 'Ignore the email'],
    },
    {
        question: 'You spot a critical error in your work. What do you do?',
        correct: 'Fix it and notify your manager',
        wrong: ['Hope nobody notices', 'Delete the evidence'],
    },
    {
        question: 'Your coworker is struggling to meet a deadline. You:',
        correct: 'Offer to help them',
        wrong: ['Report them to the boss', 'Do nothing'],
    },
    {
        question: 'Two urgent tasks are due at the same time. You:',
        correct: 'Prioritize the most impactful one',
        wrong: ['Flip a coin', 'Take a coffee break'],
    },
    {
        question: 'The system crashes right before a presentation. You:',
        correct: 'Stay calm and troubleshoot quickly',
        wrong: ['Blame IT and leave', 'Panic and go home'],
    },
];

const COUNT_PAIRS = [
    { target: '🍎', decoy: '🍊' },
    { target: '⭐', decoy: '🌙' },
    { target: '💎', decoy: '🔮' },
    { target: '🔥', decoy: '💧' },
    { target: '🐱', decoy: '🐶' },
];

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function scrambleWord(word) {
    let result;
    let attempts = 0;
    do {
        result = word.split('').sort(() => Math.random() - 0.5).join('');
        attempts++;
    } while (result === word && attempts < 20);
    return result;
}

/**
 * Returns a challenge descriptor for the /work bonus mini-game.
 * Types: 'word_scramble', 'crisis_decision', 'quick_count'
 *
 * Returned object shape:
 *   type, title, description (string), row (ActionRowBuilder), correctId, timeLimit (ms)
 */
function generateWorkChallenge(jobName = 'your job') {
    const types = ['word_scramble', 'crisis_decision', 'quick_count'];
    const type = types[Math.floor(Math.random() * types.length)];

    if (type === 'word_scramble') {
        const entry = SCRAMBLE_POOL[Math.floor(Math.random() * SCRAMBLE_POOL.length)];
        const scrambled = scrambleWord(entry.word);
        const buttons = shuffle([
            new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(entry.display).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(entry.wrong[0]).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(entry.wrong[1]).setStyle(ButtonStyle.Secondary),
        ]);
        return {
            type,
            title: `🔡 Work Crisis — Word Scramble!`,
            description: `Unscramble this word from your ${jobName} shift:\n\`\`\`${scrambled}\`\`\``,
            row: new ActionRowBuilder().addComponents(...buttons),
            correctId: 'work_challenge_correct',
            timeLimit: 20_000,
        };
    }

    if (type === 'crisis_decision') {
        const entry = CRISIS_POOL[Math.floor(Math.random() * CRISIS_POOL.length)];
        const buttons = shuffle([
            new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(entry.correct).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(entry.wrong[0]).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(entry.wrong[1]).setStyle(ButtonStyle.Secondary),
        ]);
        return {
            type,
            title: `⚠️ Work Crisis — Situation!`,
            description: entry.question,
            row: new ActionRowBuilder().addComponents(...buttons),
            correctId: 'work_challenge_correct',
            timeLimit: 20_000,
        };
    }

    // quick_count
    const pair = COUNT_PAIRS[Math.floor(Math.random() * COUNT_PAIRS.length)];
    const targetCount = 2 + Math.floor(Math.random() * 4); // 2-5 targets
    const decoyCount  = 2 + Math.floor(Math.random() * 4); // 2-5 decoys
    const emojiStr = shuffle([
        ...Array(targetCount).fill(pair.target),
        ...Array(decoyCount).fill(pair.decoy),
    ]).join('');

    const wrong = new Set();
    while (wrong.size < 2) {
        const candidate = targetCount + Math.floor(Math.random() * 5) - 2;
        if (candidate !== targetCount && candidate >= 0) wrong.add(candidate);
    }
    const wrongArr = [...wrong];
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(String(targetCount)).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(String(wrongArr[0])).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(String(wrongArr[1])).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type,
        title: `🔢 Work Crisis — Quick Count!`,
        description: `How many **${pair.target}** do you see?\n${emojiStr}`,
        row: new ActionRowBuilder().addComponents(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 20_000,
    };
}

module.exports = { generateWorkChallenge };
