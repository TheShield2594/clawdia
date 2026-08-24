const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasEffect, consumeEffect } = require('../../services/effectsService');
const { getMerchantCoinBonus } = require('../../services/synergyService');
const { advanceMissions } = require('../../services/seasonMissionService');
const { attachGrind } = require('../../utils/grindProfile');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { clampMultiplier } = require('../../config/economy');
const { logTransaction } = require('../../utils/logTransaction');
const { debitUpTo, incExpr } = require('../../utils/balanceDebit');
const { getTotalBonus } = require('../../services/petService');
const { getCrimeFlavorText } = require('../../utils/copyLines');
const { stackBar } = require('../../utils/rewardReveal');
const { delay } = require('../../utils/delay');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../data/featuredRotation');
const { getTimeBand } = require('../../utils/timeBand');
const { logBigWin } = require('../../utils/bigWinLogger');
const { isDistrictActive } = require('../../services/districtService');
const COLORS = require('../../utils/embedColors');
const { ownedBy } = require('../../utils/collectorOwner');

const COOLDOWN_MS    = 1.5 * 3_600_000; // 1.5 hours
const DEATH_RATE     = 0.08;            // 8% of failures trigger critical death
const DEATH_LOSS_MIN = 0.15;
const DEATH_LOSS_MAX = 0.30;

