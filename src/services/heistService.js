// In-memory state for active heist lobbies and in-progress heists.
// Keyed by guildId so only one heist can run per guild at a time.
//
// Same boundary as src/utils/crashLobby.js: a heist is a sequence of role
// minigames driven by collectors on live messages, so the session cannot be
// moved to Mongo without redesigning the round itself. A second process would
// allow two concurrent heists in one guild, and a restart abandons one — the
// payout is credited per participant with an `$inc` at the end, so neither
// duplicates anyone's coins. The per-user action lock, which is the thing that
// actually gates money, is in Mongo; see src/utils/activeGameLock.js.

const { assertGuildAffinity } = require('../utils/sharding');

const activeHeists = new Map();

const ROLES = {
    hacker:  { emoji: '💻', label: 'Hacker',  desc: 'Bypasses security systems — answer a logic question.' },
    lookout: { emoji: '👀', label: 'Lookout', desc: 'Monitors guard patterns — identify the duplicate number.' },
    muscle:  { emoji: '💪', label: 'Muscle',  desc: 'Handles confrontations — play higher-lower.' },
    driver:  { emoji: '🚗', label: 'Driver',  desc: 'Plans the escape route — pick the safe route.' },
};

const TARGETS = {
    bank:    { label: 'Server Bank',    baseReward: 1.0 },
    vault:   { label: 'Faction Vault',  baseReward: 1.5 },
    casino:  { label: 'Casino Safe',    baseReward: 1.25 },
};

function generateHeistId(guildId) {
    return `${guildId}-${Date.now()}`;
}

function getHeist(guildId) {
    return activeHeists.get(guildId) ?? null;
}

function createLobby({ guildId, channelId, initiatorId, target, lobbyDurationSeconds, maxPayout }) {
    const safeDuration = (Number.isFinite(lobbyDurationSeconds) && lobbyDurationSeconds > 0) ? lobbyDurationSeconds : 60;
    const safePayout   = (Number.isFinite(maxPayout) && maxPayout > 0) ? maxPayout : 10000;
    lobbyDurationSeconds = safeDuration;
    maxPayout = safePayout;
    const heistId = generateHeistId(guildId);
    const state = {
        heistId,
        guildId,
        channelId,
        initiatorId,
        target: TARGETS[target] ? target : 'bank',
        lobbyEndsAt: new Date(Date.now() + lobbyDurationSeconds * 1000),
        phase: 'lobby',
        players: new Map(), // userId -> { role, username, skillPassed: null }
        maxPayout,
        lobbyMessage: null,
        skillResults: {},
        skillTimers: {},
    };
    // One heist per guild only holds while one shard handles that guild; see
    // src/utils/sharding.js (#732).
    assertGuildAffinity(guildId, 'heist lobby');
    activeHeists.set(guildId, state);
    return state;
}

function joinLobby(guildId, userId, username, role) {
    const heist = activeHeists.get(guildId);
    if (!heist || heist.phase !== 'lobby') return { ok: false, reason: 'No active lobby.' };
    if (!ROLES[role]) return { ok: false, reason: 'Invalid role.' };

    // Each role can only be taken once
    for (const [pid, p] of heist.players) {
        if (p.role === role) return { ok: false, reason: `The ${ROLES[role].label} role is already taken.` };
        if (pid === userId) return { ok: false, reason: 'You already joined this heist.' };
    }

    heist.players.set(userId, { role, username, skillPassed: null });
    return { ok: true };
}

function endLobby(guildId) {
    const heist = activeHeists.get(guildId);
    if (!heist) return null;
    heist.phase = 'active';
    return heist;
}

function clearHeist(guildId) {
    const heist = activeHeists.get(guildId);
    if (heist) {
        // Cancel any outstanding skill check timers
        for (const timer of Object.values(heist.skillTimers || {})) {
            clearTimeout(timer);
        }
    }
    activeHeists.delete(guildId);
}

// ── Skill check generators ─────────────────────────────────────────────────

