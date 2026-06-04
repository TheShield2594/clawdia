// In-memory state for active syndicate heist lobbies, keyed by guildId.
// Only one syndicate heist can run per guild at a time.

const activeSyndicateHeists = new Map();

const SYNDICATE_TARGETS = {
    bank_job: {
        label:             'Bank Job',
        emoji:             '🏦',
        minPlayers:        3,
        baseSuccessChance: 0.45,
        minPayout:         10_000,
        maxPayout:         25_000,
        heatGain:          8,
    },
    museum_heist: {
        label:             'Museum Heist',
        emoji:             '🏛️',
        minPlayers:        5,
        baseSuccessChance: 0.30,
        minPayout:         30_000,
        maxPayout:         80_000,
        heatGain:          15,
    },
    city_hall_con: {
        label:             'City Hall Con',
        emoji:             '🏙️',
        minPlayers:        7,
        baseSuccessChance: 0.20,
        minPayout:         100_000,
        maxPayout:         200_000,
        heatGain:          25,
    },
};

// Each role has an emoji, label, and a skillType that maps to heistService's buildSkillCheck
const SYNDICATE_ROLES = {
    driver:   { emoji: '🚗', label: 'Driver',   skillType: 'driver',  desc: 'Plans the getaway — pick the safe escape route.' },
    hacker:   { emoji: '💻', label: 'Hacker',   skillType: 'hacker',  desc: 'Bypasses security — solve the logic puzzle.' },
    lookout:  { emoji: '👀', label: 'Lookout',  skillType: 'lookout', desc: 'Monitors guards — spot the duplicate number.' },
    muscle:   { emoji: '💪', label: 'Muscle',   skillType: 'muscle',  desc: 'Handles threats — guess higher or lower.' },
    grifter:  { emoji: '🎭', label: 'Grifter',  skillType: 'hacker',  desc: 'Creates a diversion — crack the misdirection code.' },
    courier:  { emoji: '📦', label: 'Courier',  skillType: 'driver',  desc: 'Moves the goods — choose the fastest delivery path.' },
    scout:    { emoji: '🔭', label: 'Scout',    skillType: 'lookout', desc: 'Gathers intel — identify the surveillance anomaly.' },
};

function generateSyndicateHeistId(guildId) {
    return `syn-${guildId}-${Date.now()}`;
}

function createSyndicateLobby({ guildId, channelId, syndicateId, leaderId, target, lobbyDurationSeconds, currentHeat }) {
    // Clear any orphaned lobby so timers don't double-fire if the caller somehow
    // calls this without first checking getSyndicateHeist.
    const existing = activeSyndicateHeists.get(guildId);
    if (existing) {
        for (const timer of Object.values(existing.skillTimers || {})) clearTimeout(timer);
        activeSyndicateHeists.delete(guildId);
    }

    const heistId = generateSyndicateHeistId(guildId);
    const state = {
        heistId,
        guildId,
        channelId,
        syndicateId,
        leaderId,
        target,
        lobbyEndsAt: new Date(Date.now() + lobbyDurationSeconds * 1000),
        phase: 'lobby',
        players: new Map(),  // userId -> { role, username, skillPassed: null }
        skillTimers: {},
        sabotageCount: 0,
        heatAtStart: currentHeat,
        resolving: false,
        _skillChecks: {},
    };
    activeSyndicateHeists.set(guildId, state);
    return state;
}

function joinSyndicateLobby(guildId, userId, username, role) {
    const heist = activeSyndicateHeists.get(guildId);
    if (!heist || heist.phase !== 'lobby') return { ok: false, reason: 'No active lobby.' };
    if (!SYNDICATE_ROLES[role]) return { ok: false, reason: 'Invalid role.' };
    for (const [pid, p] of heist.players) {
        if (p.role === role) return { ok: false, reason: `The ${SYNDICATE_ROLES[role].label} role is already taken.` };
        if (pid === userId) return { ok: false, reason: 'You already joined this heist.' };
    }
    heist.players.set(userId, { role, username, skillPassed: null });
    return { ok: true };
}

function endSyndicateLobby(guildId) {
    const heist = activeSyndicateHeists.get(guildId);
    if (!heist) return null;
    heist.phase = 'active';
    return heist;
}

function clearSyndicateHeist(guildId) {
    const heist = activeSyndicateHeists.get(guildId);
    if (heist) {
        for (const timer of Object.values(heist.skillTimers || {})) clearTimeout(timer);
    }
    activeSyndicateHeists.delete(guildId);
}

function getSyndicateHeist(guildId) {
    return activeSyndicateHeists.get(guildId) ?? null;
}

// Computes current heat accounting for passive decay (10 per 24h without a heist)
function getEffectiveHeat(syndicateDoc) {
    if (!syndicateDoc.lastHeistAt) return Math.max(0, syndicateDoc.heat);
    const hoursSince = (Date.now() - syndicateDoc.lastHeistAt.getTime()) / (1000 * 60 * 60);
    const daysSince = Math.floor(hoursSince / 24);
    return Math.max(0, syndicateDoc.heat - daysSince * 10);
}

// Determines outcome and payouts for a resolved syndicate heist.
// High heat (>50) adds +20% payout but -15% success chance.
// Each sabotage reduces success chance by an additional 15%.
function computeSyndicateOutcome(heist) {
    const target = SYNDICATE_TARGETS[heist.target];
    if (!target) {
        console.error(`[syndicateService] computeSyndicateOutcome: unknown target "${heist.target}"`);
        return { outcome: 'bust', payout: 0, perPlayer: 0, passedCount: 0, totalCount: 0 };
    }

    const players = [...heist.players.values()];
    const total = players.length;
    if (!total) return { outcome: 'bust', payout: 0, perPlayer: 0, passedCount: 0, totalCount: 0 };

    const highHeat = heist.heatAtStart > 50;
    const adjustedChance = Math.max(0.05,
        target.baseSuccessChance
        + (highHeat ? -0.15 : 0)
        - (heist.sabotageCount * 0.15)
    );

    if (Math.random() >= adjustedChance) {
        return { outcome: 'bust', payout: 0, perPlayer: 0, passedCount: 0, totalCount: total };
    }

    const passedCount = players.filter(p => p.skillPassed === true).length;
    const ratio = passedCount / total;
    const heatMultiplier = highHeat ? 1.2 : 1.0;
    const basePayout = Math.floor(target.minPayout + Math.random() * (target.maxPayout - target.minPayout + 1));

    let outcome, payoutPool;
    if (ratio >= 1.0) {
        outcome = 'full_success';
        payoutPool = Math.floor(basePayout * heatMultiplier);
    } else if (ratio >= 0.5) {
        outcome = 'partial_success';
        payoutPool = Math.floor(basePayout * heatMultiplier * 0.5);
    } else {
        outcome = 'failure';
        payoutPool = 0;
    }

    const perPlayer = (passedCount > 0 && payoutPool > 0) ? Math.floor(payoutPool / passedCount) : 0;
    return { outcome, payout: payoutPool, perPlayer, passedCount, totalCount: total };
}

module.exports = {
    activeSyndicateHeists,
    SYNDICATE_TARGETS,
    SYNDICATE_ROLES,
    createSyndicateLobby,
    joinSyndicateLobby,
    endSyndicateLobby,
    clearSyndicateHeist,
    getSyndicateHeist,
    getEffectiveHeat,
    computeSyndicateOutcome,
};
