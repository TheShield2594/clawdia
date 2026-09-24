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
const { getCrimeFlavorText } = require('../../utils/copyLines');
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

const COOLDOWN_MS    = 1.5 * 3_600_000; // 1.5 hours
const DEATH_RATE     = 0.08;            // 8% of failures trigger critical death
const DEATH_LOSS_MIN = 0.15;
const DEATH_LOSS_MAX = 0.30;

const CRIMES = [
    { name: 'pickpocketing',      displayName: 'Quick Snatch',  emoji: '🤏', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        successRate: 0.60, minPayout: 80,   maxPayout: 200,  minFine: 50,  maxFine: 100 },
    { name: 'selling fake merch', displayName: 'Street Hustle', emoji: '🛍️', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        successRate: 0.55, minPayout: 100,  maxPayout: 300,  minFine: 75,  maxFine: 150 },
    { name: 'hacking ATMs',       displayName: 'ATM Ghost',     emoji: '💻', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', successRate: 0.45, minPayout: 200,  maxPayout: 500,  minFine: 100, maxFine: 200 },
    { name: 'art forgery',        displayName: 'The Forgery',   emoji: '🖼️', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', successRate: 0.40, minPayout: 300,  maxPayout: 700,  minFine: 150, maxFine: 300 },
    { name: 'casino cheating',    displayName: 'Casino Con',    emoji: '🎰', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       successRate: 0.35, minPayout: 400,  maxPayout: 1000, minFine: 200, maxFine: 400 },
    { name: 'grand larceny',      displayName: 'The Score',     emoji: '💎', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       successRate: 0.25, minPayout: 600,  maxPayout: 1500, minFine: 300, maxFine: 600 },
];

// Per-crime execution method choices presented in Step 2.
// successRate: absolute rate (null = wildcard, resolved at runtime)
// payoutMult:  multiplier applied to base payout on success
// fineMult:    multiplier applied to fine on regular bust
// wantedMs:    if > 0, sets wantedUntil = crimeTime + wantedMs on bust (must exceed COOLDOWN_MS to add extra penalty)
const EXECUTION_METHODS = {
    'pickpocketing': {
        situation: "You've spotted a mark in the crowd. How do you play it?",
        methods: [
            { id: 'feather_touch', label: '🤏 Feather touch', desc: 'Patient, near-invisible grab', successRate: 0.72, payoutMult: 0.80, fineMult: 0.75, wantedMs: 0 },
            { id: 'quick_snatch',  label: '🏃 Quick snatch',  desc: 'Fast and practiced',           successRate: 0.60, payoutMult: 1.00, fineMult: 1.00, wantedMs: 0 },
            { id: 'bold_grab',     label: '🎰 Bold grab',     desc: 'Loud exit, big cut',            successRate: 0.40, payoutMult: 1.60, fineMult: 1.35, wantedMs: 2 * 3_600_000 },
        ],
    },
    'selling fake merch': {
        situation: "You've got the goods. How do you move them?",
        methods: [
            { id: 'tourist_trap',    label: '🏪 Tourist trap',    desc: 'Steady foot traffic, lower cut', successRate: 0.65, payoutMult: 0.85, fineMult: 0.80, wantedMs: 0 },
            { id: 'hard_sell',       label: '🎤 Hard sell',       desc: 'The usual pitch',                successRate: 0.55, payoutMult: 1.00, fineMult: 1.00, wantedMs: 0 },
            { id: 'wholesale_blitz', label: '📦 Wholesale blitz', desc: 'Bulk push, heat follows',        successRate: 0.38, payoutMult: 1.55, fineMult: 1.40, wantedMs: 2 * 3_600_000 },
        ],
    },
    'hacking ATMs': {
        situation: "You're connected to the network. How do you drain it?",
        methods: [
            { id: 'skimmer',     label: '💳 Skimmer',     desc: 'Install quietly, harvest slowly', successRate: 0.55, payoutMult: 0.80, fineMult: 0.75, wantedMs: 0 },
            { id: 'remote_hack', label: '💻 Remote hack', desc: 'Standard operation',              successRate: 0.45, payoutMult: 1.00, fineMult: 1.00, wantedMs: 0 },
            { id: 'zero_day',    label: '⚡ Zero-day',     desc: 'All-or-nothing exploit',          successRate: 0.28, payoutMult: 1.70, fineMult: 1.50, wantedMs: 2.5 * 3_600_000 },
        ],
    },
    'art forgery': {
        situation: "The studio is set. What's your approach?",
        methods: [
            { id: 'minor_piece',  label: '🖌️ Minor piece',  desc: 'Low stakes, clean sale',       successRate: 0.52, payoutMult: 0.80, fineMult: 0.75, wantedMs: 0 },
            { id: 'classic_swap', label: '🖼️ Classic swap', desc: 'A reliable forgery',           successRate: 0.40, payoutMult: 1.00, fineMult: 1.00, wantedMs: 0 },
            { id: 'masterpiece',  label: '💎 Masterpiece',  desc: 'High-stakes, all eyes on you', successRate: 0.24, payoutMult: 1.75, fineMult: 1.60, wantedMs: 2.5 * 3_600_000 },
        ],
    },
    'casino cheating': {
        situation: "You're at the table. How do you tip the odds?",
        methods: [
            { id: 'count_cards',  label: '🧮 Count cards',  desc: 'Subtle mathematical edge', successRate: 0.48, payoutMult: 0.80, fineMult: 0.75, wantedMs: 0 },
            { id: 'marked_deck',  label: '🃏 Marked deck',  desc: 'Practiced, balanced risk', successRate: 0.35, payoutMult: 1.00, fineMult: 1.00, wantedMs: 0 },
            { id: 'dealer_bribe', label: '💵 Dealer bribe', desc: 'All in — or all busted',   successRate: 0.20, payoutMult: 1.80, fineMult: 1.70, wantedMs: 3 * 3_600_000 },
        ],
    },
    'grand larceny': {
        situation: "You're outside the vault. How do you proceed?",
        methods: [
            { id: 'pick_lock', label: '🔑 Pick the lock',  desc: 'Safer, slower',                successRate: 0.35, payoutMult: 0.80, fineMult: 0.75, wantedMs: 0 },
            { id: 'cut_power', label: '💥 Cut the power',  desc: 'Riskier, faster',              successRate: 0.25, payoutMult: 1.00, fineMult: 1.00, wantedMs: 0 },
            { id: 'bluff_in',  label: '🚨 Bluff your way', desc: 'Wildcard — 15–75% luck-based', successRate: null, payoutMult: 1.90, fineMult: 1.80, wantedMs: 3 * 3_600_000, wildcard: true },
        ],
    },
};

const FINES = [
    'You were caught by an undercover officer.',
    'A bystander called the police on you.',
    'Security footage gave you away.',
    'Your partner-in-crime ratted you out.',
    'Your disguise fell off at the worst moment.',
];

const MAX_SUCCESS    = 0.95;
const WILDCARD_FLOOR = 0.15;            // the wildcard's worst draw
const WILDCARD_SPAN  = 0.60;            // …and how far above that its best one sits
const PICK_WINDOW_MS = 15_000;
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
// A wildcard draws its base rate at resolution, so it has a range.
function methodOdds(method, bonus) {
    if (method.wildcard) {
        return {
            min: Math.min(MAX_SUCCESS, WILDCARD_FLOOR + bonus),
            max: Math.min(MAX_SUCCESS, WILDCARD_FLOOR + WILDCARD_SPAN + bonus),
        };
    }
    const rate = Math.min(MAX_SUCCESS, method.successRate + bonus);
    return { min: rate, max: rate };
}

const oddsLabel = ({ min, max }) => (min === max ? pct(min) : `${pct(min)}–${pct(max)}`);

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
            const timeBand = getTimeBand();

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
                    `🎯 ${pct(Math.min(MAX_SUCCESS, c.successRate + oddsBonus))} success · 💵 ${c.minPayout}–${c.maxPayout} · Fine: ${c.minFine}–${c.maxFine}` +
                    featuredTag
                );
            }).join('\n\n');

            const selectionEmbed = new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle('🌆 Tonight\'s Jobs')
                .setDescription(`Three options on the table. Pick your play — or let the clock decide.\n\n${crimeLines}${bonusLine}`)
                .setFooter({ text: `${timeBand.emoji} ${timeBand.label} · 15 seconds. No choice and it gets chosen for you.` })
                .setTimestamp();

            const response = await interaction.reply({ embeds: [selectionEmbed], components: [row], withResponse: true });
            const message = response?.resource?.message ?? await interaction.fetchReply();

            const crimePress = await awaitPick(message, interaction.user.id);
            const crime = (crimePress && CRIMES.find(c => c.name === crimePress.customId))
                ?? choices[Math.floor(secureRandom() * choices.length)];
            if (crimePress) await crimePress.deferUpdate().catch(() => {});

            // ── Step 2: Choose the execution method ────────────────────────────
            const execData = EXECUTION_METHODS[crime.name];

            const execMethodLines = execData.methods.map(m => {
                const odds = methodOdds(m, oddsBonus);
                const rateStr = m.wildcard ? `${oddsLabel(odds)} wildcard` : oddsLabel(odds);
                const payoutStr = m.payoutMult !== 1.0 ? ` · ×${m.payoutMult} payout` : '';
                const fineStr = ` · fine ${Math.round(crime.minFine * m.fineMult)}–${Math.round(crime.maxFine * m.fineMult)}`;
                const wantedStr = m.wantedMs > 0 ? ` · 🔥 ${hours(m.wantedMs)}h heat on fail` : '';
                return `**${m.label}** — ${m.desc}\n🎯 ${rateStr} success${payoutStr}${fineStr}${wantedStr}`;
            }).join('\n\n');

            const execEmbed = new EmbedBuilder()
                .setColor('#e67e22')
                .setTitle(`${crime.emoji} ${crime.displayName} — Choose Your Approach`)
                .setDescription(`🎯 ${execData.situation}\n\n${execMethodLines}${bonusLine}`)
                .setFooter({ text: '15 seconds to decide. No pick and one is chosen for you.' })
                .setTimestamp();

            const execRow = new ActionRowBuilder().addComponents(
                execData.methods.map(m => new ButtonBuilder()
                    .setCustomId(`exec_${m.id}`)
                    .setLabel(`${m.label}  ·  ${oddsLabel(methodOdds(m, oddsBonus))}`)
                    .setStyle(ButtonStyle.Secondary))
            );

            await interaction.editReply({ embeds: [execEmbed], components: [execRow] });

            const execPress = await awaitPick(message, interaction.user.id);
            const execMethod = (execPress && execData.methods.find(m => `exec_${m.id}` === execPress.customId))
                ?? execData.methods[Math.floor(secureRandom() * execData.methods.length)];
            if (execPress) await execPress.deferUpdate().catch(() => {});

            // Synergy requirements read hunt/fishing/mining levels, and those live in
            // GrindProfile — absent from a bare User document, so the Merchant bonus
            // on the payout below would silently never fire. Read here rather than
            // before the first reply, which has three seconds to go out.
            await attachGrind(user, ['hunt', 'fishing', 'mining']);

            // ── Resolve the crime ───────────────────────────────────────────────
            const baseChance = execMethod.wildcard
                ? WILDCARD_FLOOR + secureRandom() * WILDCARD_SPAN
                : execMethod.successRate;
            const successChance = Math.min(MAX_SUCCESS, baseChance + oddsBonus);

            const success = secureRandom() < successChance;
            const crimeTime = new Date();

            const streakMult = clampMultiplier(getStreakMultiplier(user.streak?.current ?? 0));

            let embed;
            settled = true;

            if (success) {
                const isFeaturedCrime = crime.name === featured.crime.name;
                const baseEarned = Math.floor(crime.minPayout + secureRandom() * (crime.maxPayout - crime.minPayout));
                // Merchant synergy: +5% while carrying anything at all.
                const merchantMult = 1 + getMerchantCoinBonus(user);
                let earned = Math.round(baseEarned * streakMult * execMethod.payoutMult * merchantMult);
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
                if (isFeaturedCrime) desc += `\n> 🌟 *Featured job — +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% payout applied!*`;

                const crimeMultEntries = [];
                if (streakMult > 1.0) crimeMultEntries.push({ emoji: '🔥', label: `${streakMult.toFixed(2)}x` });
                if (execMethod.payoutMult !== 1.0) crimeMultEntries.push({ emoji: '⚡', label: `×${execMethod.payoutMult}` });
                if (merchantMult > 1.0) crimeMultEntries.push({ emoji: '💼', label: `${merchantMult.toFixed(2)}x` });
                if (isFeaturedCrime) crimeMultEntries.push({ emoji: '🌟', label: `+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%` });
                // Every multiplier folded into `earned` above has to be in here too,
                // or the bar breaks down a number it does not add up to.
                const crimeBar = stackBar(crimeMultEntries, streakMult * execMethod.payoutMult * merchantMult * (isFeaturedCrime ? 1 + FEATURED_PAYOUT_BONUS : 1), earned, currency);

                desc += `\n\n────────────────────\n  ${currency} Earned: **${earned.toLocaleString()} coins**`;
                if (crimeBar) desc += `\n  ${crimeBar}`;
                desc += `\n────────────────────\n  Balance: ${newBalance.toLocaleString()} coins`;
                desc += payoutNote;
                desc += `\n\n⏱️ Next job ${relTime(new Date(claimNow.getTime() + COOLDOWN_MS))}`;

                embed = new EmbedBuilder()
                    .setColor(isFeaturedCrime ? '#FFD700' : '#2ecc71')
                    .setTitle(`${isFeaturedCrime ? '🌟 ' : ''}${crime.emoji} ${crime.displayName} — Clean Getaway`)
                    .setDescription(desc)
                    .setFooter({ text: execMethod.label })
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
                const nextJobAt = new Date(Math.max(claimNow.getTime() + COOLDOWN_MS, wantedUntil?.getTime() ?? 0));
                const nextJobStr = `\n\n⏱️ Next job ${relTime(nextJobAt)}`;

                // What this failure would take, sized once, so the Lifesaver
                // reports the figure it actually absorbed rather than a re-roll.
                // The cooldown already runs from the claim, so failures no
                // longer rewrite lastCrime (which pushed it up to 30s later
                // than a success's).
                const balanceNow = user.balance ?? 0;
                let loss;
                let lossRate = 0;
                if (isCriticalFailure) {
                    lossRate = DEATH_LOSS_MIN + secureRandom() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN);
                    loss = Math.floor(balanceNow * lossRate);
                } else {
                    const rawFine = Math.floor(crime.minFine + secureRandom() * (crime.maxFine - crime.minFine));
                    // The method's multiplier goes on before the wallet cap, so
                    // the cap is a real ceiling — applied after it, a ×1.8 fine
                    // could take 36% of a wallet "capped" at 20%.
                    const cap = Math.max(crime.minFine, Math.floor(balanceNow * 0.20));
                    loss = Math.min(Math.round(rawFine * execMethod.fineMult), cap);
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
                // Only spent when there is something to absorb: an empty wallet
                // loses nothing, and burning a 15,000-coin item to report
                // "Fine Absorbed: 0" was the worst trade in the shop.
                const absorbable = Math.min(loss, balanceNow);
                const lifesaverActive = absorbable > 0
                    && hasEffect(user, 'lifesaver')
                    && !!(await spendEffectCharge(User, userFilter, 'lifesaver'));

                // A member frozen mid-job matches no debit (#870), which reports
                // `balance: 0` — not their balance. Read the real one instead.
                const settledBalance = async result => (result.matched
                    ? result.balance
                    : (await User.findOne(userFilter, { balance: 1 }).lean())?.balance ?? balanceNow);

                if (lifesaverActive) {
                    const lifesaverUpdate = { $inc: { 'crimeRecord.totalCrimes': 1 } };
                    if (wantedUntil) lifesaverUpdate.$set = { wantedUntil };
                    await User.findOneAndUpdate(userFilter, lifesaverUpdate);

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_lifesaver', amount: 0, balance: balanceNow, note: `${crime.name} (lifesaver, would have lost ${absorbable})` });

                    embed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle(`${crime.emoji} Saved by the Lifesaver!`)
                        .setDescription(`Your attempt at **${crime.displayName}** went sideways. ${flavorText}\n> 🛟 *Your Lifesaver activated and saved you! No coins lost! (consumed)*${wantedStr}${nextJobStr}`)
                        .addFields(
                            { name: isCriticalFailure ? 'Death Loss Absorbed' : 'Fine Absorbed', value: `${currency}${absorbable.toLocaleString()}`, inline: true },
                            { name: 'Balance', value: `${currency}${balanceNow.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: execMethod.label })
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

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_critical_fail', amount: -lost, balance: critBalance, note: `${crime.name} (critical failure, ${Math.round(lossRate * 100)}% seized, ${execMethod.id})` });

                    const critNarrative = getCrimeFlavorText(crime.name, 'fail')
                        .replace('{fine}', lost.toLocaleString())
                        .replace('{amount}', lost.toLocaleString());
                    const critDesc =
                        `${critNarrative}\n\n> *${flavorText}*\n\n` +
                        `────────────────────\n` +
                        `  💸 Seized: ${currency}${lost.toLocaleString()} coins  (${Math.round(lossRate * 100)}% of wallet)\n` +
                        `  💰 Remaining: ${critBalance.toLocaleString()} coins\n` +
                        `────────────────────` +
                        wantedStr + nextJobStr;

                    embed = new EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle(`💀 ${crime.displayName} — Everything Went Wrong`)
                        .setDescription(critDesc)
                        .setFooter({ text: `${execMethod.label} · Purchase a Lifesaver from /shop to protect against critical failures` })
                        .setTimestamp();
                } else {
                    const setFields = { 'crimeRecord.totalCrimes': incExpr('crimeRecord.totalCrimes', 1) };
                    if (wantedUntil) setFields.wantedUntil = wantedUntil;

                    // Clamped inside the update: the wallet the fine was sized
                    // against may have emptied since. `paid` is the real figure.
                    const debit = await debitUpTo(User, userFilter, loss, setFields);
                    const paid = debit.taken;
                    const finedBalance = await settledBalance(debit);

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_fine', amount: -paid, balance: finedBalance, note: `${crime.name} (busted, ${execMethod.id})` });

                    const bustNarrative = getCrimeFlavorText(crime.name, 'fail')
                        .replace('{fine}', paid.toLocaleString())
                        .replace('{amount}', paid.toLocaleString());
                    const undergroundStr = undergroundActive ? '\n> 🌑 *Underground district active — fine reduced by 15%!*' : '';

                    embed = new EmbedBuilder()
                        .setColor(COLORS.ERROR)
                        .setTitle(`${crime.emoji} ${crime.displayName} — Busted`)
                        .setDescription(`${bustNarrative}\n\n> *${flavorText}*${undergroundStr}${wantedStr}${nextJobStr}`)
                        .addFields(
                            { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                            { name: 'Balance',   value: `${currency}${finedBalance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: execMethod.label })
                        .setTimestamp();
                }
            }

            // Season pass: the mission is "Attempt a crime", so it counts the
            // attempt — every settled outcome, caught or clean, lifesaver or
            // fine. Placed after both branches so a failure advances it too.
            // Fire-and-forget: a mission that fails to tick must not cost the
            // player the result of a job they already ran.
            advanceMissions(User, userFilter, 'crime', 1, guildSettings)
                .catch(err => console.error('[crime] season mission error:', err));

            // Suspense delay between execution method selection and result reveal
            const suspenseEmbed = new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle(`${crime.emoji} Running the Job…`)
                .setDescription(`*${crime.displayName} in progress…*`);
            await interaction.editReply({ embeds: [suspenseEmbed], components: [] });
            await delay(900);
            await interaction.editReply({ embeds: [embed], components: [] });
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
