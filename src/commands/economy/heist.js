const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const Guild = require('../../models/Guild');
const User  = require('../../models/User');
const {
    getHeist,
    createLobby,
    startLobbyCountdown,
} = require('../../services/heistService');
const { buildLobbyEmbed, buildLobbyRows } = require('../../views/heistView');

// ── /heist command ─────────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('heist')
        .setDescription('Plan and execute a strategic group heist.')
        .addSubcommand(sub =>
            sub.setName('start')
               .setDescription('Initiate a heist lobby (60s join window).')
               .addStringOption(opt =>
                   opt.setName('target')
                      .setDescription('What to rob.')
                      .setRequired(false)
                      .addChoices(
                          { name: 'Server Bank', value: 'bank' },
                          { name: 'Faction Vault', value: 'vault' },
                          { name: 'Casino Safe', value: 'casino' }
                      )
               )
        )
        .addSubcommand(sub =>
            sub.setName('status')
               .setDescription('Check the status of the current heist.')
        ),

    cooldownKey: (interaction) => `heist:${interaction.options.getSubcommand()}`,
    cooldownAmount: () => 5,

    async execute(interaction, client) {
        const guildDoc = await Guild.findOne({ guildId: interaction.guild.id });

        if (!guildDoc?.economy?.enabled) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (!guildDoc?.heist?.enabled) {
            return interaction.reply({ content: 'The Heist system is not enabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === 'status') {
            const heist = getHeist(interaction.guild.id);
            if (!heist) return interaction.reply({ content: 'No heist is currently active.', flags: MessageFlags.Ephemeral });
            return interaction.reply({ embeds: [buildLobbyEmbed(heist)], flags: MessageFlags.Ephemeral });
        }

        // ── /heist start ──────────────────────────────────────────────────

        if (sub === 'start') {
            const existing = getHeist(interaction.guild.id);
            if (existing) {
                return interaction.reply({ content: 'A heist is already in progress in this server.', flags: MessageFlags.Ephemeral });
            }

            // Check jail
            const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            if (userDoc?.heistJailedUntil && userDoc.heistJailedUntil > new Date()) {
                const ts = Math.floor(userDoc.heistJailedUntil.getTime() / 1000);
                return interaction.reply({ content: `You're in jail! You can't start a heist until <t:${ts}:R>.`, flags: MessageFlags.Ephemeral });
            }

            // Cooldown check
            const cooldownHours = guildDoc.heist?.cooldownHours ?? 6;
            if (userDoc?.lastHeist) {
                const cooldownMs = cooldownHours * 60 * 60 * 1000;
                const diff = Date.now() - userDoc.lastHeist.getTime();
                if (diff < cooldownMs) {
                    const ts = Math.floor((userDoc.lastHeist.getTime() + cooldownMs) / 1000);
                    return interaction.reply({ content: `You're on heist cooldown! Try again <t:${ts}:R>.`, flags: MessageFlags.Ephemeral });
                }
            }

            const target = interaction.options.getString('target') || 'bank';
            const lobbyDurationSeconds = guildDoc.heist?.lobbyDurationSeconds ?? 60;
            const maxPayout            = guildDoc.heist?.maxPayout ?? 10000;

            const heist = createLobby({
                guildId: interaction.guild.id,
                channelId: interaction.channelId,
                initiatorId: interaction.user.id,
                target,
                lobbyDurationSeconds,
                maxPayout,
            });

            // Stamp lastHeist on initiator
            await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $set: { lastHeist: new Date() } },
                { upsert: true }
            );

            const embed  = buildLobbyEmbed(heist);
            const rows   = buildLobbyRows(heist.heistId, heist);
            const msg    = await interaction.reply({ embeds: [embed], components: rows, fetchReply: true });
            heist.lobbyMessage = msg;

            // The countdown, the DM'd skill checks and the resolution are the
            // heist itself, not the slash command that opened it (#614).
            startLobbyCountdown(client, heist, msg, {
                minPlayers: guildDoc.heist?.minPlayers ?? 2,
                lobbyDurationSeconds,
            });
        }
    },
};
