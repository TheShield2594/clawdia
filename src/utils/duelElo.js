// Ranked duel ELO helpers (issue #339)

const RANK_TIERS = [
    { id: 'bronze',    label: 'Bronze',    icon: '🥉', min: 0,    max: 1099 },
    { id: 'silver',    label: 'Silver',    icon: '🥈', min: 1100, max: 1299 },
    { id: 'gold',      label: 'Gold',      icon: '🥇', min: 1300, max: 1499 },
    { id: 'platinum',  label: 'Platinum',  icon: '💎', min: 1500, max: 1699 },
    { id: 'diamond',   label: 'Diamond',   icon: '💠', min: 1700, max: 1899 },
    { id: 'champion',  label: 'Champion',  icon: '👑', min: 1900, max: Infinity },
];

const START_ELO = 1000;
const SOFT_RESET_TARGET = 1200;
const SOFT_RESET_PULL   = 0.5;  // decay halfway toward the target

function tierFor(elo) {
    const n = Number(elo) || 0;
    return RANK_TIERS.find(t => n >= t.min && n <= t.max) || RANK_TIERS[0];
}

// Standard ELO expected score
function expectedScore(rA, rB) {
    return 1 / (1 + 10 ** ((rB - rA) / 400));
}

// Returns { winnerNewElo, loserNewElo, winnerDelta, loserDelta }
function applyElo(winnerElo, loserElo, kFactor = 32) {
    const eW = expectedScore(winnerElo, loserElo);
    const eL = 1 - eW;
    const winnerDelta = Math.round(kFactor * (1 - eW));
    const loserDelta  = Math.round(kFactor * (0 - eL));
    return {
        winnerNewElo: winnerElo + winnerDelta,
        loserNewElo:  Math.max(0, loserElo + loserDelta),
        winnerDelta,
        loserDelta,
    };
}

// Decays an ELO value toward SOFT_RESET_TARGET (used at season end).
function softResetElo(elo) {
    return Math.round(elo + (SOFT_RESET_TARGET - elo) * SOFT_RESET_PULL);
}

// Generate a deterministic season id like "S3"
function makeSeasonId(seasonNumber) {
    return `S${seasonNumber}`;
}

module.exports = {
    RANK_TIERS,
    START_ELO,
    SOFT_RESET_TARGET,
    tierFor,
    expectedScore,
    applyElo,
    softResetElo,
    makeSeasonId,
};
