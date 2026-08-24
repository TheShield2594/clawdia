'use strict';

// /mine raid — taking ore off another player, and the locks that keep the two
// sides of that from racing each other.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind, persistGrindIfNew } = require('../../../utils/grindProfile');
const { ensureMineData, formatMs, hasRaidableMaterials, planRaidHaul } = require('../../../services/mineService');
const { RAID_COOLDOWN_MS, RAID_SHIELD_MS, RAID_STEAL_MIN, RAID_STEAL_MAX, MATERIAL_NAMES } = require('../../../data/mineData');
const GrindProfile = require('../../../models/GrindProfile');
const { economyLockKey } = require('../../../utils/economyLock');
const { tryAcquire: _lockAcquire, release: _lockRelease } = require('../../../utils/activeGameLock');
const COLORS = require('../../../utils/embedColors');

// ─── RAID ─────────────────────────────────────────────────────────────────────

async function handleRaid(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser('target');
    if (targetUser.id === interaction.user.id) {
        return interaction.reply({ content: "You can't raid your own mine.", flags: MessageFlags.Ephemeral });
    }

    const [raider, defender] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        User.findOne({ userId: targetUser.id, guildId: interaction.guild.id })
    ]);
    await Promise.all([attachGrind(raider), attachGrind(defender)]);

    ensureMineData(raider);

    if (!defender) {
        return interaction.reply({
            content: `${targetUser.username} hasn't started mining yet — nothing to raid.`,
            flags: MessageFlags.Ephemeral
        });
    }
    ensureMineData(defender);

    // Raider cooldown
    const now = Date.now();
    if (raider.mining.lastRaidSent && now - raider.mining.lastRaidSent.getTime() < RAID_COOLDOWN_MS) {
        const nextAt = new Date(raider.mining.lastRaidSent.getTime() + RAID_COOLDOWN_MS);
        const remaining = formatMs(nextAt.getTime() - now);
        return interaction.reply({
            content: `You need to wait **${remaining}** before raiding again.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Defender shield (recently raided)
    if (defender.mining.lastRaidReceived && now - defender.mining.lastRaidReceived.getTime() < RAID_SHIELD_MS) {
        const shieldEnds = new Date(defender.mining.lastRaidReceived.getTime() + RAID_SHIELD_MS);
        const remaining  = formatMs(shieldEnds.getTime() - now);
        return interaction.reply({
            content: `**${targetUser.username}**'s mine is still recovering from a recent raid. Wait **${remaining}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Raider must have a pickaxe equipped
    const rm = raider.mining;
    if (rm.equippedPickaxeIndex < 0 || !rm.pickaxes[rm.equippedPickaxeIndex]) {
        return interaction.reply({
            content: "You need a pickaxe equipped to raid! Use `/mine inv equip`.",
            flags: MessageFlags.Ephemeral
        });
    }

    // Mine Lock: defender is protected. Consume atomically so two concurrent
    // raiders can't both read the lock as active and both bypass it.
    if (defender.mining.mineLockActive) {
        const lockConsumed = await GrindProfile.findOneAndUpdate(
            { userId: defender.userId, guildId: interaction.guild.id, system: 'mining', 'data.mineLockActive': true },
            { $set: { 'data.mineLockActive': false } },
            { new: true }
        ).catch(err => { console.error('[mine raid] lock consume error:', err); return null; });

        if (lockConsumed) {
            defender.mining.mineLockActive = false;
            raider.mining.lastRaidSent = new Date();
            raider.markModified('mining');
            await raider.save().catch(() => null);
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(COLORS.ERROR)
                    .setTitle('🔒 Mine Lock Triggered!')
                    .setDescription(
                        `**${targetUser.username}**'s mine was protected by a **Mine Lock**.\n` +
                        `The lock absorbed your raid attempt and has now been consumed.`
                    )
                    .setTimestamp()
                ]
            });
        }
        // Lock was already consumed by a concurrent raid — fall through to normal raid resolution.
    }

    // Check if there's anything to steal
    if (!hasRaidableMaterials(defender)) {
        return interaction.reply({
            content: `**${targetUser.username}** has nothing worth raiding — no material they hold more than one of.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // The transfer below is a pair of $inc updates, but a grind profile is saved as a
    // whole `data` document (see utils/grindProfile) — so a defender part-way through
    // their own /mine dig would write their pre-raid snapshot straight back over the
    // debit, keeping their materials while the raider kept the credit. A dig holds
    // this lock for its entire interactive run, which is seconds wide, so take the
    // defender's lock for the transfer rather than racing it.
    //
    // tryAcquire never blocks, so two miners raiding each other simultaneously cannot
    // deadlock — one or both are simply turned away. The raider's own lease is a
    // different key (theirs, taken by the wrapper below), so this cannot self-block.
    const defenderLockKey = economyLockKey(interaction.guild.id, defender.userId);
    const defenderLock    = await _lockAcquire(defenderLockKey, 30_000, 'raid');
    if (!defenderLock) {
        // Deliberately vague about *what* they are doing: the lease is the
        // shared economy one, so it is just as likely to be a hand of blackjack
        // as a dig, and naming the wrong activity would be worse than naming
        // none. It is also somebody else's business.
        return interaction.reply({
            content: `**${targetUser.username}** is busy right now — you can't get in behind them. Try again in a moment.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // The haul, declared out here because the embed and the defender's DM below
    // both read it after the lock has been released.
    const stolen = {};

    try {

        // Execute the raid: move RAID_STEAL_MIN–RAID_STEAL_MAX of the defender's largest
        // material piles across to the raider. The same `data.materials` map is debited
        // and credited, so a raid transfers value rather than creating it.
        // Defender is updated first; the shield CAS ($or on lastRaidReceived) and
        // per-material $gte guards ensure only one raid commits atomically. Raider
        // update follows sequentially with a cooldown CAS to block duplicate commands.
        const stealFraction = RAID_STEAL_MIN + Math.random() * (RAID_STEAL_MAX - RAID_STEAL_MIN);
        const defenderInc = {};
        const raiderInc   = {};

        for (const { matId, take } of planRaidHaul(defender, stealFraction)) {
            stolen[matId] = take;
            defenderInc[`data.materials.${matId}`] = -take;
            raiderInc[`data.materials.${matId}`]   = take;
        }

        // Make sure the raider's mining profile exists before the conditional commit below
        await persistGrindIfNew(raider, 'mining');

        // Condition: the defender still holds every material being taken; defender not
        // under active shield. Without the $gte guards a raid racing a craft could push
        // a material stock negative.
        const defenderCond = { userId: defender.userId, guildId: interaction.guild.id, system: 'mining' };
        for (const [matId, take] of Object.entries(stolen)) {
            defenderCond[`data.materials.${matId}`] = { $gte: take };
        }
        defenderCond.$or = [
            { 'data.lastRaidReceived': null },
            { 'data.lastRaidReceived': { $lte: new Date(Date.now() - RAID_SHIELD_MS) } },
        ];

        const defenderResult = await GrindProfile.findOneAndUpdate(
            defenderCond,
            { $inc: defenderInc, $set: { 'data.lastRaidReceived': new Date() } }
        ).catch(err => { console.error('[mine raid] defender save error:', err); return null; });

        if (!defenderResult) {
            return interaction.reply({
                content: `**${targetUser.username}**'s stock shifted before you got in — nothing left to take. Try again shortly.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // The credit half of the transfer. Its result cannot be discarded: the debit
        // above has already landed, and there is no transaction to tie the two together
        // on a standalone mongod. If the credit does not land — the cooldown CAS lost a
        // race, or the write errored — the materials would simply cease to exist while
        // both players were told the raid succeeded. Put them back instead.
        const credited = await GrindProfile.findOneAndUpdate(
            {
                userId: raider.userId,
                guildId: interaction.guild.id,
                system: 'mining',
                $or: [
                    { 'data.lastRaidSent': null },
                    { 'data.lastRaidSent': { $lte: new Date(Date.now() - RAID_COOLDOWN_MS) } },
                ],
            },
            { $inc: raiderInc, $set: { 'data.lastRaidSent': new Date() } }
        ).catch(err => { console.error('[mine raid] raider save error:', err); return null; });

        if (!credited) {
            // Compensate: hand the defender's materials back and restore the raid shield
            // to what it was, so a failed raid does not leave them sheltered for an hour
            // over a raid that never happened.
            const rollback = {};
            for (const [matId, take] of Object.entries(stolen)) rollback[`data.materials.${matId}`] = take;
            await GrindProfile.updateOne(
                { userId: defender.userId, guildId: interaction.guild.id, system: 'mining' },
                { $inc: rollback, $set: { 'data.lastRaidReceived': defenderResult.data?.lastRaidReceived ?? null } }
            ).catch(err => console.error('[mine raid] rollback failed — defender owed:', Object.keys(stolen).join(','), err));

            return interaction.reply({
                content: 'Your raid was interrupted — nothing was taken, and nothing was lost. Try again in a moment.',
                flags: MessageFlags.Ephemeral
            });
        }

    } finally {
        await _lockRelease(defenderLockKey, defenderLock);
    }

    const stolenLines = Object.entries(stolen).map(([id, qty]) => `• ${MATERIAL_NAMES[id] ?? id} ×${qty}`).join('\n');
    const stolenCount = Object.values(stolen).reduce((sum, qty) => sum + qty, 0);

    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('⚔️ Mine Raided!')
        .setDescription(
            `You broke into **${targetUser.username}**'s mine and made off with **${stolenCount}** material${stolenCount === 1 ? '' : 's'}!\n\n` +
            `**Stolen:**\n${stolenLines}\n\n` +
            `*These are now yours to craft with.*`
        )
        .setFooter({ text: `${targetUser.username} now has a 1-hour raid shield • Use /mine map to see what of yours is exposed` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // Notify defender if possible
    const dmEmbed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('⚠️ Your Mine Was Raided!')
        .setDescription(
            `**${interaction.user.username}** broke into your mine on **${interaction.guild.name}** ` +
            `and stole **${stolenCount}** of your crafting material${stolenCount === 1 ? '' : 's'}!\n\n` +
            `**Lost:**\n${stolenLines}\n\n` +
            `Get a **Mine Lock** (\`/mine shop buy item:mine_lock\` or \`/craft make mine_lock_from_obsidian\`) ` +
            `and arm it with \`/mine shop use item:mine_lock\` to block the next raid.`
        )
        .setTimestamp();
    targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
}

module.exports = {
    handleRaid,
};
