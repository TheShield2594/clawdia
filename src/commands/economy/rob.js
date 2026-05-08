const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasEffect, consumeEffect, timeRemaining } = require('../../services/effectsService');

const ROBBER_COOLDOWN_MS = 1 * 3_600_000; // 1 hour
const VICTIM_IMMUNITY_MS = 30 * 60_000;   // 30 minutes
const BASE_SUCCESS_CHANCE = 0.40;
const ROB_STEAL_MIN = 0.10;
const ROB_STEAL_MAX = 0.40;

async function saveRobState(robber, victim) {
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await robber.save({ session });
            await victim.save({ session });
        });
    } finally {
        await session.endSession();
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
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        if (guildSettings?.economy?.robEnabled === false) {
            return interaction.reply({ content: 'Robbing is disabled on this server.', ephemeral: true });
        }

        const currency     = guildSettings?.economy?.currency || '💰';
        const minRobWallet = guildSettings?.economy?.robMinWallet ?? 100;
        const failFineRate = guildSettings?.economy?.robFailFineRate ?? 0.2;
        const target       = interaction.options.getUser('target');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "You can't rob yourself.", ephemeral: true });
        }
        if (target.bot) {
            return interaction.reply({ content: "You can't rob a bot.", ephemeral: true });
        }
        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (targetMember?.permissions.has('Administrator')) {
            return interaction.reply({ content: "You can't rob server admins.", ephemeral: true });
        }

        const [robber, victim] = await Promise.all([
            User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
            User.findOne({ userId: target.id, guildId: interaction.guild.id })
        ]);

        // Cooldown check
        if (robber.lastRob && Date.now() - new Date(robber.lastRob).getTime() < ROBBER_COOLDOWN_MS) {
            const remaining = ROBBER_COOLDOWN_MS - (Date.now() - new Date(robber.lastRob).getTime());
            const mins = Math.ceil(remaining / 60_000);
            return interaction.reply({ content: `You're laying low after your last heist. Try again in **${mins} min**.`, ephemeral: true });
        }
        if (victim?.lastRobbedAt && Date.now() - new Date(victim.lastRobbedAt).getTime() < VICTIM_IMMUNITY_MS) {
            const remaining = VICTIM_IMMUNITY_MS - (Date.now() - new Date(victim.lastRobbedAt).getTime());
            const mins = Math.ceil(remaining / 60_000);
            return interaction.reply({ content: `${target.username} is under rob immunity for **${mins} min**.`, ephemeral: true });
        }

        if (!victim || victim.balance < minRobWallet) {
            return interaction.reply({ content: `${target.username} doesn't have enough ${currency} to be worth robbing (minimum ${currency}${minRobWallet}).`, ephemeral: true });
        }

        try {
            robber.lastRob = new Date();

            // ── Invisibility Cloak: victim cannot be targeted ─────────────────
            if (victim && hasEffect(victim, 'invisibility_cloak')) {
                const cloak = victim.activeEffects.find(e => e.type === 'invisibility_cloak');
                await robber.save();
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor('#9b59b6')
                        .setTitle('🧥 Target Invisible!')
                        .setDescription(`**${target.username}** is wearing an Invisibility Cloak. You can't find them! (${timeRemaining(cloak?.expiresAt)} remaining)`)
                        .setTimestamp()]
                });
            }

            // ── Shield: blocks rob entirely ───────────────────────────────────
            if (victim && hasEffect(victim, 'shield')) {
                const shield = victim.activeEffects.find(e => e.type === 'shield');
                await robber.save();
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setColor('#3498db')
                        .setTitle('🛡️ Robbery Blocked!')
                        .setDescription(`**${target.username}** blocked your robbery attempt with a Shield. (${timeRemaining(shield?.expiresAt)} remaining)`)
                        .setTimestamp()]
                });
            }

            // ── Build success chance ──────────────────────────────────────────
            let successChance = BASE_SUCCESS_CHANCE;
            if (hasEffect(robber, 'knife'))       successChance += 0.15;  // Knife: +15%
            successChance = Math.max(0, Math.min(0.95, successChance));

            const success = Math.random() < successChance;

            let embed;
            if (success) {
                // Padlock: only wallet accessible (bank protected)
                const padlockActive = hasEffect(victim, 'padlock');
                const stealablePool = padlockActive ? victim.balance : (victim.balance + victim.bank);
                let stolen = Math.floor(stealablePool * (ROB_STEAL_MIN + Math.random() * (ROB_STEAL_MAX - ROB_STEAL_MIN)));

                // Robbery Bag: +10% stolen
                if (hasEffect(robber, 'robbery_bag')) stolen = Math.floor(stolen * 1.10);

                robber.balance += stolen;

                if (padlockActive) {
                    victim.balance = Math.max(0, victim.balance - stolen);
                } else {
                    const fromWallet = Math.min(victim.balance, stolen);
                    victim.balance -= fromWallet;
                    victim.bank = Math.max(0, victim.bank - (stolen - fromWallet));
                }
                victim.lastRobbedAt = new Date();
                await saveRobState(robber, victim);

                const bagNote = hasEffect(robber, 'robbery_bag') ? '\n> 💼 *Robbery Bag boosted your haul by 10%!*' : '';
                embed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle('🦹 Successful Heist!')
                    .setDescription(`You slipped past **${target.username}** and stole **${currency}${stolen.toLocaleString()}**!${bagNote}`)
                    .addFields(
                        { name: 'Your Balance', value: `${currency}${robber.balance.toLocaleString()}`, inline: true },
                        { name: 'Their Balance', value: `${currency}${victim.balance.toLocaleString()}`, inline: true }
                    )
                    .setTimestamp();

                if (padlockActive) {
                    embed.addFields({ name: '🔒 Padlock Active', value: `${target.username}'s bank was protected!`, inline: false });
                }
            } else {
                const fine = Math.floor(robber.balance * failFineRate);
                const paid = Math.min(fine, robber.balance);
                robber.balance = Math.max(0, robber.balance - paid);
                victim.balance += paid;
                await saveRobState(robber, victim);

                embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('🚔 Caught Red-Handed!')
                    .setDescription(`**${target.username}** caught you and you were fined **${currency}${paid.toLocaleString()}**, which went straight to them.`)
                    .addFields(
                        { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                        { name: 'Your Balance', value: `${currency}${robber.balance.toLocaleString()}`, inline: true }
                    )
                    .setTimestamp();
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Rob command error:', error);
            if (!interaction.replied) {
                await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
            }
        }
    }
};
