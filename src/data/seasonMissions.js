// Daily mission template pool for the season pass system

const MISSION_TEMPLATES = [
    {
        id: 'daily_claim',
        description: 'Claim your daily reward',
        target: 1,
        event: 'daily',
        seasonXp: 25,
        coinReward: 100
    },
    {
        id: 'hunt_3',
        description: 'Complete 3 hunts',
        target: 3,
        event: 'hunt',
        seasonXp: 30,
        coinReward: 200
    },
    {
        id: 'hunt_5',
        description: 'Complete 5 hunts',
        target: 5,
        event: 'hunt',
        seasonXp: 45,
        coinReward: 350
    },
    {
        id: 'fish_3',
        description: 'Go fishing 3 times',
        target: 3,
        event: 'fish',
        seasonXp: 30,
        coinReward: 200
    },
    {
        id: 'fish_5',
        description: 'Go fishing 5 times',
        target: 5,
        event: 'fish',
        seasonXp: 45,
        coinReward: 350
    },
    {
        id: 'mine_3',
        description: 'Mine 3 times',
        target: 3,
        event: 'mine',
        seasonXp: 30,
        coinReward: 200
    },
    {
        id: 'mine_5',
        description: 'Mine 5 times',
        target: 5,
        event: 'mine',
        seasonXp: 45,
        coinReward: 350
    },
    {
        id: 'explore_3',
        description: 'Set out on 3 expeditions',
        target: 3,
        event: 'explore',
        seasonXp: 30,
        coinReward: 200
    },
    {
        id: 'explore_5',
        description: 'Set out on 5 expeditions',
        target: 5,
        event: 'explore',
        seasonXp: 45,
        coinReward: 350
    },
    {
        id: 'work_1',
        description: 'Complete a work shift',
        target: 1,
        event: 'work',
        seasonXp: 20,
        coinReward: 150
    },
    {
        id: 'work_3',
        description: 'Complete 3 work shifts',
        target: 3,
        event: 'work',
        seasonXp: 35,
        coinReward: 300
    },
    {
        id: 'duel_win_1',
        description: 'Win a duel',
        target: 1,
        event: 'duel_win',
        seasonXp: 50,
        coinReward: 500
    },
    {
        id: 'casino_5',
        description: 'Play 5 casino games',
        target: 5,
        event: 'casino',
        seasonXp: 30,
        coinReward: 300
    },
    {
        id: 'crime_1',
        description: 'Attempt a crime',
        target: 1,
        event: 'crime',
        seasonXp: 25,
        coinReward: 150
    },
    {
        id: 'quiz_1',
        description: 'Answer a quiz question',
        target: 1,
        event: 'quiz',
        seasonXp: 20,
        coinReward: 100
    },
    {
        id: 'quiz_3',
        description: 'Answer 3 quiz questions',
        target: 3,
        event: 'quiz',
        seasonXp: 35,
        coinReward: 250
    }
];

/**
 * Pick 3 random distinct missions for a given date.
 * Uses the date string as a seed basis to keep missions consistent per day per server
 * (not truly seeded here — just random selection at generation time).
 */
function generateDailyMissions() {
    const pool = [...MISSION_TEMPLATES];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 3).map(t => ({
        id: t.id,
        description: t.description,
        target: t.target,
        event: t.event,
        seasonXp: t.seasonXp,
        coinReward: t.coinReward,
        progress: 0,
        completed: false,
        claimed: false
    }));
}

module.exports = { MISSION_TEMPLATES, generateDailyMissions };