function makeHackerCheck() {
    // Simple arithmetic question with 4 choices
    const a = Math.floor(Math.random() * 20) + 5;
    const b = Math.floor(Math.random() * 20) + 5;
    const ops = [
        { op: '+', answer: a + b },
        { op: '×', answer: a * b },
        { op: '-', answer: Math.max(a, b) - Math.min(a, b) },
    ];
    const chosen = ops[Math.floor(Math.random() * ops.length)];
    const correct = chosen.answer;
    const question = `What is **${a} ${chosen.op} ${b}**?`;

    // Build 4 choices — correct + 3 distractors
    const wrong = new Set();
    while (wrong.size < 3) {
        const off = Math.floor(Math.random() * 10) + 1;
        const candidate = correct + (Math.random() < 0.5 ? off : -off);
        if (candidate !== correct && candidate >= 0) wrong.add(candidate);
    }
    const choices = shuffle([correct, ...[...wrong]]);
    return { question, correct, choices };
}

function makeLookoutCheck() {
    // Show 5 numbers, one appears twice — identify the duplicate
    const pool = [];
    while (pool.length < 5) {
        const n = Math.floor(Math.random() * 9) + 1;
        if (!pool.includes(n)) pool.push(n);
    }
    const dup = pool[Math.floor(Math.random() * pool.length)];
    const sequence = shuffle([...pool, dup]);
    const question = `Spot the **duplicate number** in: ${sequence.join('  ')}`;
    return { question, correct: dup, choices: shuffle([...pool]) };
}

function makeMuscleCheck() {
    // Higher-lower: guess if next number is higher or lower than current
    const current = Math.floor(Math.random() * 8) + 2; // 2–9
    const next = Math.floor(Math.random() * 10) + 1;    // 1–10
    const correct = next > current ? 'higher' : next < current ? 'lower' : 'equal';
    const correctLabel = correct === 'equal' ? 'higher' : correct; // treat equal as higher
    const question = `The current number is **${current}**. Will the next number be **higher** or **lower**?`;
    return { question, correct: correctLabel, choices: ['higher', 'lower'] };
}

function makeDriverCheck() {
    // Pick the "safe" escape route from 3 options
    const routes = ['Route A — back alley', 'Route B — highway', 'Route C — docks'];
    const safeIdx = Math.floor(Math.random() * 3);
    const question = `Choose the **safe escape route**:\n${routes.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
    return { question, correct: String(safeIdx + 1), choices: ['1', '2', '3'] };
}

function buildSkillCheck(role) {
    switch (role) {
        case 'hacker':  return makeHackerCheck();
        case 'lookout': return makeLookoutCheck();
        case 'muscle':  return makeMuscleCheck();
        case 'driver':  return makeDriverCheck();
        default: return makeHackerCheck();
    }
}

// ── Outcome calculation ────────────────────────────────────────────────────

function calculateOutcome(heist) {
    const players = [...heist.players.values()];
    const total = players.length;
    if (!total) return { outcome: 'failure', passedCount: 0, totalCount: 0 };

    const passedCount = players.filter(p => p.skillPassed === true).length;
    const ratio = passedCount / total;

    let outcome;
    if (ratio === 1)       outcome = 'full_success';
    else if (ratio >= 0.5) outcome = 'partial_success';
    else                   outcome = 'failure';

    return { outcome, passedCount, totalCount: total, ratio };
}

function computePayouts(heist, passedCount, totalCount, ratio) {
    const target    = TARGETS[heist.target] ?? TARGETS.bank;
    const maxPayout = heist.maxPayout ?? 10000;
    const basePot   = Math.floor(maxPayout * target.baseReward);

    if (ratio === 1) {
        const share = Math.floor(basePot / totalCount);
        return { share, total: basePot, multiplier: '1.0×' };
    }
    if (ratio >= 0.5) {
        const reduced = Math.floor(basePot * 0.5);
        const share   = passedCount > 0 ? Math.floor(reduced / passedCount) : 0;
        return { share, total: reduced, multiplier: '0.5×' };
    }
    return { share: 0, total: 0, multiplier: '0×' };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Active heist state lives only in memory. On process restart all entries are
// gone; any in-flight lobby messages will have orphaned buttons. There is no
// persistence layer to restore from, so we simply export this no-op to make
// the intent explicit and allow callers to call it without branching.
function initActiveHeists() {
    // No-op: Map is always empty at startup. Orphaned lobby buttons will return
    // "no active lobby" when clicked, which is the correct safe fallback.
}

module.exports = {
    ROLES,
    TARGETS,
    activeHeists,
    getHeist,
    createLobby,
    joinLobby,
    endLobby,
    clearHeist,
    buildSkillCheck,
    calculateOutcome,
    computePayouts,
    initActiveHeists,
};
