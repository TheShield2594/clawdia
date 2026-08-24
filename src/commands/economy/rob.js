const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasEffect, consumeEffect, timeRemaining } = require('../../services/effectsService');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { getTotalBonus } = require('../../services/petService');
const { randomFrom, ROB_WIN_LINES, ROB_FAIL_LINES } = require('../../utils/copyLines');
const { delay } = require('../../utils/delay');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const COLORS = require('../../utils/embedColors');

const ROBBER_COOLDOWN_MS  = 1 * 3_600_000; // 1 hour
const VICTIM_IMMUNITY_MS  = 30 * 60_000;   // 30 minutes
const MIN_ACCOUNT_AGE_MS  = 7 * 24 * 3_600_000; // robber & victim Discord accounts must be 7+ days old
const BASE_SUCCESS_CHANCE = 0.40;
const ROB_STEAL_MIN       = 0.10;
const ROB_STEAL_MAX       = 0.40;
const TRAP_FINE_MULTIPLIER = 2;            // trap doubles the normal fine

// CAS the robber on lastRob to block duplicate parallel robs from the same user,
// then atomically apply victim balance changes via $inc with $gte guards. Victim
// immunity is re-checked atomically to catch races between pre-flight and commit.
// If the victim update fails, roll back the robber.
async function saveRobState(robber, victim, robberSnapshot, trapSnapshot, victimOrigBalance, victimOrigBank) {
    const robberCond = { userId: robber.userId, guildId: robber.guildId };
    if (robberSnapshot.lastRob) {
        robberCond.lastRob = robberSnapshot.lastRob;
    } else {
        robberCond.$or = [{ lastRob: null }, { lastRob: { $exists: false } }];
    }
    // The robber's balance and rob counters are written as deltas, not absolute
    // values: an absolute $set would clobber any concurrent credit (a payout, a
    // gift received) landing between the read at the top of the command and this
    // write. The lastRob CAS says nothing about balance, so guard the debit too.
    const robberBalDelta = robber.balance - robberSnapshot.balance;
    const successDelta   = (robber.successfulRobs ?? 0) - (robberSnapshot.successfulRobs ?? 0);
    const failedDelta    = (robber.failedRobs     ?? 0) - (robberSnapshot.failedRobs     ?? 0);
    if (robberBalDelta < 0) robberCond.balance = { $gte: -robberBalDelta };

    const robberUpdate = { $set: { lastRob: robber.lastRob } };
    const robberInc = {};
    if (robberBalDelta !== 0) robberInc.balance        = robberBalDelta;
    if (successDelta   !== 0) robberInc.successfulRobs = successDelta;
    if (failedDelta    !== 0) robberInc.failedRobs     = failedDelta;
    if (Object.keys(robberInc).length) robberUpdate.$inc = robberInc;

    const robberRes = await User.findOneAndUpdate(robberCond, robberUpdate);
    if (!robberRes) {
        // Either the lastRob CAS lost to a parallel rob or the balance guard
        // rejected the debit — read back to tell the user which one happened.
        const current = await User.findOne(
            { userId: robber.userId, guildId: robber.guildId },
            { lastRob: 1 }
        ).lean();
        const casLost = String(current?.lastRob ?? '') !== String(robberSnapshot.lastRob ?? '');
        throw casLost
            ? Object.assign(
                new Error('[rob] duplicate rob attempt — cooldown already applied'),
                { robberCooldownConflict: true }
            )
            : Object.assign(
                new Error('[rob] robber balance changed between read and write'),
                { robberBalanceChanged: true }
            );
    }
    try {
        const balDelta  = victim.balance - victimOrigBalance;
        const bankDelta = (victim.bank ?? 0) - victimOrigBank;

        const cond = { userId: victim.userId, guildId: victim.guildId };
        if (balDelta  < 0) cond.balance = { $gte: -balDelta };
        if (bankDelta < 0) cond.bank    = { $gte: -bankDelta };
        cond.$or = [
            { lastRobbedAt: null },
            { lastRobbedAt: { $lte: new Date(Date.now() - VICTIM_IMMUNITY_MS) } },
        ];

        const update = {
            $set: {
                lastRobbedAt:       victim.lastRobbedAt ?? new Date(),
                activeEffects:      victim.activeEffects,
                'trap.setAt':       victim.trap?.setAt       ?? null,
                'trap.expiresAt':   victim.trap?.expiresAt   ?? null,
            },
        };
        const incFields = {};
        if (balDelta  !== 0) incFields.balance = balDelta;
        if (bankDelta !== 0) incFields.bank    = bankDelta;
        if (Object.keys(incFields).length) update.$inc = incFields;

        const res = await User.findOneAndUpdate(cond, update);
        if (!res) {
            throw Object.assign(
                new Error('[rob] victim balance changed between read and write'),
                { victimBalanceChanged: true }
            );
        }
    } catch (victimErr) {
        try {
            // Give the cooldown slot back only if it is still ours: another rob
            // may have won the CAS since our write, and restoring the old
            // lastRob over its value would hand that rob a free cooldown reset.
            await User.updateOne(
                { userId: robber.userId, guildId: robber.guildId, lastRob: robber.lastRob },
                { $set: { lastRob: robberSnapshot.lastRob } }
            );

            // Reverse the deltas rather than restoring the snapshot values, so a
            // concurrent credit that landed after the robber write survives.
            // Clamped at zero: spending between the write and here can leave less
            // on the account than this rob added.
            const reversals = {};
            if (robberBalDelta !== 0) reversals.balance        = -robberBalDelta;
            if (successDelta   !== 0) reversals.successfulRobs = -successDelta;
            if (failedDelta    !== 0) reversals.failedRobs     = -failedDelta;
            if (Object.keys(reversals).length) {
                const clamped = {};
                for (const [field, delta] of Object.entries(reversals)) {
                    clamped[field] = { $max: [0, { $add: [{ $ifNull: [`$${field}`, 0] }, delta] }] };
                }
                await User.updateOne(
                    { userId: robber.userId, guildId: robber.guildId },
                    [{ $set: clamped }]
                );
            }
        } catch (rollbackErr) {
            console.error('[rob] rollback failed; balances may be inconsistent:', rollbackErr);
        }
        if (trapSnapshot) {
            try {
                await User.updateOne(
                    { userId: victim.userId, guildId: victim.guildId },
                    { $set: { 'trap.setAt': trapSnapshot.setAt, 'trap.expiresAt': trapSnapshot.expiresAt } }
                );
            } catch (trapRollbackErr) {
                console.error('[rob] trap rollback failed; trap may be permanently consumed:', trapRollbackErr);
            }
        }
        throw victimErr;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Try to rob another member\'s wallet. Success is affected by tools and protection.')
        .addUserOption(o =>
            o.setName('target')
                .setDescription('The member to rob.')
                .setRequired(true)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.robEnabled === false) {
            return interaction.reply({ content: 'Robbing is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency     = guildSettings?.economy?.currency || '💰';
        const minRobWallet = guildSettings?.economy?.robMinWallet ?? 100;
        const failFineRate = guildSettings?.economy?.robFailFineRate ?? 0.2;
        const target       = interaction.options.getUser('target');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "You can't rob yourself.", flags: MessageFlags.Ephemeral });
        }
        if (target.bot) {
            return interaction.reply({ content: "You can't rob a bot.", flags: MessageFlags.Ephemeral });
        }
        // Fresh Discord accounts can't rob or be robbed — blocks wealth-extraction
        // chains through disposable alts (fund an alt, "rob" it back with the main).
        if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({ content: 'Your Discord account is too new to rob anyone. Try again in a few days.', flags: MessageFlags.Ephemeral });
        }
        if (Date.now() - target.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({ content: `${target.username}'s account is too new to be robbed.`, flags: MessageFlags.Ephemeral });
        }

        const [robber, victim] = await Promise.all([
            User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
            User.findOne({ userId: target.id, guildId: interaction.guild.id })
        ]);

        // Cooldown check
        if (robber.lastRob && Date.now() - new Date(robber.lastRob).getTime() < ROBBER_COOLDOWN_MS) {
            const nextAt = new Date(new Date(robber.lastRob).getTime() + ROBBER_COOLDOWN_MS);
            return interaction.reply({
                embeds: [buildCooldownEmbed({
                    title: '🕵️ Laying Low',
                    description: "You're keeping a low profile after your last heist.\nThe streets will be safe for you again soon.",
                    color: '#e67e22',
                    nextAt,
                    nextRewardPreview: 'Next heist: 40% base success · Robbery Bag + Knife can tip it in your favour',
                })],
                flags: MessageFlags.Ephemeral,
            });
        }
        if (victim?.lastRobbedAt && Date.now() - new Date(victim.lastRobbedAt).getTime() < VICTIM_IMMUNITY_MS) {
            const remaining = VICTIM_IMMUNITY_MS - (Date.now() - new Date(victim.lastRobbedAt).getTime());
            const mins = Math.ceil(remaining / 60_000);
            return interaction.reply({ content: `${target.username} is under rob immunity for **${mins} min**.`, flags: MessageFlags.Ephemeral });
        }

        const victimTotalWealth = (victim?.balance ?? 0) + (victim?.bank ?? 0);
        if (!victim || victimTotalWealth < minRobWallet) {
            return interaction.reply({ content: `${target.username} doesn't have enough ${currency} to be worth robbing (minimum ${currency}${minRobWallet}).`, flags: MessageFlags.Ephemeral });
        }

        try {
            // Snapshot victim balances before any modifications so saveRobState
            // can compute $inc deltas for atomic, non-overwriting victim updates.
            const victimOrigBalance = victim.balance ?? 0;
            const victimOrigBank    = victim.bank    ?? 0;

            const robberSnapshot = {
                balance:        robber.balance,
                lastRob:        robber.lastRob ?? null,
                successfulRobs: robber.successfulRobs ?? 0,
                failedRobs:     robber.failedRobs     ?? 0,
            };
            robber.lastRob = new Date();

            // ── Invisibility Cloak: victim cannot be targeted ─────────────────
            if (victim && hasEffect(victim, 'invisibility_cloak')) {
                const cloak = victim.activeEffects.find(e => e.type === 'invisibility_cloak');
                await robber.save();
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(COLORS.RARE)
                        .setTitle('🧥 Target Invisible!')
                        .setDescription(`**${target.username}** is wearing an Invisibility Cloak. You can't find them! (${timeRemaining(cloak?.expiresAt)} remaining)`)
                        .setFooter({ text: 'Cooldown: 1h' })
                        .setTimestamp()]
                });
            }

            // ── Shield: blocks rob entirely ───────────────────────────────────
            if (victim && hasEffect(victim, 'shield')) {
                const shield = victim.activeEffects.find(e => e.type === 'shield');
                await robber.save();
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor(COLORS.INFO)
                        .setTitle('🛡️ Robbery Blocked!')
                        .setDescription(`**${target.username}** blocked your robbery attempt with a Shield. (${timeRemaining(shield?.expiresAt)} remaining)`)
                        .setFooter({ text: 'Cooldown: 1h' })
                        .setTimestamp()]
                });
            }

            // ── Build success chance ──────────────────────────────────────────
            let successChance = BASE_SUCCESS_CHANCE;
            if (hasEffect(robber, 'knife'))       successChance += 0.15;  // Knife: +15%
            successChance += getTotalBonus(robber.pets || [], 'rob_success') / 100; // Fox pet: +8%
            successChance = Math.max(0, Math.min(0.95, successChance));

            // ── Suspense reveal ───────────────────────────────────────────────
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#8B4513')
                    .setTitle('🔎 Casing the House…')
                    .setDescription(`*Scoping out ${target.username}'s place...*`)]
            });
            await delay(800);
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor('#8B4513')
                    .setTitle('🔓 Picking the Lock…')
                    .setDescription('*Almost in...*')]
            });
            await delay(800);

            const success = Math.random() < successChance;

            let embed;
            if (success) {
                // Padlock: only wallet accessible (bank protected)
                const padlockActive = hasEffect(victim, 'padlock');
                const stealablePool = padlockActive ? victim.balance : (victim.balance + victim.bank);
                let stolen = Math.floor(stealablePool * (ROB_STEAL_MIN + Math.random() * (ROB_STEAL_MAX - ROB_STEAL_MIN)));

                // Robbery Bag: +10% stolen
                if (hasEffect(robber, 'robbery_bag')) stolen = Math.floor(stolen * 1.10);

                const preRobBalance = robber.balance;
                robber.balance += stolen;
                robber.successfulRobs = (robber.successfulRobs || 0) + 1;

                if (padlockActive) {
                    victim.balance = Math.max(0, victim.balance - stolen);
                } else {
                    const fromWallet = Math.min(victim.balance, stolen);
                    victim.balance -= fromWallet;
                    victim.bank = Math.max(0, victim.bank - (stolen - fromWallet));
                }
                victim.lastRobbedAt = new Date();
                if (padlockActive) consumeEffect(victim, 'padlock');

                // ── Trap check (atomic consume to prevent double-trigger) ─────
                const trapConsumed = await User.findOneAndUpdate(
                    { userId: victim.userId, guildId: interaction.guild.id, 'trap.expiresAt': { $gt: new Date() } },
                    { $unset: { 'trap.expiresAt': '', 'trap.setAt': '' } },
                    { new: false }
                );
                const trapActive = !!trapConsumed;
                const trapSnapshot = trapActive
                    ? { setAt: trapConsumed.trap?.setAt ?? null, expiresAt: trapConsumed.trap?.expiresAt ?? null }
                    : null;
                let trapFine = 0;
                if (trapActive) {
                    const normalFine = Math.floor(preRobBalance * failFineRate);
                    trapFine = Math.min(normalFine * TRAP_FINE_MULTIPLIER, robber.balance);
                    robber.balance = Math.max(0, robber.balance - trapFine);
                    victim.balance += trapFine;
                    if (victim.trap) {
                        victim.trap.setAt     = null;
                        victim.trap.expiresAt = null;
                    }
                }

                const robAchievements = await checkAndAward(robber, guildSettings).catch(() => []);
                await saveRobState(robber, victim, robberSnapshot, trapSnapshot, victimOrigBalance, victimOrigBank);
                if (robAchievements.length) {
                    announceAchievements(interaction.client, guildSettings, robber, interaction.member, robAchievements).catch(() => null);
                }

                const bagNote = hasEffect(robber, 'robbery_bag') ? '\n> 💼 *Robbery Bag boosted your haul by 10%!*' : '';

                if (trapActive) {
                    // Trap triggered: suspense then reveal the trap
                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor(COLORS.WARN)
                            .setTitle('🦹 Successful Heist!')
                            .setDescription(`${randomFrom(ROB_WIN_LINES)} You took **${currency}${stolen.toLocaleString()}** from **${target.username}**.${bagNote}`)]
                    });
                    await delay(900);

                    embed = new EmbedBuilder()
                        .setColor(COLORS.ERROR)
                        .setTitle('💥 TRAP TRIGGERED!')
                        .setDescription(
                            `**${target.username}** set a **Tripwire**!\n\n` +
                            `You stole **${currency}${stolen.toLocaleString()}** — but walked straight into their trap.\n` +
                            `You paid a **2× fine** of **${currency}${trapFine.toLocaleString()}** back to them.`
                        )
                        .addFields(
                            { name: 'Robber Balance', value: `${currency}${robber.balance.toLocaleString()}`,  inline: true },
                            { name: 'Victim Balance', value: `${currency}${victim.balance.toLocaleString()}`, inline: true },
                            { name: 'Fine Paid',      value: `${currency}${trapFine.toLocaleString()}`,       inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1h' })
                        .setTimestamp();

                    // Server-wide announcement
                    const announceChannelId = guildSettings?.economy?.announcementChannelId;
                    const announceChannel   = announceChannelId
                        ? interaction.guild.channels.cache.get(announceChannelId)
                        : null;
                    if (announceChannel?.isTextBased()) {
                        const trapAnnounce = new EmbedBuilder()
                            .setColor(COLORS.ERROR)
                            .setTitle('🪤 Trap Sprung!')
                            .setDescription(
                                `<@${target.id}>'s trap just caught <@${interaction.user.id}> red-handed!\n\n` +
                                `The robber paid **${currency}${trapFine.toLocaleString()}** for their trouble.`
                            )
                            .setTimestamp();
                        announceChannel.send({ embeds: [trapAnnounce] }).catch(() => null);
                    }
                } else {
                    embed = new EmbedBuilder()
                        .setColor(COLORS.WARN)
                        .setTitle('🦹 Successful Heist!')
                        .setDescription(`${randomFrom(ROB_WIN_LINES)} You took **${currency}${stolen.toLocaleString()}** from **${target.username}**.${bagNote}`)
                        .addFields(
                            { name: 'Your Balance', value: `${currency}${robber.balance.toLocaleString()}`, inline: true },
                            { name: 'Their Balance', value: `${currency}${victim.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1h' })
                        .setTimestamp();

                    if (padlockActive) {
                        embed.addFields({ name: '🔒 Padlock Broken!', value: `${target.username}'s bank was protected, but their padlock is now gone!`, inline: false });
                    }
                }
            } else {
                const fine = Math.floor(robber.balance * failFineRate);
                const paid = Math.min(fine, robber.balance);

                // Phantom Token (1 charge) or Ghost Ledger (3 charges): absorb fine silently
                const fineAbsorber = hasEffect(robber, 'phantom_token') ? 'phantom_token'
                    : hasEffect(robber, 'ghost_ledger') ? 'ghost_ledger' : null;
                if (fineAbsorber) {
                    consumeEffect(robber, fineAbsorber);
                    victim.lastRobbedAt = new Date();
                    await robber.save();
                    await User.updateOne(
                        { userId: victim.userId, guildId: victim.guildId },
                        { $set: { lastRobbedAt: victim.lastRobbedAt } }
                    );
                    const absorberCfg = fineAbsorber === 'phantom_token'
                        ? { emoji: '👻', label: 'Phantom Token', chargesKey: null }
                        : { emoji: '📒', label: 'Ghost Ledger',  chargesKey: 'ghost_ledger' };
                    const chargesLeft = absorberCfg.chargesKey
                        ? ((robber.activeEffects ?? []).find(e => e.type === absorberCfg.chargesKey)?.charges ?? 0)
                        : 0;
                    const chargeStr = chargesLeft > 0 ? ` (${chargesLeft} uses left)` : '';
                    embed = new EmbedBuilder()
                        .setColor('#2c3e50')
                        .setTitle(`${absorberCfg.emoji} ${absorberCfg.label} — Fine Erased`)
                        .setDescription(`**${target.username}** caught you, but the fine never made it to the books.${chargeStr}`)
                        .addFields(
                            { name: 'Fine Erased',  value: `${currency}${paid.toLocaleString()}`,           inline: true },
                            { name: 'Your Balance', value: `${currency}${robber.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1h' })
                        .setTimestamp();
                // Lifesaver: absorbs the failure fine — no coins lost
                } else if (hasEffect(robber, 'lifesaver')) {
                    consumeEffect(robber, 'lifesaver');
                    victim.lastRobbedAt = new Date();
                    await robber.save();
                    // Only persist lastRobbedAt — victim.activeEffects was not modified
                    // in this path, so writing it would silently clobber concurrent changes.
                    await User.updateOne(
                        { userId: victim.userId, guildId: victim.guildId },
                        { $set: { lastRobbedAt: victim.lastRobbedAt } }
                    );

                    embed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle('🛟 Lifesaver Activated!')
                        .setDescription(`**${target.username}** caught you in the act, but your **Lifesaver** protected you from the **${currency}${paid.toLocaleString()}** fine! (consumed)`)
                        .addFields(
                            { name: 'Fine Absorbed', value: `${currency}${paid.toLocaleString()}`,        inline: true },
                            { name: 'Your Balance',  value: `${currency}${robber.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1h' })
                        .setTimestamp();
                } else {
                    robber.balance = Math.max(0, robber.balance - paid);
                    robber.failedRobs = (robber.failedRobs || 0) + 1;
                    victim.balance += paid;
                    victim.lastRobbedAt = new Date();
                    await saveRobState(robber, victim, robberSnapshot, null, victimOrigBalance, victimOrigBank);

                    embed = new EmbedBuilder()
                        .setColor(COLORS.ERROR)
                        .setTitle('🚔 Caught Red-Handed!')
                        .setDescription(`${randomFrom(ROB_FAIL_LINES)} **${target.username}** had you fined **${currency}${paid.toLocaleString()}**, which went straight to them.`)
                        .addFields(
                            { name: 'Fine Paid',    value: `${currency}${paid.toLocaleString()}`,        inline: true },
                            { name: 'Your Balance', value: `${currency}${robber.balance.toLocaleString()}`, inline: true }
                        )
                        .setFooter({ text: 'Cooldown: 1h' })
                        .setTimestamp();
                }
            }

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            if (error.robberCooldownConflict) {
                return interaction.editReply({ content: '⚡ Duplicate rob attempt detected — please try again.' }).catch(() => {});
            }
            if (error.robberBalanceChanged) {
                return interaction.editReply({ content: '⚡ Your balance shifted mid-heist — the rob was called off.' }).catch(() => {});
            }
            if (error.victimBalanceChanged) {
                return interaction.editReply({ content: "⚡ The target's balance shifted mid-heist — you couldn't complete the rob." }).catch(() => {});
            }
            console.error('Rob command error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral });
            } else {
                await interaction.editReply({ content: 'Something went wrong.' }).catch(() => {});
            }
        }
    }
};
