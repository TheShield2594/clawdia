const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { hasEffect, spendEffectCharge } = require('../../services/effectsService');
const { getMerchantCoinBonus } = require('../../services/synergyService');
const { advanceMissions } = require('../../services/seasonMissionService');
const { attachGrind } = require('../../utils/grindProfile');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { clampMultiplier } = require('../../config/economy');
const { logTransaction } = require('../../utils/logTransaction');
const { debitUpTo, incExpr } = require('../../utils/balanceDebit');
const { creditCoinsOrOwe } = require('../../utils/creditOrOwe');
const { crimePayoutKey } = require('../../utils/payoutKey');
const { getTotalBonus } = require('../../services/petService');
const { getCrimeFlavorText, getCrimeBeats } = require('../../utils/copyLines');
const { stackBar } = require('../../utils/rewardReveal');
const { delay } = require('../../utils/delay');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { isDistrictActive } = require('../../services/districtService');
// Crime payouts feed the big-win log, so every roll below draws from the shared
// CSPRNG rather than Math.random (CodeQL js/insecure-randomness).
const { secureRandom } = require('../../utils/secureRandom');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');
const Reminder = require('../../models/Reminder');
const { MAX_OPEN_REMINDERS } = require('../../utils/reminderLimits');

const COOLDOWN_MS    = 1.5 * 3_600_000; // 1.5 hours
const DEATH_RATE     = 0.08;            // 8% of failures trigger critical death
const DEATH_LOSS_MIN = 0.15;
const DEATH_LOSS_MAX = 0.30;
// A critical failure seizes a share of the wallet, but never more than this
// many of the approach's worst fine — and never less than an ordinary bust
// would have cost. Uncapped, it was 300k off a 1M wallet over a job worth
// ~1.5k, a loss only players who had not found /bank ever paid.
const CRIT_CAP_FINES = 2;
// A fine the wallet cannot cover is served as time instead: the unpaid share
// of it, scaled onto this, is added to the lockout. Without it an empty
// wallet made every failure free and the loudest approach always correct.
const HOLDING_MAX_MS = 1.5 * 3_600_000;
// Standing heat. Every loud job — landed or not — draws attention (+1), every
// careful one lets it settle (−1), and it cools a level every six hours on its
// own. Each level puts 10% on every fine and takes 3% off the loud approach's
// odds. The loud slot is tuned ~25% ahead of standard per attempt at no heat;
// one level about evens it and two put it well behind, so going loud twice in
// a row is a choice with a price and the careful play has a job beyond the
// grind. (Fines alone could not do this: they rise for every approach, and at
// five levels loud was still ahead.)
const HEAT_MAX          = 5;
const HEAT_FINE_STEP    = 0.10;
const HEAT_LOUD_PENALTY = 0.03;
const HEAT_DECAY_MS     = 6 * 3_600_000;

