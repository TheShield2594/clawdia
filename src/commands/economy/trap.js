'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');
const COLORS = require('../../utils/embedColors');

const TRAP_COST     = 6_000;
const TRAP_DURATION = 12 * 3_600_000; // 12 hours

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trap')
        .setDescription('Set a hidden tripwire on your wallet. Triggers if someone successfully robs you.')
        .addSubcommand(sub =>
            sub.setName('set')
               .setDescription(`Set a trap on your wallet for ${TRAP_COST.toLocaleString()} coins. Lasts 12 hours.`))
        .addSubcommand(sub =>
            sub.setName('status')
               .setDescription('Check whether your trap is currently armed.')),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.robEnabled === false) {
            return interaction.reply({ content: 'Robbing is disabled on this server — traps have no purpose here.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const sub      = interaction.options.getSubcommand();

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );

        if (sub === 'status') {
            const trapActive = user.trap?.expiresAt && user.trap.expiresAt > new Date();
            const embed = new EmbedBuilder()
                .setColor(trapActive ? '#f39c12' : '#95a5a6')
                .setTitle('🪤 Trap Status')
                .setTimestamp();

            if (trapActive) {
                const remaining = Math.ceil((user.trap.expiresAt - Date.now()) / 60_000);
                embed.setDescription(`Your tripwire is **armed** and waiting.\n\nExpires in **${remaining} min**.\nAny robber who succeeds against you will pay double the fine.`);
            } else {
                embed.setDescription(`You have **no active trap**.\n\nUse \`/trap set\` to arm one for **${currency}${TRAP_COST.toLocaleString()}**.`);
            }
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        // sub === 'set' — atomic: check balance + no active trap, deduct, arm in one query
        const now       = new Date();
        const expiresAt = new Date(Date.now() + TRAP_DURATION);

        const updated = await User.findOneAndUpdate(
            {
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                balance: { $gte: TRAP_COST },
                $or: [
                    { 'trap.expiresAt': null },
                    { 'trap.expiresAt': { $lte: now } }
                ]
            },
            {
                $inc: { balance: -TRAP_COST },
                $set: { 'trap.setAt': now, 'trap.expiresAt': expiresAt }
            },
            { new: true }
        );

        if (!updated) {
            // Determine which guard failed for a helpful message
            const trapActive = user.trap?.expiresAt && user.trap.expiresAt > new Date();
            if (trapActive) {
                const remaining = Math.ceil((user.trap.expiresAt - Date.now()) / 60_000);
                return interaction.reply({
                    content: `You already have a trap set! It expires in **${remaining} min**. You can only have one active trap at a time.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            return interaction.reply({
                content: `You need **${currency}${TRAP_COST.toLocaleString()}** to set a trap but only have **${currency}${user.balance.toLocaleString()}**.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        logTransaction({
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            type: 'trap_set',
            amount: -TRAP_COST,
            balance: updated.balance,
            note: 'tripwire set (12h)',
        });

        const embed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle('🪤 Trap Set!')
            .setDescription(
                `You've armed a **Tripwire** on your wallet.\n\n` +
                `The trap is **invisible** — any robber has no way to know it's there.\n\n` +
                `> **If a rob attempt succeeds:**\n` +
                `> The robber pays **2× the normal fine** — straight to you.\n\n` +
                `> **If a rob attempt fails:**\n` +
                `> The trap is preserved (not consumed).\n\n` +
                `Expires in **12 hours**.`
            )
            .addFields(
                { name: 'Cost',    value: `${currency}${TRAP_COST.toLocaleString()}`,   inline: true },
                { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`, inline: true },
                { name: 'Expires', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`, inline: true }
            )
            .setFooter({ text: 'Only one trap at a time. Use /trap status to check.' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
};
