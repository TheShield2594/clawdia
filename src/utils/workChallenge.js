const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ── Existing challenge pools ──────────────────────────────────────────────────

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

const MATH_PROBLEMS = [
    { a: 14, b: 8,  op: '+', answer: 22 },
    { a: 37, b: 15, op: '+', answer: 52 },
    { a: 9,  b: 6,  op: '×', answer: 54 },
    { a: 8,  b: 7,  op: '×', answer: 56 },
    { a: 63, b: 27, op: '-', answer: 36 },
    { a: 48, b: 19, op: '-', answer: 29 },
    { a: 7,  b: 8,  op: '×', answer: 56 },
    { a: 25, b: 13, op: '+', answer: 38 },
    { a: 72, b: 36, op: '-', answer: 36 },
    { a: 6,  b: 9,  op: '×', answer: 54 },
];

// ── New job-specific challenge pools ─────────────────────────────────────────

// Cashier / Assistant — scan the correct SKU code fast
const SKU_POOL = [
    { code: 'SKU-4829', wrong: ['SKU-4928', 'SKU-4289'] },
    { code: 'SKU-7163', wrong: ['SKU-7613', 'SKU-7136'] },
    { code: 'SKU-3051', wrong: ['SKU-3501', 'SKU-3015'] },
    { code: 'SKU-9274', wrong: ['SKU-9724', 'SKU-9247'] },
    { code: 'SKU-5480', wrong: ['SKU-5840', 'SKU-5408'] },
    { code: 'SKU-2937', wrong: ['SKU-2973', 'SKU-2397'] },
    { code: 'SKU-6102', wrong: ['SKU-6120', 'SKU-6012'] },
    { code: 'SKU-8345', wrong: ['SKU-8435', 'SKU-8354'] },
];

// Dishwasher / Musician — recall a short sequence
const SEQUENCE_POOL = [
    { items: ['🍽️', '🥄', '🍴', '🥢'], label: 'dishes' },
    { items: ['🥛', '🍶', '🫖', '🍵'], label: 'cups' },
    { items: ['🎵', '🎶', '🎸', '🥁'], label: 'music notes' },
    { items: ['🔴', '🔵', '🟢', '🟡'], label: 'colours' },
    { items: ['🌟', '💫', '✨', '⭐'],  label: 'stars' },
    { items: ['🦊', '🐸', '🐧', '🦋'], label: 'animals' },
];

// Surgeon — pick the reading in the safe (normal) range
const VITALS_POOL = [
    {
        metric: 'heart rate (bpm)',
        correct: 78,
        wrong: [142, 38],
        hint: 'Normal range: 60–100 bpm',
    },
    {
        metric: 'heart rate (bpm)',
        correct: 92,
        wrong: [155, 35],
        hint: 'Normal range: 60–100 bpm',
    },
    {
        metric: 'blood oxygen (%)',
        correct: 98,
        wrong: [82, 110],
        hint: 'Normal range: 95–100%',
    },
    {
        metric: 'blood pressure (systolic)',
        correct: 118,
        wrong: [185, 72],
        hint: 'Normal range: 90–140 mmHg',
    },
    {
        metric: 'respiratory rate (breaths/min)',
        correct: 16,
        wrong: [32, 5],
        hint: 'Normal range: 12–20 breaths/min',
    },
];

// Architect / Artist / Designer — spot the pattern defect
const PATTERN_POOL = [
    {
        prompt: 'One blueprint has a structural defect. Which one?',
        options: ['▲ ■ ● ▲ ■ ●', '▲ ■ ● ▲ ■ ●', '▲ ■ ▲ ■ ● ●'],
        defectIndex: 2,
    },
    {
        prompt: 'One design breaks the symmetry. Which one?',
        options: ['◆ ○ ◆ ○ ◆', '◆ ● ◆ ○ ◆', '◆ ○ ◆ ○ ◆'],
        defectIndex: 1,
    },
    {
        prompt: 'One grid has a misaligned tile. Which one?',
        options: ['□ □ □ □', '□ □ □ □', '□ □ ■ □'],
        defectIndex: 2,
    },
    {
        prompt: 'One sequence breaks the repeating rule. Which one?',
        options: ['⬛ ⬜ ⬛ ⬜', '⬛ ⬜ ⬛ ⬛', '⬛ ⬜ ⬛ ⬜'],
        defectIndex: 1,
    },
    {
        prompt: 'One elevation view is structurally off. Which one?',
        options: ['🔲 🔳 🔲 🔳', '🔲 🔳 🔲 🔳', '🔳 🔲 🔳 🔲'],
        defectIndex: 2,
    },
];