// Balance. Every crime is tuned so its standard approach
// averages more per attempt than the tier below it, the safe approach about
// the same as standard with less swing, and the loud one ~25% more per
// attempt — which its heat on failure roughly gives back per hour. Rates for
// the other two approaches were solved against those targets from the
// shared multipliers in APPROACH, so that the three slots read the same
// on every job. tests/economyCrimeCommand.test.js holds the targets.
const CRIMES = [
    { name: 'pickpocketing',      displayName: 'Quick Snatch',  emoji: '🤏', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        successRate: 0.62, minPayout: 80,   maxPayout: 200,  minFine: 40,  maxFine: 85  },
    { name: 'selling fake merch', displayName: 'Street Hustle', emoji: '🛍️', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        successRate: 0.56, minPayout: 100,  maxPayout: 300,  minFine: 50,  maxFine: 100 },
    { name: 'hacking ATMs',       displayName: 'ATM Ghost',     emoji: '💻', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', successRate: 0.50, minPayout: 200,  maxPayout: 500,  minFine: 95,  maxFine: 190 },
    { name: 'art forgery',        displayName: 'The Forgery',   emoji: '🖼️', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', successRate: 0.45, minPayout: 300,  maxPayout: 700,  minFine: 110, maxFine: 225 },
    { name: 'casino cheating',    displayName: 'Casino Con',    emoji: '🎰', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       successRate: 0.40, minPayout: 400,  maxPayout: 1000, minFine: 125, maxFine: 255 },
    { name: 'grand larceny',      displayName: 'The Score',     emoji: '💎', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       successRate: 0.35, minPayout: 600,  maxPayout: 1500, minFine: 160, maxFine: 320 },
];

// The three slots every job offers. Only the success rate and the heat vary
// by job; the payout and fine multipliers are the same everywhere, so ×0.75
// always means the careful play and ×1.8 the loud one.
const APPROACH = {
    safe:     { payoutMult: 0.75, fineMult: 0.75 },
    standard: { payoutMult: 1.00, fineMult: 1.00 },
    loud:     { payoutMult: 1.80, fineMult: 1.40 },
};

// Per-crime execution method choices presented in Step 2.
// successRate: absolute rate
// payoutMult:  multiplier applied to base payout on success
// payoutRange: wildcard only — the multiplier runs from [0] to [1] with how
//              cleanly the job lands, averaging the loud slot's payoutMult
// fineMult:    multiplier applied to fine on regular bust
// wantedMs:    if > 0, sets wantedUntil = crimeTime + wantedMs on bust (must exceed COOLDOWN_MS to add extra penalty)
const EXECUTION_METHODS = {
    'pickpocketing': {
        situation: "You've spotted a mark in the crowd. How do you play it?",
        methods: [
            { id: 'feather_touch', label: '🤏 Feather touch', desc: 'Patient, near-invisible grab', successRate: 0.70, ...APPROACH.safe,     wantedMs: 0 },
            { id: 'quick_snatch',  label: '🏃 Quick snatch',  desc: 'Fast and practiced',           successRate: 0.62, ...APPROACH.standard, wantedMs: 0 },
            { id: 'bold_grab',     label: '🎰 Bold grab',     desc: 'Loud exit, big cut',           successRate: 0.50, ...APPROACH.loud,     wantedMs: 2 * 3_600_000 },
        ],
    },
    'selling fake merch': {
        situation: "You've got the goods. How do you move them?",
        methods: [
            { id: 'tourist_trap',    label: '🏪 Tourist trap',    desc: 'Steady foot traffic, lower cut', successRate: 0.63, ...APPROACH.safe,     wantedMs: 0 },
            { id: 'hard_sell',       label: '🎤 Hard sell',       desc: 'The usual pitch',                successRate: 0.56, ...APPROACH.standard, wantedMs: 0 },
            { id: 'wholesale_blitz', label: '📦 Wholesale blitz', desc: 'Bulk push, heat follows',        successRate: 0.44, ...APPROACH.loud,     wantedMs: 2 * 3_600_000 },
        ],
    },
    'hacking ATMs': {
        situation: "You're connected to the network. How do you drain it?",
        methods: [
            { id: 'skimmer',     label: '💳 Skimmer',     desc: 'Install quietly, harvest slowly', successRate: 0.55, ...APPROACH.safe,     wantedMs: 0 },
            { id: 'remote_hack', label: '💻 Remote hack', desc: 'Standard operation',              successRate: 0.50, ...APPROACH.standard, wantedMs: 0 },
            { id: 'zero_day',    label: '⚡ Zero-day',     desc: 'All-or-nothing exploit',          successRate: 0.40, ...APPROACH.loud,     wantedMs: 2.5 * 3_600_000 },
        ],
    },
    'art forgery': {
        situation: "The studio is set. What's your approach?",
        methods: [
            { id: 'minor_piece',  label: '🖌️ Minor piece',  desc: 'Low stakes, clean sale',       successRate: 0.50, ...APPROACH.safe,     wantedMs: 0 },
            { id: 'classic_swap', label: '🖼️ Classic swap', desc: 'A reliable forgery',           successRate: 0.45, ...APPROACH.standard, wantedMs: 0 },
            { id: 'masterpiece',  label: '💎 Masterpiece',  desc: 'High-stakes, all eyes on you', successRate: 0.36, ...APPROACH.loud,     wantedMs: 2.5 * 3_600_000 },
        ],
    },
    'casino cheating': {
        situation: "You're at the table. How do you tip the odds?",
        methods: [
            { id: 'count_cards',  label: '🧮 Count cards',  desc: 'Subtle mathematical edge', successRate: 0.44, ...APPROACH.safe,     wantedMs: 0 },
            { id: 'marked_deck',  label: '🃏 Marked deck',  desc: 'Practiced, balanced risk', successRate: 0.40, ...APPROACH.standard, wantedMs: 0 },
            { id: 'dealer_bribe', label: '💵 Dealer bribe', desc: 'All in — or all busted',   successRate: 0.31, ...APPROACH.loud,     wantedMs: 3 * 3_600_000 },
        ],
    },
    'grand larceny': {
        situation: "You're outside the vault. How do you proceed?",
        methods: [
            { id: 'pick_lock', label: '🔑 Pick the lock',  desc: 'Safer, slower',   successRate: 0.39, ...APPROACH.safe,     wantedMs: 0 },
            { id: 'cut_power', label: '💥 Cut the power',  desc: 'Riskier, faster', successRate: 0.35, ...APPROACH.standard, wantedMs: 0 },
            // The wildcard is loud-slot odds with a swing on the cut: how well
            // the story sells decides the multiplier. It used to draw its
            // *success rate* from 15–75% instead — which, rolled once against
            // a second draw, is exactly a flat 45%: the best odds on the job
            // at the biggest multiplier, worth ~5× any other choice in the game.
            { id: 'bluff_in',  label: '🚨 Bluff your way', desc: 'Wildcard — the better it sells, the bigger the cut', successRate: 0.27, ...APPROACH.loud, payoutRange: [1.0, 2.6], wantedMs: 3 * 3_600_000, wildcard: true },
        ],
    },
};

// What the hour favours. A small edge on the jobs the hour suits, so the band
// the prompt has always shown means something: +5% success, quoted in the
// odds and folded into the roll like any other bonus. The bands are the
// shared UTC ones src/utils/timeBand.js hands every command.
const TIME_EDGE = 0.05;
const TIME_EDGES = {
    Morning: { why: 'the banks just opened',  favours: (c)    => c.name === 'hacking ATMs' || c.name === 'art forgery' },
    Noon:    { why: 'the crowds are thick',   favours: (c)    => c.name === 'pickpocketing' || c.name === 'selling fake merch' },
    Dusk:    { why: 'shift change',           favours: (c, m) => m.wantedMs > 0 },
    Night:   { why: 'cover of dark',          favours: (c, m) => m.payoutMult < 1 },
};

// Heat as it stands now, from the level recorded at `updatedAt` less a level
// per HEAT_DECAY_MS since.
function heatNow(record, now = Date.now()) {
    const level = record?.level ?? 0;
    if (level <= 0 || !record?.updatedAt) return 0;
    const cooled = Math.floor((now - new Date(record.updatedAt).getTime()) / HEAT_DECAY_MS);
    return Math.max(0, Math.min(HEAT_MAX, level - cooled));
}

// What a job does to heat: the loud slot raises it, the careful one lowers it.
const heatDelta = method => (method.wantedMs > 0 ? 1 : method.payoutMult < 1 ? -1 : 0);
const heatMeter = level => `${'🟥'.repeat(level)}${'⬛'.repeat(HEAT_MAX - level)}`;

const timeEdge = (band, crime, method) => (TIME_EDGES[band.label]?.favours(crime, method) ? TIME_EDGE : 0);

const FINES = [
    'You were caught by an undercover officer.',
    'A bystander called the police on you.',
    'Security footage gave you away.',
    'Your partner-in-crime ratted you out.',
    'Your disguise fell off at the worst moment.',
];

const MAX_SUCCESS    = 0.95;
const PICK_WINDOW_MS = 15_000;
const BEAT_MS        = 900;             // each suspense beat before the result
const REMIND_ID      = 'crime_remind';
const REMIND_WINDOW_MS = 5 * 60_000;    // how long the result's Remind me button stays live
const REMINDER_TEXT  = 'Your next `/crime` job is open. 🌆';
const TOP_PAYOUT     = Math.max(...CRIMES.map(c => c.maxPayout));

const pct = rate => `${Math.round(rate * 100)}%`;
const hours = ms => { const h = ms / 3_600_000; return h % 1 === 0 ? `${h}` : h.toFixed(1); };
const relTime = date => `<t:${Math.floor(date.getTime() / 1000)}:R>`;

// Fisher–Yates over the shared CSPRNG. `sort(() => rand - 0.5)` is not a
// uniform shuffle — which orders come out depends on the engine's sort.
function shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(secureRandom() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// The odds a method is really rolled at once every bonus is in — the same sum
// the resolution below uses, so the buttons and the roll cannot disagree.
const methodOdds = (method, bonus) => Math.min(MAX_SUCCESS, method.successRate + bonus);

const payoutLabel = method => (method.payoutRange
    ? `×${method.payoutRange[0]}–${method.payoutRange[1]}`
    : `×${method.payoutMult}`);

/**
 * The payout multiplier a landed job earns. A wildcard's rides the same roll
 * that decided success: how far under the line it came is how cleanly the
 * job went, from the bottom of its range to the top. The roll is uniform
 * below the line, so the multiplier averages the middle of the range.
 */
function landedPayoutMult(method, roll, chance) {
    if (!method.payoutRange) return method.payoutMult;
    const [lo, hi] = method.payoutRange;
    const clean = 1 - roll / chance;
    return Math.round((lo + (hi - lo) * clean) * 100) / 100;
}

/**
 * Resolves to the owner's press, or null when the window closes. Kept apart
 * from acknowledging the press: a `deferUpdate()` that threw (its 3-second
 * window lapsed) used to land in the same catch as the timeout, and the catch
 * replaced the job the player had just picked with a random one.
 */
async function awaitPick(message, userId) {
    try {
        return await message.awaitMessageComponent({
            filter: ownedBy(userId, "This isn't your job."),
            time: PICK_WINDOW_MS,
        });
    } catch {
        return null;
    }
}

const progressBar = (step, of) => `${'▰'.repeat(step)}${'▱'.repeat(of - step)}`;

/**
 * Sets, or moves, the member's "next job is open" reminder through the same
 * Reminder rows /remind writes, so the scheduler that already delivers those
 * delivers this. One per member per server: pressing it again after the next
 * job moves the one they have instead of stacking another.
 *
 * @returns {Promise<boolean>} false when they are at the open-reminder cap
 */
async function setJobReminder({ userId, guildId, channelId }, remindAt) {
    const existing = await Reminder.findOneAndUpdate(
        { userId, guildId, message: REMINDER_TEXT, completed: false },
        { $set: { remindAt, channelId } },
    );
    if (existing) return true;
    const open = await Reminder.countDocuments({ userId, completed: false });
    if (open >= MAX_OPEN_REMINDERS) return false;
    await Reminder.create({ userId, guildId, channelId, message: REMINDER_TEXT, remindAt });
    return true;
}

/**
 * Arms the result's Remind me button. Not awaited: the command is done once
 * the result is up, and the button outlives it for a few minutes. The button
 * comes off when it is used or the window closes, so a stale one is never
 * left on the message.
 */
function armReminderButton(interaction, message, remindAt) {
    const collector = message.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, i => i.customId === REMIND_ID, "That reminder button is for whoever ran the job."),
        time: REMIND_WINDOW_MS,
        max: 1,
    });
    collector.on('collect', async press => {
        try {
            const set = await setJobReminder({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                channelId: interaction.channelId,
            }, remindAt);
            await press.reply({
                content: set
                    ? `🔔 I'll ping you here ${relTime(remindAt)} when your next job opens.`
                    : `You already have ${MAX_OPEN_REMINDERS} open reminders — cancel one with \`/reminders cancel\` first.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            console.error('[crime] reminder error:', err);
            await press.reply({ content: "Couldn't set that reminder — try `/remind` instead.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    });
    collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('crime')
        .setDescription('Choose a crime and attempt it for coins. Higher risk = higher reward. Cooldown: 1.5h.'),

    async execute(interaction) {
        const MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000;
        if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: '❌ Your Discord account must be at least 7 days old to commit crimes.',
                flags: MessageFlags.Ephemeral,
            });
        }
        const guildSettings = await getGuildSettings(interaction.guild.id);
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.crimeEnabled === false) {
            return interaction.reply({ content: 'The crime command is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        // One way to write an amount everywhere in the command. It was
        // "💵 80–200", "💰 Earned: 500 coins", "💰500" and "Balance: 500 coins"
        // depending on which screen you were on.
        const money = n => `${currency} ${Math.round(n).toLocaleString()}`;
        const moneyRange = (a, b) => `${currency} ${Math.round(a).toLocaleString()}–${Math.round(b).toLocaleString()}`;
        const featured = getDailyFeatured(interaction.guild.id);
        const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

        // Atomically claim the cooldown slot up front — lastCrime is set the moment
        // the job starts (not when it resolves ~30s later via the button flow), so
        // two concurrent /crime invocations can't both pass the cooldown check
        // before either one writes back.
        const claimNow = new Date();
        const cooldownFloor = new Date(claimNow.getTime() - COOLDOWN_MS);

        // The row has to exist before the guarded claim below, and it cannot be
        // the same write: an upsert whose filter misses does not answer null,
        // it inserts a document built from the filter's equality terms — and
        // { userId, guildId } is a unique index, so every refusal came back as
        // a duplicate-key error instead of the "Laying Low" embed below (#786).
        // Same two-step shape as /daily and /work.
        await User.findOneAndUpdate(
            userFilter,
            { $setOnInsert: { ...userFilter } },
            { upsert: true, new: true }
        );

        // `new: false` hands back the pre-image: everything below reads the
        // same fields either way, and the lastCrime it carries is what
        // `releaseClaim` restores if the job never gets as far as running.
        const claimed = await User.findOneAndUpdate(
            {
                ...userFilter,
                $and: [
                    { $or: [{ wantedUntil: null }, { wantedUntil: { $lte: claimNow } }] },
                    { $or: [{ lastCrime: null }, { lastCrime: { $lte: cooldownFloor } }] },
                ],
            },
            { $set: { lastCrime: claimNow } },
            { new: false }
        );

        if (!claimed) {
            const fresh = await User.findOne(userFilter);

            if (fresh?.wantedUntil && Date.now() < fresh.wantedUntil.getTime()) {
                const nextAt = new Date(fresh.wantedUntil.getTime());
                return interaction.reply({
                    embeds: [buildCooldownEmbed({
                        title: '🚨 Still Wanted',
                        description: 'The city has eyes on you. Lay low. 🚨\nDon\'t even think about running another job until the heat breaks.',
                        color: '#e74c3c',
                        nextAt,
                        nextRewardPreview: `Once clear: today's featured job is ${featured.crime.emoji} ${featured.crime.displayName} — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout`,
                    })],
                    flags: MessageFlags.Ephemeral,
                });
            }

            const nextAt = new Date((fresh?.lastCrime?.getTime() ?? Date.now()) + COOLDOWN_MS);
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🌆 Laying Low',
                    description: "You're still on the radar from last time.\nLie low. Let the heat fade.",
                    color: '#f39c12',
                    nextAt,
                    nextRewardPreview: `Next run: three new crimes roll — pick the right one for up to ${TOP_PAYOUT.toLocaleString()} coins before bonuses`,
                })],
                flags: MessageFlags.Ephemeral,
            });
        }

        const user = claimed;

        // Gives the slot back when the job never ran — a reply that failed, a
        // message deleted mid-prompt. Guarded on this claim's own timestamp so
        // it can never undo a claim made after it.
        const releaseClaim = () => User.updateOne(
            { ...userFilter, lastCrime: claimNow },
            { $set: { lastCrime: user.lastCrime ?? null } },
        ).catch(err => console.error('[crime] cooldown release failed:', err));

        // Flips the moment the first write that settles the job is sent. Before
        // it, a failure costs the player nothing and the slot goes back; after
        // it, coins may have moved and the job stands.
        let settled = false;

        try {
            // ── Odds ────────────────────────────────────────────────────────────
            // Every bonus the roll will use, gathered before anything is shown
            // so the prompts quote the odds the player is really rolling at.
            const crimeXp = user.crimeRecord?.totalCrimes ?? 0;
            const masteryBonus = Math.min(0.15, crimeXp * 0.001);
            // Black Market Contract: +5% per permanent stack (max 3 stacks = +15%)
            const contractBonus = (user.crimeContractStacks ?? 0) * 0.05;
            const luckyActive = hasEffect(user, 'lucky_charm');
            const luckyBonus = luckyActive ? 0.20 : 0;
            const petCrimeBonus = getTotalBonus(user.pets || [], 'crime_success') / 100;
            const oddsBonus = masteryBonus + contractBonus + luckyBonus + petCrimeBonus;

            // Standing heat puts a share on every fine this job could bring.
            const heat = heatNow(user.crimeHeat, claimNow.getTime());
            const heatMult = 1 + heat * HEAT_FINE_STEP;
            const heatLine = heat > 0
                ? `\n> 🌡️ *Heat ${heatMeter(heat)} ${heat}/${HEAT_MAX} — fines +${pct(heat * HEAT_FINE_STEP)}, loud jobs −${pct(heat * HEAT_LOUD_PENALTY)}. Careful jobs cool it.*`
                : '';

            const bonusParts = [
                masteryBonus > 0 && `🏆 mastery +${pct(masteryBonus)}`,
                contractBonus > 0 && `📜 contracts +${pct(contractBonus)}`,
                luckyBonus > 0 && `🍀 Lucky Charm +${pct(luckyBonus)}`,
                petCrimeBonus > 0 && `🐾 pet +${pct(petCrimeBonus)}`,
            ].filter(Boolean);
            const bonusLine = bonusParts.length
                ? `\n\n> 🎯 *Odds include ${bonusParts.join(' · ')}*`
                : '';

            // ── Step 1: Choose the crime ────────────────────────────────────────
            // A live countdown rather than "15 seconds" in a footer that was
            // already stale by the time anyone read it.
            const pickDeadline = () => relTime(new Date(Date.now() + PICK_WINDOW_MS));
            // Step 1 quotes each job at its standard approach.
            const standardOf = c => EXECUTION_METHODS[c.name].methods[1];
            // The player's own hour when they have told /timezone what it is —
            // the edge below is real odds now, and "Night" at noon their time
            // would be a lie.
            const timeBand = getTimeBand(user.timezone);

            const choices = shuffle(CRIMES).slice(0, 3);
            if (!choices.some(c => c.name === featured.crime.name)) {
                choices[Math.floor(secureRandom() * 3)] = CRIMES.find(c => c.name === featured.crime.name) ?? choices[0];
            }

            const row = new ActionRowBuilder().addComponents(
                choices.map(c => {
                    const isFeatured = c.name === featured.crime.name;
                    return new ButtonBuilder()
                        .setCustomId(c.name)
                        .setLabel(`${isFeatured ? '🌟 ' : ''}${c.emoji} ${c.displayName}  ·  ${c.riskEmoji}`)
                        .setStyle(isFeatured ? ButtonStyle.Primary : ButtonStyle.Secondary);
                })
            );

            const crimeLines = choices.map(c => {
                const isFeatured = c.name === featured.crime.name;
                const featuredTag = isFeatured ? `\n  🌟 **FEATURED** — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout bonus!` : '';
                return (
                    `**${isFeatured ? '🌟 ' : ''}${c.emoji} ${c.displayName}** ${c.riskEmoji}\n` +
                    `${c.riskLabel}\n` +
                    `🎯 ${pct(methodOdds(standardOf(c), oddsBonus + timeEdge(timeBand, c, standardOf(c))))} success · pays ${moneyRange(c.minPayout, c.maxPayout)} · fine ${moneyRange(c.minFine * heatMult, c.maxFine * heatMult)}` +
                    (timeEdge(timeBand, c, standardOf(c)) ? ` · ${timeBand.emoji} +${pct(TIME_EDGE)}` : '') +
                    featuredTag
                );
            }).join('\n\n');

            const selectionEmbed = new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle('🌆 Tonight\'s Jobs')
                .setDescription(`Three options on the table. Pick your play — or let the clock decide.\n\n${crimeLines}${bonusLine}${heatLine}\n\n⏳ Decide ${pickDeadline()}`)
                .setFooter({ text: `${timeBand.emoji} ${timeBand.label}${timeBand.local ? '' : ' (UTC — /timezone set for yours)'} · No pick and the clock chooses.` })
                .setTimestamp();

            const response = await interaction.reply({ embeds: [selectionEmbed], components: [row], withResponse: true });
            const message = response?.resource?.message ?? await interaction.fetchReply();

            const crimePress = await awaitPick(message, interaction.user.id);
            const crime = (crimePress && CRIMES.find(c => c.name === crimePress.customId))
                ?? choices[Math.floor(secureRandom() * choices.length)];
            if (crimePress) await crimePress.deferUpdate().catch(() => {});

            // ── Step 2: Choose the execution method ────────────────────────────
            const execData = EXECUTION_METHODS[crime.name];
            // The clock picking for them used to be silent: the next screen
            // simply named a job they had not chosen.
            const hesitated = crimePress
                ? ''
                : `⏳ *You hesitated — the crew picked **${crime.displayName}** for you.*\n\n`;

            const loudPenalty = m => (m.wantedMs > 0 ? heat * HEAT_LOUD_PENALTY : 0);
            const odds = m => methodOdds(m, oddsBonus + timeEdge(timeBand, crime, m) - loudPenalty(m));
            const edgeLine = execData.methods.some(m => timeEdge(timeBand, crime, m))
                ? `\n> ${timeBand.emoji} *${timeBand.label} — ${TIME_EDGES[timeBand.label].why}: +${pct(TIME_EDGE)} on the marked approach*`
                : '';

            const execMethodLines = execData.methods.map(m => {
                const edgeMark = timeEdge(timeBand, crime, m) ? ` ${timeBand.emoji}` : '';
                const rateStr = `${pct(odds(m))}${edgeMark}`;
                const payoutStr = m.payoutRange || m.payoutMult !== 1.0 ? ` · ${payoutLabel(m)} payout` : '';
                const fineStr = ` · fine ${moneyRange(crime.minFine * m.fineMult * heatMult, crime.maxFine * m.fineMult * heatMult)}`;
                const delta = heatDelta(m);
                const heatStr = delta > 0 ? ' · 🌡️ +1 heat' : delta < 0 && heat > 0 ? ' · ❄️ −1 heat' : '';
                const wantedStr = m.wantedMs > 0 ? ` · 🔥 ${hours(m.wantedMs)}h heat on fail` : '';
                return `**${m.label}** — ${m.desc}\n🎯 ${rateStr} success${payoutStr}${fineStr}${wantedStr}${heatStr}`;
            }).join('\n\n');

            const execEmbed = new EmbedBuilder()
                .setColor('#e67e22')
                .setTitle(`${crime.emoji} ${crime.displayName} — Choose Your Approach`)
                .setDescription(`${hesitated}🎯 ${execData.situation}\n\n${execMethodLines}${bonusLine}${edgeLine}${heatLine}\n\n⏳ Decide ${pickDeadline()}`)
                .setFooter({ text: 'No pick and you play it safe.' })
                .setTimestamp();

            const execRow = new ActionRowBuilder().addComponents(
                execData.methods.map(m => new ButtonBuilder()
                    .setCustomId(`exec_${m.id}`)
                    .setLabel(`${m.label}  ·  ${pct(odds(m))}`)
                    .setStyle(ButtonStyle.Secondary))
            );

            await interaction.editReply({ embeds: [execEmbed], components: [execRow] });

            const execPress = await awaitPick(message, interaction.user.id);
            // A player who stepped away gets the careful play. Picking at random
            // handed them heat on a loud approach they never chose.
            const execMethod = (execPress && execData.methods.find(m => `exec_${m.id}` === execPress.customId))
                ?? execData.methods[0];
            if (execPress) await execPress.deferUpdate().catch(() => {});

            // Synergy requirements read hunt/fishing/mining levels, and those live in
            // GrindProfile — absent from a bare User document, so the Merchant bonus
            // on the payout below would silently never fire. Read here rather than
            // before the first reply, which has three seconds to go out.
            await attachGrind(user, ['hunt', 'fishing', 'mining']);

            // ── Resolve the crime ───────────────────────────────────────────────
            const hourEdge = timeEdge(timeBand, crime, execMethod);
            const successChance = odds(execMethod);
            const successRoll = secureRandom();
            const success = successRoll < successChance;
            const crimeTime = new Date();

            const streakMult = clampMultiplier(getStreakMultiplier(user.streak?.current ?? 0));

            // How cleanly a landed job went, 0–1 — the same measure the
            // wildcard's cut rides on, shown as how much of the story sold.
            const clean = success ? 1 - successRoll / successChance : 0;
            const bluffStr = execMethod.wildcard
                ? (success
                    ? `\n> 🎲 *They bought ${Math.round(50 + 50 * clean)}% of your story.*`
                    : '\n> 🎲 *They didn\'t buy a word of it.*')
                : '';

            // The career line every result carries. Every settled outcome counts
            // an attempt, so this is the record after this job.
            const attempts = (user.crimeRecord?.totalCrimes ?? 0) + 1;
            const cleanJobs = (user.crimeRecord?.successfulCrimes ?? 0) + (success ? 1 : 0);
            const MASTERY_CAP = 150;
            // Heat after this job. Anchored so that part-way progress toward the
            // next level of cooling is kept — a careful job should not cost the
            // player the hours they had already waited out.
            const newHeat = Math.max(0, Math.min(HEAT_MAX, heat + heatDelta(execMethod)));
            const heatStatus = newHeat > 0 || heat > 0
                ? `\n🌡️ Heat ${heatMeter(newHeat)} ${newHeat}/${HEAT_MAX}${newHeat > heat ? ' ▲' : newHeat < heat ? ' ▼' : ''}`
                : '';

            const careerField = {
                name: '📒 Record',
                value: `${cleanJobs}–${attempts - cleanJobs} · ${pct(cleanJobs / attempts)} clean\n` +
                    (attempts >= MASTERY_CAP
                        ? '🏆 Mastery maxed · +15%'
                        : `🏆 Mastery ${attempts}/${MASTERY_CAP} · +${pct(Math.min(0.15, attempts * 0.001))}`) +
                    heatStatus,
                inline: true,
            };

            let nextJobAt = new Date(claimNow.getTime() + COOLDOWN_MS);
            const nextJobLine = at => { nextJobAt = at; return `\n\n⏱️ Next job ${relTime(at)}`; };
            // Named on the result as well as on the beat before it, so a
            // player who looks away still learns who made the call.
            const footerText = execPress ? execMethod.label : `${execMethod.label} · picked for you`;

            let embed;
            settled = true;

            if (success) {
                const isFeaturedCrime = crime.name === featured.crime.name;
                const baseEarned = Math.floor(crime.minPayout + secureRandom() * (crime.maxPayout - crime.minPayout));
                // Merchant synergy: +5% while carrying anything at all.
                const merchantMult = 1 + getMerchantCoinBonus(user);
                const payoutMult = landedPayoutMult(execMethod, successRoll, successChance);
                let earned = Math.round(baseEarned * streakMult * payoutMult * merchantMult);
                if (isFeaturedCrime) earned = Math.round(earned * (1 + FEATURED_PAYOUT_BONUS));

                // Keyed and recorded-if-lost. The cooldown slot was claimed up
                // front (lastCrime, set before the ~30s button flow), so unlike
                // /work and /daily — whose payout and cooldown are one guarded
                // write, retryable when it misses — a payout that failed here
                // cost the player both the coins and the cooldown, under a bare
                // `$inc` that read nothing back and an embed that dereferenced its
                // result unguarded (#873). The crimeRecord counters ride the same
                // keyed write, so the count and the coins land together.
                const credit = await creditCoinsOrOwe(
                    userFilter,
                    earned,
                    {
                        payoutKey: crimePayoutKey(interaction.id),
                        service: 'crime', jobName: 'crimePayout',
                        counters: { 'crimeRecord.totalCrimes': 1, 'crimeRecord.successfulCrimes': 1 },
                    },
                );
                // The claim already set lastCrime, so the cooldown holds whether
                // or not this read comes back; the settled balance is what the
                // embed shows.
                const newBalance = credit.doc?.balance
                    ?? (await User.findOne(userFilter, { balance: 1 }).lean())?.balance
                    ?? (user.balance ?? 0) + (credit.credited ? earned : 0);
                const payoutNote = credit.credited
                    ? ''
                    : credit.owed
                        ? '\n> ⚠️ *Your payout couldn\'t be delivered right now — it\'s been recorded and will be restored.*'
                        : '\n> ⚠️ *Your payout couldn\'t be delivered right now — please contact an admin.*';

                logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime', amount: earned, balance: newBalance, note: `${crime.name} (success, ${execMethod.id})${isFeaturedCrime ? ' [featured]' : ''}${credit.credited ? '' : credit.owed ? ' [owed]' : ' [unpaid]'}` });

                const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
                if (credit.credited && earned >= bigWinThreshold) {
                    logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: earned, source: 'crime', details: crime.displayName });
                }

                const flavorWin = getCrimeFlavorText(crime.name, 'win')
                    .replace('{amount}', earned.toLocaleString());
                let desc = flavorWin;
                if (luckyActive) desc += `\n> 🍀 *Lucky Charm boosted your success chance!*`;
                if (petCrimeBonus > 0) desc += `\n> 🐾 *Your pet boosted your success chance!*`;
                if (masteryBonus > 0) desc += `\n> 🏆 *Criminal mastery: +${pct(masteryBonus)} applied*`;
                if (hourEdge > 0) desc += `\n> ${timeBand.emoji} *${timeBand.label} played in your favour — +${pct(hourEdge)}*`;
                if (isFeaturedCrime) desc += `\n> 🌟 *Featured job — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout applied!*`;
                desc += bluffStr;

                const crimeMultEntries = [];
                if (streakMult > 1.0) crimeMultEntries.push({ emoji: '🔥', label: `${streakMult.toFixed(2)}x` });
                if (payoutMult !== 1.0) crimeMultEntries.push({ emoji: '⚡', label: `×${payoutMult}` });
                if (merchantMult > 1.0) crimeMultEntries.push({ emoji: '💼', label: `${merchantMult.toFixed(2)}x` });
                if (isFeaturedCrime) crimeMultEntries.push({ emoji: '🌟', label: `+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%` });
                // Every multiplier folded into `earned` above has to be in here too,
                // or the bar breaks down a number it does not add up to.
                const crimeBar = stackBar(crimeMultEntries, streakMult * payoutMult * merchantMult * (isFeaturedCrime ? 1 + FEATURED_PAYOUT_BONUS : 1), earned, currency);

                if (crimeBar) desc += `\n\n${crimeBar}`;
                desc += payoutNote;
                desc += nextJobLine(nextJobAt);

                embed = new EmbedBuilder()
                    .setColor(isFeaturedCrime ? '#FFD700' : '#2ecc71')
                    .setTitle(`${isFeaturedCrime ? '🌟 ' : ''}${crime.emoji} ${crime.displayName} — Clean Getaway`)
                    .setDescription(desc)
                    .addFields(
                        { name: 'Earned',  value: `**${money(earned)}**`, inline: true },
                        { name: 'Balance', value: money(newBalance), inline: true },
                        careerField,
                    )
                    .setFooter({ text: footerText })
                    .setTimestamp();
            } else {
                const flavorText = FINES[Math.floor(secureRandom() * FINES.length)];
                const isCriticalFailure = secureRandom() < DEATH_RATE;

                // Compute heat penalty once so all failure branches apply it consistently.
                const wantedUntil = execMethod.wantedMs > 0
                    ? new Date(crimeTime.getTime() + execMethod.wantedMs)
                    : null;
                const wantedStr = wantedUntil
                    ? `\n> 🔥 *${hours(execMethod.wantedMs)}h heat from ${execMethod.label} — wanted until ${relTime(wantedUntil)}*`
                    : '';
                // The lockout is whichever runs out last: the cooldown from the
                // claim, or the heat. A flat "Cooldown: 1.5h" misstated every
                // loud failure, which locks the player out for 2–3h.
                const cooldownEnds = claimNow.getTime() + COOLDOWN_MS;
                const nextJobStr = (heldUntil = null) => nextJobLine(new Date(Math.max(
                    cooldownEnds, wantedUntil?.getTime() ?? 0, heldUntil?.getTime() ?? 0,
                )));

                // What this failure would take, sized once, so the Lifesaver
                // reports the figure it actually absorbed rather than a re-roll.
                // The cooldown already runs from the claim, so failures no
                // longer rewrite lastCrime (which pushed it up to 30s later
                // than a success's).
                const balanceNow = user.balance ?? 0;
                let loss;
                if (isCriticalFailure) {
                    const lossRate = DEATH_LOSS_MIN + secureRandom() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN);
                    const bustFine = Math.round((crime.minFine + secureRandom() * (crime.maxFine - crime.minFine)) * execMethod.fineMult * heatMult);
                    const critCap = Math.round(crime.maxFine * execMethod.fineMult * heatMult * CRIT_CAP_FINES);
                    loss = Math.max(bustFine, Math.min(Math.floor(balanceNow * lossRate), critCap));
                } else {
                    const rawFine = Math.floor(crime.minFine + secureRandom() * (crime.maxFine - crime.minFine));
                    // The method's multiplier goes on before the wallet cap, so
                    // the cap is a real ceiling — applied after it, a ×1.8 fine
                    // could take 36% of a wallet "capped" at 20%.
                    const cap = Math.max(crime.minFine, Math.floor(balanceNow * 0.20));
                    loss = Math.min(Math.round(rawFine * execMethod.fineMult * heatMult), cap);
                }
                const undergroundActive = !isCriticalFailure && isDistrictActive(guildSettings, 'underground');
                if (undergroundActive) loss = Math.floor(loss * 0.85);

                // Claimed in one guarded write, at the moment it is acted on
                // (#873, pass 15). The charge used to be spent on the loaded
                // document and persisted by a `$set` of the whole
                // `activeEffects` array read when the command started — over any
                // effect activated or spent in between — with nothing in the
                // filter to say the lifesaver was still there. A lifesaver that
                // has gone since the read falls through to the normal fine.
                //
                // Only spent when there is something to absorb. An empty wallet
                // still has one — the holding time below — so the check is on
                // the loss, not on what the wallet could pay of it.
                const absorbable = loss;
                const lifesaverActive = absorbable > 0
                    && hasEffect(user, 'lifesaver')
                    && !!(await spendEffectCharge(User, userFilter, 'lifesaver'));

                // A member frozen mid-job matches no debit (#870), which reports
                // `balance: 0` — not their balance. Read the real one instead.
                const settledBalance = async result => (result.matched
                    ? result.balance
                    : (await User.findOne(userFilter, { balance: 1 }).lean())?.balance ?? balanceNow);

                // Whatever share of the loss the wallet could not cover is
                // served as holding time. Written as a `$max` so it only ever
                // lengthens a lockout (heat may already run past it), and only
                // for a debit that matched — a frozen member was not fined, so
                // there is nothing unpaid to serve.
                const serveUnpaid = async debit => {
                    const unpaid = debit.matched ? loss - debit.taken : 0;
                    if (unpaid <= 0 || loss <= 0) return { heldUntil: null, holdingStr: '' };
                    const holdingMs = Math.round(HOLDING_MAX_MS * unpaid / loss);
                    const heldUntil = new Date(cooldownEnds + holdingMs);
                    await User.updateOne(userFilter, { $max: { wantedUntil: heldUntil } });
                    return {
                        heldUntil,
                        holdingStr: `\n> ⛓️ *Couldn't cover ${money(unpaid)} of it — ${Math.round(holdingMs / 60_000)} min in holding.*`,
                    };
                };

                if (lifesaverActive) {
                    const lifesaverUpdate = { $inc: { 'crimeRecord.totalCrimes': 1 } };
                    if (wantedUntil) lifesaverUpdate.$set = { wantedUntil };
                    await User.findOneAndUpdate(userFilter, lifesaverUpdate);

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_lifesaver', amount: 0, balance: balanceNow, note: `${crime.name} (lifesaver, would have lost ${absorbable})` });

                    embed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle(`${crime.emoji} Saved by the Lifesaver!`)
                        .setDescription(`Your attempt at **${crime.displayName}** went sideways. ${flavorText}${bluffStr}\n> 🛟 *Your Lifesaver activated and saved you! No coins lost! (consumed)*${wantedStr}${nextJobStr()}`)
                        .addFields(
                            { name: isCriticalFailure ? 'Seizure Absorbed' : 'Fine Absorbed', value: money(absorbable), inline: true },
                            { name: 'Balance', value: money(balanceNow), inline: true },
                            careerField,
                        )
                        .setFooter({ text: footerText })
                        .setTimestamp();
                } else if (isCriticalFailure) {
                    const critSet = { 'crimeRecord.totalCrimes': incExpr('crimeRecord.totalCrimes', 1) };
                    if (wantedUntil) critSet.wantedUntil = wantedUntil;
                    // The share is computed from a balance that may already have
                    // moved, so the seizure is clamped inside the update rather
                    // than against the read — `lost` is what was really taken.
                    const debit = await debitUpTo(User, userFilter, loss, critSet);
                    const lost = debit.taken;
                    const critBalance = await settledBalance(debit);
                    const { heldUntil, holdingStr } = await serveUnpaid(debit);
                    // The share of the wallet this really was — the floor and
                    // the cap both move it off the rolled rate.
                    const walletShare = balanceNow > 0 ? Math.round((lost / balanceNow) * 100) : 0;

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_critical_fail', amount: -lost, balance: critBalance, note: `${crime.name} (critical failure, ${walletShare}% seized, ${execMethod.id})` });

                    // Its own lines: the ordinary bust pool is too light for this.
                    const critNarrative = getCrimeFlavorText(crime.name, 'crit');
                    const critDesc =
                        `${critNarrative}${bluffStr}` +
                        holdingStr + wantedStr + nextJobStr(heldUntil);

                    embed = new EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle(`💀 ${crime.displayName} — Everything Went Wrong`)
                        .setDescription(critDesc)
                        .addFields(
                            { name: 'Seized',  value: `**${money(lost)}**${walletShare > 0 ? ` · ${walletShare}% of wallet` : ''}`, inline: true },
                            { name: 'Balance', value: money(critBalance), inline: true },
                            careerField,
                        )
                        .setFooter({ text: `${footerText} · A 🛟 Lifesaver from /shop absorbs the next one` })
                        .setTimestamp();
                } else {
                    const setFields = { 'crimeRecord.totalCrimes': incExpr('crimeRecord.totalCrimes', 1) };
                    if (wantedUntil) setFields.wantedUntil = wantedUntil;

                    // Clamped inside the update: the wallet the fine was sized
                    // against may have emptied since. `paid` is the real figure.
                    const debit = await debitUpTo(User, userFilter, loss, setFields);
                    const paid = debit.taken;
                    const finedBalance = await settledBalance(debit);
                    const { heldUntil, holdingStr } = await serveUnpaid(debit);

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_fine', amount: -paid, balance: finedBalance, note: `${crime.name} (busted, ${execMethod.id})` });

                    const bustNarrative = getCrimeFlavorText(crime.name, 'fail');
                    const undergroundStr = undergroundActive ? '\n> 🌑 *Underground district active — fine reduced by 15%!*' : '';

                    embed = new EmbedBuilder()
                        .setColor(COLORS.ERROR)
                        .setTitle(`${crime.emoji} ${crime.displayName} — Busted`)
                        .setDescription(`${bustNarrative}\n\n> *${flavorText}*${bluffStr}${undergroundStr}${holdingStr}${wantedStr}${nextJobStr(heldUntil)}`)
                        .addFields(
                            { name: 'Fine Paid', value: money(paid), inline: true },
                            { name: 'Balance',   value: money(finedBalance), inline: true },
                            careerField,
                        )
                        .setFooter({ text: footerText })
                        .setTimestamp();
                }
            }

            if (newHeat !== heat) {
                const recorded = user.crimeHeat?.updatedAt ? new Date(user.crimeHeat.updatedAt).getTime() : null;
                const since = heat > 0 && recorded ? (crimeTime.getTime() - recorded) % HEAT_DECAY_MS : 0;
                // Not a coin write, and the job has already settled: a heat
                // update that misses is logged, not allowed to fail the result.
                await User.updateOne(
                    userFilter,
                    { $set: { crimeHeat: { level: newHeat, updatedAt: new Date(crimeTime.getTime() - since) } } },
                ).catch(err => console.error('[crime] heat update failed:', err));
            }

            // Season pass: the mission is "Attempt a crime", so it counts the
            // attempt — every settled outcome, caught or clean, lifesaver or
            // fine. Placed after both branches so a failure advances it too.
            // Fire-and-forget: a mission that fails to tick must not cost the
            // player the result of a job they already ran.
            advanceMissions(User, userFilter, 'crime', 1, guildSettings)
                .catch(err => console.error('[crime] season mission error:', err));

            // The reveal: the setup, a complication, then the outcome. The
            // result is already settled — this is pacing, not a second roll —
            // and neither beat gives the ending away.
            const beats = getCrimeBeats(crime.name);
            const beat = (step, text) => new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle(`${crime.emoji} ${crime.displayName} — ${execMethod.label}`)
                .setDescription(`${text}\n\n${progressBar(step, 3)}`);
            const autoNote = execPress ? '' : '⏳ *No call made — you play it safe.*\n\n';
            await interaction.editReply({ embeds: [beat(1, `${autoNote}*${beats.setup}*`)], components: [] });
            await delay(BEAT_MS);
            await interaction.editReply({ embeds: [beat(2, `*${beats.tension}*`)], components: [] });
            await delay(BEAT_MS);

            const remindRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(REMIND_ID).setLabel('🔔 Remind me').setStyle(ButtonStyle.Secondary),
            );
            await interaction.editReply({ embeds: [embed], components: [remindRow] });
            armReminderButton(interaction, message, nextJobAt);
        } catch (error) {
            console.error('Crime command error:', error);
            // Before `settled` nothing has moved, so the slot goes back and
            // "try again" is true. After it the job stands — telling the player
            // to try again sent them into a cooldown they were already in.
            if (!settled) await releaseClaim();
            const content = settled
                ? "⚠️ The job went through, but the result couldn't be shown. Check `/balance` to see where you stand."
                : "Something went wrong before the job could run. Your cooldown wasn't used — try again.";
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
            } else {
                await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
            }
        }
    }
};

// The tables the balance test holds to its targets.
module.exports.__test__ = { CRIMES, EXECUTION_METHODS, DEATH_RATE, CRIT_CAP_FINES, HEAT_FINE_STEP, HEAT_LOUD_PENALTY, heatNow };
