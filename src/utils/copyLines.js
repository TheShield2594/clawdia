const { securePick } = require('./secureRandom');

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

// Per-crime narrative lines: success and failure, indexed by crime.name
const CRIME_NARRATIVE = {
    'pickpocketing': {
        win: [
            'You brushed past them on the escalator. Wallet? Gone. They\'re still looking for their floor. 🎩',
            'Three seconds. That\'s all it took. They\'ll blame it on the subway.',
            'Smooth hands, smoother exit. They\'ll notice at checkout — you\'ll be long gone.',
            'You were practically invisible. The crowd did the rest.',
            'A nudge, a lift, a walk. Textbook.',
        ],
        fail: [
            'You reached for their pocket and grabbed... their hand. They stared at you for a very long time.',
            'Your fingers slipped. They turned around. You pretended to sneeze for 40 seconds. 😬',
            'Rookie move — you went for the back pocket. Always the front pocket. Always.',
            'They felt it. You froze. The whole bus saw.',
            'You picked the one person on the street with a security lanyard and a bad day.',
        ],
    },
    'selling fake merch': {
        win: [
            'The fake watches sold out in an hour. You packed up before anyone looked closely. 🕶️',
            'Limited edition? Sure. You had a printer. They had hope.',
            'You set up on a corner, made your pitch, and vanished before the refund requests came in.',
            'Three tourists, four sales, one very convincing accent. Clean.',
            'The booth looked legit. You were not. They\'ll never know the difference.',
        ],
        fail: [
            'A customer came back with a receipt *and* a cop. You were still at the table.',
            'The merch fell apart on the spot. Right in front of them. In front of everyone.',
            'Someone recognized the brand logo was backwards. You really should\'ve double-checked. 😬',
            'Consumer protection officer. Right there. Who even has those on speed dial?',
            'They asked for proof of authenticity. You didn\'t have any. The conversation ended poorly.',
        ],
    },
    'hacking ATMs': {
        win: [
            'The ATM blinked twice, dispensed, and you were already across the street. 💻',
            'Thirty seconds on the keypad and the machine became very cooperative.',
            'In, out, no trace. The bank\'s logs will show a glitch. Glitches happen.',
            'You\'ve done this before. It shows. Clean extraction.',
            'The machine didn\'t even flinch. Neither did you.',
        ],
        fail: [
            'The machine locked up and called home. You didn\'t notice until the blue lights arrived.',
            'Your script had a typo. A single typo. The ATM laughed at you — metaphorically.',
            'Camera. Right above the keypad. There\'s always a camera.',
            'The bank patched that exploit last Tuesday. You had not been informed.',
            'The error code it spit out had your IP address in it. Somehow.',
        ],
    },
    'art forgery': {
        win: [
            'The buyer didn\'t even bring a blacklight. Amateur. 🖼️',
            'Your brushwork was flawless. Frankly, the original wasn\'t this clean.',
            'Sold at auction under a pseudonym. No one asked questions. Nobody ever does.',
            'The provenance paperwork you forged was better than the real thing.',
            'The collector smiled, signed, and handed you a check. Easiest **{amount}** coins you ever made.',
        ],
        fail: [
            'The buyer brought an expert. An actual expert. The painting started crying.',
            'The ink was still wet when they picked it up. Not ideal for a "17th century masterpiece."',
            'Someone recognized the canvas brand. From a craft store. A current craft store. 😬',
            'The signature was backwards. You painted in a mirror. It was a long afternoon.',
            'The frame was antique. The paint was not.',
        ],
    },
    'casino cheating': {
        win: [
            'The dealer never saw the switch. The cameras were pointed the wrong way. 🎰',
            'Marked cards. A very subtle system. A very large payout.',
            'You counted every card since deck two. Nobody noticed. Beautiful.',
            'The chip swap happened in plain sight. That\'s the point. It worked.',
            'Walked out with **{amount}** coins and the calm of someone who knows exactly what they did.',
        ],
        fail: [
            'The pit boss had been watching for twenty minutes before you realized. 🚔',
            'They switched decks mid-hand. Your whole system evaporated.',
            'The chip you palmed had a tracker in it. That\'s new.',
            'Someone at your table was also cheating — and they spotted you first.',
            'Camera. Corner. Ceiling. You were on it the whole time.',
        ],
    },
    'grand larceny': {
        win: [
            'The vault door swung open at 3:47 AM. The guards were asleep. You weren\'t. 💰',
            'Four years of planning. Two minutes of execution. Clean.',
            'The laser grid was disabled, the alarm was spoofed, and you were already in the car.',
            'They had no idea until Monday morning. You were in another city by then.',
            'The score was everything they said it would be. No witnesses.',
        ],
        fail: [
            'It was going perfectly until it wasn\'t. You\'re explaining this to your lawyer. 🚔',
            'The inside man got cold feet. Thirty seconds in. Of all the moments.',
            'Motion sensor. Brand new. Installed yesterday. Of course.',
            'Your getaway driver misread the time zone. You waited eleven minutes in the open.',
            'The building had a backup vault. And a backup alarm. And backup guards.',
        ],
    },
};