// Director / Producer / Founder — executive decision scenarios
const EXECUTIVE_POOL = [
    {
        question: 'A major client wants a 30% discount on renewal. You:',
        correct: 'Counter with 15% and added value',
        wrong: ['Accept immediately', 'Reject and lose the deal'],
    },
    {
        question: 'Two senior engineers can\'t agree on a tech stack. You:',
        correct: 'Facilitate a structured trade-off review',
        wrong: ['Pick one at random', 'Let them fight it out'],
    },
    {
        question: 'The product launch is behind schedule. You:',
        correct: 'Scope-cut non-critical features and ship on time',
        wrong: ['Delay launch indefinitely', 'Launch broken and fix later'],
    },
    {
        question: 'A competitor just undercut your pricing by 20%. You:',
        correct: 'Reinforce your differentiation and quality story',
        wrong: ['Match the price immediately', 'Ignore it entirely'],
    },
    {
        question: 'Headcount budget is cut 15% next quarter. You:',
        correct: 'Prioritise roles tied to revenue and core ops',
        wrong: ['Freeze all hiring and promotions', 'Ignore the budget cap'],
    },
];

// ── Mapping: job name → preferred challenge type ──────────────────────────────

const JOB_CHALLENGE_MAP = {
    // Tier 1
    Cashier:    'sku_scan',
    Assistant:  'sku_scan',
    Dishwasher: 'sequence_memory',
    // Tier 2
    Developer:  'math_problem',
    Teacher:    'word_scramble',
    Chef:       'quick_count',
    Driver:     'quick_count',
    Designer:   'pattern_match',
    // Tier 3
    Engineer:   'math_problem',
    Analyst:    'math_problem',
    Writer:     'word_scramble',
    Musician:   'sequence_memory',
    Artist:     'pattern_match',
    // Tier 4
    Director:   'executive_call',
    Architect:  'pattern_match',
    Surgeon:    'steady_hands',
    Producer:   'executive_call',
    Founder:    'executive_call',
};

const GENERIC_TYPES = ['word_scramble', 'crisis_decision', 'quick_count', 'math_problem'];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeRow(...buttons) {
    return new ActionRowBuilder().addComponents(...buttons);
}

// ── Individual challenge builders ─────────────────────────────────────────────

function buildWordScramble(jobName) {
    const entry = SCRAMBLE_POOL[Math.floor(Math.random() * SCRAMBLE_POOL.length)];
    const scrambled = scrambleWord(entry.word);
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(entry.display).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(entry.wrong[0]).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(entry.wrong[1]).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'word_scramble',
        title: `🔡 Work Challenge — Word Scramble!`,
        description: `Unscramble this word from your ${jobName} shift:\n\`\`\`${scrambled}\`\`\``,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 15_000,
        startedAt: Date.now(),
    };
}

function buildCrisisDecision() {
    const entry = CRISIS_POOL[Math.floor(Math.random() * CRISIS_POOL.length)];
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(entry.correct).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(entry.wrong[0]).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(entry.wrong[1]).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'crisis_decision',
        title: `⚠️ Work Challenge — Situation!`,
        description: entry.question,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 15_000,
        startedAt: Date.now(),
    };
}

function buildQuickCount() {
    const pair = COUNT_PAIRS[Math.floor(Math.random() * COUNT_PAIRS.length)];
    const targetCount = 2 + Math.floor(Math.random() * 4);
    const decoyCount  = 2 + Math.floor(Math.random() * 4);
    const emojiStr = shuffle([
        ...Array(targetCount).fill(pair.target),
        ...Array(decoyCount).fill(pair.decoy),
    ]).join('');
    // Bounded, then filled deterministically — the same shape buildMathProblem
    // below already uses. Unbounded, this spins forever on any run of rolls
    // that keeps landing on the target, which is every roll under a pinned rng
    // (#786) and an unlikely-but-possible one under a real one.
    const wrong = new Set();
    let attempts = 0;
    while (wrong.size < 2 && attempts < 50) {
        attempts++;
        const candidate = targetCount + Math.floor(Math.random() * 5) - 2;
        if (candidate !== targetCount && candidate >= 0) wrong.add(candidate);
    }
    for (let fallback = 1; wrong.size < 2; fallback++) {
        wrong.add(targetCount + fallback);
    }
    const wrongArr = [...wrong];
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(String(targetCount)).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(String(wrongArr[0])).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(String(wrongArr[1])).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'quick_count',
        title: `🔢 Work Challenge — Quick Count!`,
        description: `How many **${pair.target}** do you see?\n${emojiStr}`,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 12_000,
        startedAt: Date.now(),
    };
}

function buildMathProblem() {
    const problem = MATH_PROBLEMS[Math.floor(Math.random() * MATH_PROBLEMS.length)];
    const wrongNums = new Set();
    let iterations = 0;
    while (wrongNums.size < 2 && iterations < 50) {
        iterations++;
        const delta = Math.floor(Math.random() * 6) + 1;
        const candidate = problem.answer + (Math.random() < 0.5 ? delta : -delta);
        if (candidate !== problem.answer && candidate > 0) wrongNums.add(candidate);
    }
    for (let fallback = 1; wrongNums.size < 2; fallback++) {
        const candidate = problem.answer + fallback;
        if (candidate !== problem.answer) wrongNums.add(candidate);
    }
    const mathWrong = [...wrongNums];
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(String(problem.answer)).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(String(mathWrong[0])).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(String(mathWrong[1])).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'math_problem',
        title: `🧮 Work Challenge — Quick Math!`,
        description: `Solve this fast:\n\`\`\`${problem.a} ${problem.op} ${problem.b} = ?\`\`\``,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 12_000,
        startedAt: Date.now(),
    };
}

