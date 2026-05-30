function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

const CRIME_WIN_LINES = [
    'Clean getaway. Nobody saw a thing.',
    'In and out. That\'s how pros do it.',
    'You made it look effortless. It wasn\'t.',
    'Another score. The heat hasn\'t found you yet.',
    'Slipped right through their fingers.',
];

const CRIME_BUST_LINES = [
    'You almost had it.',
    'The plan was perfect. The execution wasn\'t.',
    'They were waiting for you.',
    'Next time, maybe don\'t whistle while you work.',
    'Everyone gets caught eventually. Today was your day.',
];

const SLOTS_LOSE_LINES = [
    'The reels had other plans.',
    'So close. Or maybe not close at all.',
    'The machine takes. That\'s its whole thing.',
    'Tough spin. The jackpot pool grows.',
    'Not this time. Try again?',
];

const SLOTS_WIN_LINES = [
    'There it is.',
    'The reels came through.',
    'Luck decided to show up today.',
];

const WORK_ROUGH_LINES = [
    'You showed up. That counts for something.',
    'Not your best work. But it\'s done.',
    'The shift happened. Let\'s leave it at that.',
];

const WORK_EXCEPTIONAL_LINES = [
    'You were unstoppable today. Even the boss noticed.',
    'That\'s the kind of shift people talk about.',
    'Everything clicked. Don\'t question it.',
];

const ROB_WIN_LINES = [
    'They never heard you coming.',
    'Lighter wallet, heavier conscience.',
    'Quick hands. Quicker exit.',
];

const ROB_FAIL_LINES = [
    'They were ready for you.',
    'The target had backup. You didn\'t.',
    'Next time, scout the target first.',
    'The dog gave you up — barked the whole block awake.',
    'Floodlights. Sirens. And you standing there.',
    'Security footage doesn\'t lie. Neither does your mugshot.',
    'You got three steps in before the alarm tripped.',
    'They must have known you were coming.',
    'You froze. That was your one window.',
    'Neighborhood watch, meet neighborhood criminal.',
];

const BJ_WIN_LINES = [
    'The cards lined up. You cashed in.',
    'Dealer couldn\'t touch you.',
    'Read the table right. Walked away richer.',
    'Clean win. No drama.',
];

const BJ_LOSE_LINES = [
    'The house always has an edge. Today it used it.',
    'Close, but close doesn\'t pay.',
    'Dealer held. You didn\'t.',
    'That one stings. There\'s always another hand.',
];

const BJ_BUST_LINES = [
    'Went over. The house collects.',
    'One card too many.',
    'Greed is a dealer too.',
    'You pushed your luck past 21.',
];

const BJ_PUSH_LINES = [
    'A draw. No one wins, no one loses.',
    'Dead even. Bet returned.',
    'Tied up. The table shrugs.',
];

const HUNT_EMPTY_LINES = [
    'The trail went cold.',
    'A branch snapped — and it was gone.',
    'You found tracks. The animal found an exit.',
    'The forest was quiet. Too quiet.',
    'You waited. Nothing moved.',
];

const FISH_MISS_POOL = [
    'The line went slack. Whatever it was, it\'s gone.',
    'Something was there. Now it\'s not.',
    'You reeled in nothing but patience.',
    'The water gives back nothing today.',
    'Just weed and silence.',
];

const MINE_CAVE_LINES = [
    'The ceiling groaned. Then it gave.',
    'Too deep, too fast — the shaft collapsed.',
    'Rock and dust. Nothing to show for it.',
    'The walls weren\'t bluffing.',
    'You made it out. Your dignity didn\'t.',
];

module.exports = {
    randomFrom,
    CRIME_WIN_LINES,
    CRIME_BUST_LINES,
    SLOTS_LOSE_LINES,
    SLOTS_WIN_LINES,
    WORK_ROUGH_LINES,
    WORK_EXCEPTIONAL_LINES,
    ROB_WIN_LINES,
    ROB_FAIL_LINES,
    BJ_WIN_LINES,
    BJ_LOSE_LINES,
    BJ_BUST_LINES,
    BJ_PUSH_LINES,
    HUNT_EMPTY_LINES,
    FISH_MISS_POOL,
    MINE_CAVE_LINES,
};