// Critical failures — the 💀 outcome, which takes a share of the wallet. The
// ordinary bust lines are too light for it: "you pretended to sneeze for 40
// seconds" does not belong over a quarter of someone's coins.
const CRIME_CRIT_LINES = {
    'pickpocketing': [
        'The mark was a plainclothes detective. So was the mark\'s friend. So, it turns out, was the friend\'s friend.',
        'You lifted the wallet clean — straight into a sting operation with three cameras and a very patient sergeant.',
        'They grabbed your wrist, then your collar, then your whole afternoon. Your own wallet went into evidence.',
    ],
    'selling fake merch': [
        'The brand\'s legal team was on vacation in this exact city. They were not in a vacation mood.',
        'Customs, trading standards and one furious influencer, all at once. They seized the stock and then some.',
        'Your supplier flipped, the stall got raided, and the fines came itemised.',
    ],
    'hacking ATMs': [
        'The machine was a honeypot. It had been waiting for someone exactly like you.',
        'The bank traced the exploit in minutes and your accounts in seconds. Frozen, then drained.',
        'The ATM filmed you, fingerprinted you and emailed your photo to every branch in the city.',
    ],
    'art forgery': [
        'The buyer was an Interpol art-crimes agent with a UV torch and a warrant. The canvas lit up like a confession.',
        'The auction house authenticated it live, on stream. Four thousand people watched it come apart.',
        'The "collector" turned out to be the artist\'s estate. Their lawyers do not take payment plans.',
    ],
    'casino cheating': [
        'The pit boss didn\'t call the police. He called the owner. The owner called in the debt.',
        'Security walked you to a back room with no cameras and a very thorough accountant.',
        'Every chip you touched tonight got confiscated — and several you didn\'t.',
    ],
    'grand larceny': [
        'The vault was empty. The room around it was full — of tactical officers.',
        'Your crew sold you out before you reached the door. The bill for the lawyers arrived before you did.',
        'Silent alarm, sealed exits, and a negotiator who already knew your name.',
    ],
};

// The reveal between choosing an approach and seeing the result: a setup beat
// for the job, then a complication that could go either way. Neither says how
// it ends — the result does that.
const CRIME_BEATS = {
    'pickpocketing':      { setup: ['You drift into the crowd.', 'You match the mark\'s pace, two steps behind.', 'The platform fills up. Perfect.'] },
    'selling fake merch': { setup: ['You flip the table open and lay out the goods.', 'The first customer is already reaching for a wallet.', 'You start the pitch.'] },
    'hacking ATMs':       { setup: ['You plug in and the terminal blinks awake.', 'Handshake accepted. You\'re in the network.', 'The keypad glows under your gloves.'] },
    'art forgery':        { setup: ['The buyer leans in toward the canvas.', 'You set the painting on the easel under gallery lights.', 'The paperwork slides across the table.'] },
    'casino cheating':    { setup: ['You take your seat. The dealer shuffles.', 'The chips stack up in front of you.', 'You catch the dealer\'s eye. Nothing. Good.'] },
    'grand larceny':      { setup: ['The van rolls to a stop outside the vault.', 'The crew goes quiet. Earpieces on.', 'You check your watch. 3:46 AM.'] },
};

const CRIME_TENSION_LINES = [
    'Footsteps. Getting closer.',
    'Someone is watching. Maybe.',
    'A radio crackles somewhere nearby.',
    'Your pulse is louder than the room.',
    'A door opens that should have stayed shut.',
    'Now or never.',
];

// Returns per-crime narrative flavor text or falls back to generic lines.
// Drawn from the shared CSPRNG like every other /crime roll, so the command
// has one random source (and one test seam) rather than two.
function getCrimeFlavorText(crimeName, outcome) {
    if (outcome === 'crit') {
        const crit = CRIME_CRIT_LINES[crimeName];
        if (crit?.length) return securePick(crit);
        outcome = 'fail';
    }
    const lines = CRIME_NARRATIVE[crimeName]?.[outcome];
    if (!lines?.length) return securePick(outcome === 'win' ? CRIME_WIN_LINES : CRIME_BUST_LINES);
    return securePick(lines);
}

// The two suspense beats for a job: its setup, then a complication.
function getCrimeBeats(crimeName) {
    const setup = CRIME_BEATS[crimeName]?.setup;
    return {
        setup: setup?.length ? securePick(setup) : 'You get into position.',
        tension: securePick(CRIME_TENSION_LINES),
    };
}

const SLOTS_LOSE_LINES = [
    'The reels had other plans.',
    'So close. Or maybe not close at all.',
    'The machine takes. That\'s its whole thing.',
    'Tough spin. The jackpot pool grows.',
    'Not this time. Try again?',
    'Nothing on the line.',
    'The reels kept their secrets.',
    'Cold spin. The meter\'s still climbing.',
];

const SLOTS_WIN_LINES = [
    'There it is.',
    'The reels came through.',
    'Luck decided to show up today.',
    'Clean hit.',
    'The machine blinked first.',
    'Right on the line.',
];

// For a win of 10× the stake or more, where the ordinary lines undersell it.
const SLOTS_BIG_WIN_LINES = [
    'The whole row lit up.',
    'That\'s the one they talk about.',
    'The machine is going to need a minute.',
    'Somebody check the reels — that can\'t be legal.',
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
    CRIME_NARRATIVE,
    CRIME_CRIT_LINES,
    CRIME_BEATS,
    getCrimeFlavorText,
    getCrimeBeats,
    SLOTS_LOSE_LINES,
    SLOTS_WIN_LINES,
    SLOTS_BIG_WIN_LINES,
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
