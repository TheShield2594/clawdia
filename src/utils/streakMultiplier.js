const MULTIPLIER_LADDER = [
    { days: 100, multiplier: 2.0  },
    { days:  60, multiplier: 1.75 },
    { days:  30, multiplier: 1.5  },
    { days:  14, multiplier: 1.2  },
    { days:   7, multiplier: 1.1  },
];

const MILESTONES = [
    { days:   7, coins:    500, badge: 'Week Warrior'   },
    { days:  30, coins:  2_000, badge: 'Monthly Master' },
    { days: 100, coins: 10_000, badge: 'Centurion'      },
];

function getStreakMultiplier(streakDays) {
    for (const entry of MULTIPLIER_LADDER) {
        if (streakDays >= entry.days) return entry.multiplier;
    }
    return 1.0;
}

// Next multiplier tier from the ladder (for display in /streak)
function getNextMultiplierTier(streakDays) {
    return [...MULTIPLIER_LADDER].reverse().find(e => e.days > streakDays) ?? null;
}

// Next coin+badge milestone
function getNextMilestone(streakDays) {
    return MILESTONES.find(m => m.days > streakDays) ?? null;
}

// Returns milestones the user just became eligible for and hasn't claimed yet
function checkNewMilestones(user) {
    const streak  = user.streak?.current ?? 0;
    const claimed = new Set(user.streak?.claimedMilestones ?? []);
    return MILESTONES.filter(m => streak >= m.days && !claimed.has(m.days));
}

module.exports = { getStreakMultiplier, getNextMultiplierTier, getNextMilestone, checkNewMilestones, MILESTONES };