const CRIMES = [
    { name: 'pickpocketing',      displayName: 'Quick Snatch',  emoji: '🤏', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        riskTag: 'Safe',      successRate: 0.60, minPayout: 80,   maxPayout: 200,  minFine: 50,  maxFine: 100 },
    { name: 'selling fake merch', displayName: 'Street Hustle', emoji: '🛍️', riskEmoji: '🟢', riskLabel: 'Low risk · Small cut',        riskTag: 'Safe',      successRate: 0.55, minPayout: 100,  maxPayout: 300,  minFine: 75,  maxFine: 150 },
    { name: 'hacking ATMs',       displayName: 'ATM Ghost',     emoji: '💻', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', riskTag: 'Balanced',  successRate: 0.45, minPayout: 200,  maxPayout: 500,  minFine: 100, maxFine: 200 },
    { name: 'art forgery',        displayName: 'The Forgery',   emoji: '🖼️', riskEmoji: '🟡', riskLabel: 'Medium risk · Decent payout', riskTag: 'Balanced',  successRate: 0.40, minPayout: 300,  maxPayout: 700,  minFine: 150, maxFine: 300 },
    { name: 'casino cheating',    displayName: 'Casino Con',    emoji: '🎰', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       riskTag: 'Dangerous', successRate: 0.35, minPayout: 400,  maxPayout: 1000, minFine: 200, maxFine: 400 },
    { name: 'grand larceny',      displayName: 'The Score',     emoji: '💎', riskEmoji: '🔴', riskLabel: 'High risk · Big money',       riskTag: 'Dangerous', successRate: 0.25, minPayout: 600,  maxPayout: 1500, minFine: 300, maxFine: 600 },
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
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.crimeEnabled === false) {
            return interaction.reply({ content: 'The crime command is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency || '💰';

        // Atomically claim the cooldown slot up front — lastCrime is set the moment
        // the job starts (not when it resolves ~30s later via the button flow), so
        // two concurrent /crime invocations can't both pass the cooldown check
        // before either one writes back.
        const claimNow = new Date();
        const cooldownFloor = new Date(claimNow.getTime() - COOLDOWN_MS);
        const claimed = await User.findOneAndUpdate(
            {
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                $and: [
                    { $or: [{ wantedUntil: null }, { wantedUntil: { $lte: claimNow } }] },
                    { $or: [{ lastCrime: null }, { lastCrime: { $lte: cooldownFloor } }] },
                ],
            },
            {
                $set: { lastCrime: claimNow },
                $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id },
            },
            { upsert: true, new: true }
        );

        if (!claimed) {
            const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });

            if (fresh?.wantedUntil && Date.now() < fresh.wantedUntil.getTime()) {
                const nextAt = new Date(fresh.wantedUntil.getTime());
                return interaction.reply({
                    embeds: [buildCooldownEmbed({
                        title: '🚨 Still Wanted',
                        description: 'The city has eyes on you. Lay low. 🚨\nDon\'t even think about running another job until the heat breaks.',
                        color: '#e74c3c',
                        nextAt,
                        nextRewardPreview: 'Once clear: Grand Larceny pays 600–1500 coins · Casino Con is next on the board',
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
                    nextRewardPreview: 'Next run: three new crimes roll — pick the right one for up to 1,500 coins',
                })],
                flags: MessageFlags.Ephemeral,
            });
        }

        const user = claimed;
        // Synergy requirements read hunt/fishing/mining levels, and those live in
        // GrindProfile — absent from a bare User document, so the Merchant bonus
        // on the payout below would silently never fire.
        await attachGrind(user, ['hunt', 'fishing', 'mining']);

        // ── Step 1: Choose the crime ────────────────────────────────────────────
        const featured = getDailyFeatured(interaction.guild.id);
        const timeBand = getTimeBand();

        const shuffled = [...CRIMES].sort(() => Math.random() - 0.5);
        const choices = shuffled.slice(0, 3);
        if (!choices.some(c => c.name === featured.crime.name)) {
            choices[Math.floor(Math.random() * 3)] = CRIMES.find(c => c.name === featured.crime.name) ?? choices[0];
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
                `🎯 ${Math.round(c.successRate * 100)}% success · 💵 ${c.minPayout}–${c.maxPayout} · Fine: ${c.minFine}–${c.maxFine}` +
                featuredTag
            );
        }).join('\n\n');

        const selectionEmbed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle('🌆 Tonight\'s Jobs')
            .setDescription(`Three options on the table. Pick your play — or let the clock decide.\n\n${crimeLines}`)
            .setFooter({ text: `${timeBand.emoji} ${timeBand.label} · 15 seconds. No choice and it gets chosen for you.` })
            .setTimestamp();

        const response = await interaction.reply({ embeds: [selectionEmbed], components: [row], fetchReply: true });

        let crime;
        let crimeButtonInteraction = null;
        try {
            crimeButtonInteraction = await response.awaitMessageComponent({
                filter: ownedBy(interaction.user.id, "This isn't your job."),
                time: 15_000,
            });
            crime = CRIMES.find(c => c.name === crimeButtonInteraction.customId);
            await crimeButtonInteraction.deferUpdate();
        } catch {
            crime = choices[Math.floor(Math.random() * choices.length)];
        }

        // ── Step 2: Choose the execution method ────────────────────────────────
        const crimeXp = user.crimeRecord?.totalCrimes ?? 0;
        const masteryBonus = Math.min(0.15, crimeXp * 0.001);

        const execData = EXECUTION_METHODS[crime.name];

        const execMethodLines = execData.methods.map(m => {
            const effectiveRate = m.wildcard
                ? { min: Math.min(0.95, 0.15 + masteryBonus), max: Math.min(0.95, 0.75 + masteryBonus) }
                : Math.min(0.95, m.successRate + masteryBonus);
            const rateStr = m.wildcard
                ? `${Math.round(effectiveRate.min * 100)}–${Math.round(effectiveRate.max * 100)}% wildcard`
                : `${Math.round(effectiveRate * 100)}%`;
            const payoutStr = m.payoutMult !== 1.0 ? ` · ×${m.payoutMult} payout` : '';
            const wantedHours = m.wantedMs / 3_600_000;
            const wantedStr = m.wantedMs > 0
                ? ` · 🔥 ${wantedHours % 1 === 0 ? wantedHours : wantedHours.toFixed(1)}h heat on fail`
                : '';
            return `**${m.label}** — ${m.desc}\n🎯 ${rateStr} success${payoutStr}${wantedStr}`;
        }).join('\n\n');

        const masteryStr = masteryBonus > 0
            ? `\n\n> 🏆 *Criminal mastery: +${Math.round(masteryBonus * 100)}% applied to success rates*`
            : '';

        const execEmbed = new EmbedBuilder()
            .setColor('#e67e22')
            .setTitle(`${crime.emoji} ${crime.displayName} — Choose Your Approach`)
            .setDescription(`🎯 ${execData.situation}\n\n${execMethodLines}${masteryStr}`)
            .setFooter({ text: '15 seconds to decide. No pick and one is chosen for you.' })
            .setTimestamp();

        const execRow = new ActionRowBuilder().addComponents(
            execData.methods.map(m => {
                const effectiveRate = m.wildcard
                    ? { min: Math.min(0.95, 0.15 + masteryBonus), max: Math.min(0.95, 0.75 + masteryBonus) }
                    : Math.min(0.95, m.successRate + masteryBonus);
                const rateStr = m.wildcard
                    ? `${Math.round(effectiveRate.min * 100)}–${Math.round(effectiveRate.max * 100)}%`
                    : `${Math.round(effectiveRate * 100)}%`;
                return new ButtonBuilder()
                    .setCustomId(`exec_${m.id}`)
                    .setLabel(`${m.label}  ·  ${rateStr}`)
                    .setStyle(ButtonStyle.Secondary);
            })
        );

        await interaction.editReply({ embeds: [execEmbed], components: [execRow] });

        let execMethod;
        try {
            const execButtonInteraction = await response.awaitMessageComponent({
                filter: ownedBy(interaction.user.id, "This isn't your job."),
                time: 15_000,
            });
            execMethod = execData.methods.find(m => `exec_${m.id}` === execButtonInteraction.customId);
            await execButtonInteraction.deferUpdate();
        } catch {
            execMethod = execData.methods[Math.floor(Math.random() * execData.methods.length)];
        }

        // ── Resolve the crime ───────────────────────────────────────────────────
        let successChance = execMethod.wildcard
            ? Math.min(0.95, 0.15 + Math.random() * 0.60 + masteryBonus)
            : execMethod.successRate + masteryBonus;

        // Black Market Contract: +5% per permanent stack (max 3 stacks = +15%)
        const contractBonus = (user.crimeContractStacks ?? 0) * 0.05;
        if (contractBonus > 0) successChance = Math.min(0.95, successChance + contractBonus);

        const luckyActive = hasEffect(user, 'lucky_charm');
        if (luckyActive) successChance = Math.min(0.95, successChance + 0.20);

        const petCrimeBonus = getTotalBonus(user.pets || [], 'crime_success') / 100;
        if (petCrimeBonus > 0) successChance = Math.min(0.95, successChance + petCrimeBonus);
        successChance = Math.min(0.95, successChance);

        const success = Math.random() < successChance;
        const crimeTime = new Date();

        const streakMult = clampMultiplier(getStreakMultiplier(user.streak?.current ?? 0));

        try {
            let embed;
            const userFilter = { userId: interaction.user.id, guildId: interaction.guild.id };

            if (success) {
                const isFeaturedCrime = crime.name === featured.crime.name;
                const baseEarned = Math.floor(crime.minPayout + Math.random() * (crime.maxPayout - crime.minPayout));
                // Merchant synergy: +5% while carrying anything at all.
                const merchantMult = 1 + getMerchantCoinBonus(user);
                let earned = Math.round(baseEarned * streakMult * execMethod.payoutMult * merchantMult);
                if (isFeaturedCrime) earned = Math.round(earned * (1 + FEATURED_PAYOUT_BONUS));

                const updated = await User.findOneAndUpdate(
                    userFilter,
                    {
                        $inc: { balance: earned, 'crimeRecord.totalCrimes': 1, 'crimeRecord.successfulCrimes': 1 },
                        $set: { lastCrime: crimeTime },
                    },
                    { new: true }
                );

                logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime', amount: earned, balance: updated.balance, note: `${crime.name} (success, ${execMethod.id})${isFeaturedCrime ? ' [featured]' : ''}` });

                const bigWinThreshold = guildSettings?.economy?.bigWinThreshold ?? 50000;
                if (earned >= bigWinThreshold) {
                    logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: earned, source: 'crime', details: crime.displayName });
                }

                const flavorWin = getCrimeFlavorText(crime.name, 'win')
                    .replace('{amount}', earned.toLocaleString());
                let desc = flavorWin;
                if (luckyActive) desc += `\n> 🍀 *Lucky Charm boosted your success chance!*`;
                if (petCrimeBonus > 0) desc += `\n> 🐱 *Cat pet boosted your success chance!*`;
                if (masteryBonus > 0) desc += `\n> 🏆 *Criminal mastery: +${Math.round(masteryBonus * 100)}% applied*`;
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
                desc += `\n────────────────────\n  Balance: ${updated.balance.toLocaleString()} coins`;

                embed = new EmbedBuilder()
                    .setColor(isFeaturedCrime ? '#FFD700' : '#2ecc71')
                    .setTitle(`${isFeaturedCrime ? '🌟 ' : ''}${crime.emoji} ${crime.displayName} — Clean Getaway`)
                    .setDescription(desc)
                    .setFooter({ text: `${execMethod.label} · Cooldown: 1.5h` })
                    .setTimestamp();
            } else {
                const flavorText = FINES[Math.floor(Math.random() * FINES.length)];
                const isCriticalFailure = Math.random() < DEATH_RATE;

                // Compute heat penalty once so all failure branches apply it consistently.
                const wantedUntil = execMethod.wantedMs > 0
                    ? new Date(crimeTime.getTime() + execMethod.wantedMs)
                    : null;
                const wantedHours = execMethod.wantedMs / 3_600_000;
                const wantedStr = wantedUntil
                    ? `\n> 🔥 *${wantedHours % 1 === 0 ? wantedHours : wantedHours.toFixed(1)}h heat from ${execMethod.label} — wanted until <t:${Math.floor(wantedUntil.getTime() / 1000)}:R>*`
                    : '';

                const lifesaverActive = hasEffect(user, 'lifesaver');
                if (lifesaverActive) {
                    consumeEffect(user, 'lifesaver');
                    const wouldHaveLost = isCriticalFailure
                        ? Math.floor(user.balance * (DEATH_LOSS_MIN + Math.random() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN)))
                        : Math.floor((crime.minFine + Math.random() * (crime.maxFine - crime.minFine)) * execMethod.fineMult);
                    const lifesaverSet = { lastCrime: crimeTime, activeEffects: user.activeEffects };
                    if (wantedUntil) lifesaverSet.wantedUntil = wantedUntil;
                    await User.findOneAndUpdate(
                        userFilter,
                        {
                            $inc: { 'crimeRecord.totalCrimes': 1 },
                            $set: lifesaverSet,
                        }
                    );

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_lifesaver', amount: 0, balance: user.balance, note: `${crime.name} (lifesaver, would have lost ${wouldHaveLost})` });

                    embed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle(`${crime.emoji} Saved by the Lifesaver!`)
                        .setDescription(`Your attempt at **${crime.displayName}** went sideways. ${flavorText}\n> 🛟 *Your Lifesaver activated and saved you! No coins lost! (consumed)*${wantedStr}`)
                        .addFields(
                            { name: isCriticalFailure ? 'Death Loss Absorbed' : 'Fine Absorbed', value: `${currency}${Math.min(wouldHaveLost, user.balance).toLocaleString()}`, inline: true },
                            { name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: `${execMethod.label} · Cooldown: 1.5h` })
                        .setTimestamp();
                } else if (isCriticalFailure) {
                    const lossRate = DEATH_LOSS_MIN + Math.random() * (DEATH_LOSS_MAX - DEATH_LOSS_MIN);
                    const critSet = { lastCrime: crimeTime, 'crimeRecord.totalCrimes': incExpr('crimeRecord.totalCrimes', 1) };
                    if (wantedUntil) critSet.wantedUntil = wantedUntil;
                    // The share is computed from a balance that may already have
                    // moved, so the seizure is clamped inside the update rather
                    // than against the read — `lost` is what was really taken.
                    const { taken: lost, balance: critBalance } = await debitUpTo(
                        User, userFilter, Math.floor((user.balance ?? 0) * lossRate), critSet,
                    );

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
                        wantedStr;

                    embed = new EmbedBuilder()
                        .setColor('#8B0000')
                        .setTitle(`💀 ${crime.displayName} — Everything Went Wrong`)
                        .setDescription(critDesc)
                        .setFooter({ text: `${execMethod.label} · Cooldown: 1.5h · Purchase a Lifesaver from /shop to protect against critical failures` })
                        .setTimestamp();
                } else {
                    const undergroundActive = isDistrictActive(guildSettings, 'underground');
                    const rawFine = Math.floor(crime.minFine + Math.random() * (crime.maxFine - crime.minFine));
                    const maxFine = Math.max(crime.minFine, Math.floor(user.balance * 0.20));
                    let fine = Math.min(rawFine, maxFine);
                    fine = Math.round(fine * execMethod.fineMult);
                    if (undergroundActive) fine = Math.floor(fine * 0.85);
                    const setFields = { lastCrime: crimeTime, 'crimeRecord.totalCrimes': incExpr('crimeRecord.totalCrimes', 1) };
                    if (wantedUntil) setFields.wantedUntil = wantedUntil;

                    // Clamped inside the update: the wallet the fine was sized
                    // against may have emptied since. `paid` is the real figure.
                    const { taken: paid, balance: finedBalance } = await debitUpTo(
                        User, userFilter, fine, setFields,
                    );

                    logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'crime_fine', amount: -paid, balance: finedBalance, note: `${crime.name} (busted, ${execMethod.id})` });

                    const bustNarrative = getCrimeFlavorText(crime.name, 'fail')
                        .replace('{fine}', paid.toLocaleString())
                        .replace('{amount}', paid.toLocaleString());
                    const undergroundStr = undergroundActive ? '\n> 🌑 *Underground district active — fine reduced by 15%!*' : '';

                    embed = new EmbedBuilder()
                        .setColor(COLORS.ERROR)
                        .setTitle(`${crime.emoji} ${crime.displayName} — Busted`)
                        .setDescription(`${bustNarrative}\n\n> *${flavorText}*${undergroundStr}${wantedStr}`)
                        .addFields(
                            { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                            { name: 'Balance',   value: `${currency}${finedBalance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: `${execMethod.label} · Cooldown: 1.5h` })
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
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
            } else {
                await interaction.editReply({ content: 'Something went wrong. Try again.' }).catch(() => {});
            }
        }
    }
};