function buildSkuScan() {
    const entry = SKU_POOL[Math.floor(Math.random() * SKU_POOL.length)];
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(entry.code).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(entry.wrong[0]).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(entry.wrong[1]).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'sku_scan',
        title: `🏪 Work Challenge — Quick Scan!`,
        description: `Customer is waiting! Scan the correct barcode:\n\`\`\`${entry.code}\`\`\``,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 10_000,
        startedAt: Date.now(),
    };
}

function buildSequenceMemory() {
    const entry = SEQUENCE_POOL[Math.floor(Math.random() * SEQUENCE_POOL.length)];
    const posIndex = Math.floor(Math.random() * entry.items.length);
    const ordinals = ['1st', '2nd', '3rd', '4th'];
    const correctEmoji = entry.items[posIndex];
    const otherEmojis  = entry.items.filter((_, i) => i !== posIndex);
    const wrongPick    = shuffle(otherEmojis).slice(0, 2);
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(correctEmoji).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(wrongPick[0]).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(wrongPick[1]).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'sequence_memory',
        title: `🧠 Work Challenge — Remember the Order!`,
        description: `Here's the sequence:\n> ${entry.items.join('  ')}\n\nWhat was the **${ordinals[posIndex]}** item?`,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 15_000,
        startedAt: Date.now(),
    };
}

function buildSteadyHands() {
    const entry = VITALS_POOL[Math.floor(Math.random() * VITALS_POOL.length)];
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(`${entry.correct}`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(`${entry.wrong[0]}`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(`${entry.wrong[1]}`).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'steady_hands',
        title: `🏥 Work Challenge — Steady Hands!`,
        description: `The patient's vitals are spiking! Select the **safe** ${entry.metric}:\n*${entry.hint}*`,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 10_000,
        startedAt: Date.now(),
    };
}

function buildPatternMatch() {
    const entry = PATTERN_POOL[Math.floor(Math.random() * PATTERN_POOL.length)];
    const labels = ['A', 'B', 'C'];
    const description = entry.options
        .map((opt, i) => `**${labels[i]}:** \`${opt}\``)
        .join('\n');
    const wrongIds = ['work_challenge_wrong1', 'work_challenge_wrong2'];
    let wi = 0;
    const buttons = labels.map((label, i) => {
        const id = i === entry.defectIndex ? 'work_challenge_correct' : wrongIds[wi++];
        return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary);
    });
    return {
        type: 'pattern_match',
        title: `📐 Work Challenge — Spot the Defect!`,
        description: `${entry.prompt}\n\n${description}`,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 15_000,
        startedAt: Date.now(),
    };
}

function buildExecutiveCall() {
    const entry = EXECUTIVE_POOL[Math.floor(Math.random() * EXECUTIVE_POOL.length)];
    const buttons = shuffle([
        new ButtonBuilder().setCustomId('work_challenge_correct').setLabel(entry.correct).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong1').setLabel(entry.wrong[0]).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('work_challenge_wrong2').setLabel(entry.wrong[1]).setStyle(ButtonStyle.Secondary),
    ]);
    return {
        type: 'executive_call',
        title: `💼 Work Challenge — Executive Call!`,
        description: entry.question,
        row: makeRow(...buttons),
        correctId: 'work_challenge_correct',
        timeLimit: 15_000,
        startedAt: Date.now(),
    };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Returns a challenge descriptor for the /work bonus mini-game.
 * When jobName matches a known job, a thematically appropriate challenge is
 * selected; otherwise one of the four generic types is chosen at random.
 *
 * Returned object shape:
 *   type, title, description, row, correctId, timeLimit (ms), startedAt (ms)
 *
 * Fast-answer window: if the user answers within 5s of startedAt, work.js
 * awards the "exceptional challenge" bonus (+55%) instead of the standard (+40%).
 */
function generateWorkChallenge(jobName = 'your job') {
    const mappedType = JOB_CHALLENGE_MAP[jobName];
    const type = mappedType ?? GENERIC_TYPES[Math.floor(Math.random() * GENERIC_TYPES.length)];

    switch (type) {
        case 'sku_scan':        return buildSkuScan();
        case 'sequence_memory': return buildSequenceMemory();
        case 'steady_hands':    return buildSteadyHands();
        case 'pattern_match':   return buildPatternMatch();
        case 'executive_call':  return buildExecutiveCall();
        case 'word_scramble':   return buildWordScramble(jobName);
        case 'crisis_decision': return buildCrisisDecision();
        case 'quick_count':     return buildQuickCount();
        case 'math_problem':    return buildMathProblem();
        default:                return buildCrisisDecision();
    }
}

module.exports = { generateWorkChallenge };
