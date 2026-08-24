const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { getPublicProtectionStatus, timeRemaining } = require('../../services/effectsService');
const COLORS = require('../../utils/embedColors');

const STATUS_COOLDOWN_MS = 2 * 60_000; // 2 minutes
const VICTIM_IMMUNITY_MS = 30 * 60_000;

// Per-user cooldown map (in-memory; resets on restart)
const statusCooldowns = new Map();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('robstatus')
        .setDescription("Spy on a target's active rob protections before committing to a heist.")
        .addUserOption(o =>
            o.setName('target')
                .setDescription('The user to check.')
                .setRequired(true)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.robEnabled === false) {
            return interaction.reply({ content: 'Robbing is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const target = interaction.options.getUser('target');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "Checking your own status is pointless.", flags: MessageFlags.Ephemeral });
        }
        if (target.bot) {
            return interaction.reply({ content: "Bots can't be robbed.", flags: MessageFlags.Ephemeral });
        }

        // Per-user cooldown
        const cdKey = `${interaction.user.id}_${interaction.guild.id}`;
        const lastUsed = statusCooldowns.get(cdKey) || 0;
        const elapsed  = Date.now() - lastUsed;
        if (elapsed < STATUS_COOLDOWN_MS) {
            const secs = Math.ceil((STATUS_COOLDOWN_MS - elapsed) / 1000);
            return interaction.reply({ content: `You're on cooldown. Try again in **${secs}s**.`, flags: MessageFlags.Ephemeral });
        }
        statusCooldowns.set(cdKey, Date.now());
        setTimeout(() => statusCooldowns.delete(cdKey), STATUS_COOLDOWN_MS);

        const [victim, robber] = await Promise.all([
            User.findOne({ userId: target.id,           guildId: interaction.guild.id }),
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
        ]);

        const lines = [];

        if (!victim) {
            lines.push('⬜ No data on this user — they may not have used the bot yet.');
        } else {
            const { shield, cloak } = getPublicProtectionStatus(victim);

            if (shield) {
                lines.push(`🛡️ **Protected** — this user has an active Shield (${timeRemaining(shield.expiresAt)} remaining)`);
            }
            if (cloak) {
                lines.push(`🧥 **Invisible** — this user has an active Invisibility Cloak (${timeRemaining(cloak.expiresAt)} remaining)`);
            }
            if (!shield && !cloak) {
                lines.push('✅ **No active blocking protection** detected.');
            }

            // Recent rob immunity
            if (victim.lastRobbedAt) {
                const immunityLeft = VICTIM_IMMUNITY_MS - (Date.now() - new Date(victim.lastRobbedAt).getTime());
                if (immunityLeft > 0) {
                    const mins = Math.ceil(immunityLeft / 60_000);
                    lines.push(`⏰ **Recently robbed** — immune for **${mins}m** more`);
                }
            }
        }

        const mySuccesses = robber?.successfulRobs ?? 0;
        const myFails     = robber?.failedRobs     ?? 0;
        const myTotal     = mySuccesses + myFails;
        const myRate      = myTotal > 0 ? `${Math.round((mySuccesses / myTotal) * 100)}%` : '—';

        const embed = new EmbedBuilder()
            .setColor(COLORS.RARE)
            .setTitle(`🔍 Rob Status: ${target.username}`)
            .setDescription(lines.join('\n'))
            .addFields({
                name: '📊 Your Heist Record',
                value: `✅ ${mySuccesses} successful · ❌ ${myFails} failed · 🎯 ${myRate} success rate`,
                inline: false,
            })
            .setFooter({ text: 'Padlock status is not revealed. Cooldown: 2m' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
