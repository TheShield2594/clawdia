const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const Guild = require('../../models/Guild');
const User  = require('../../models/User');
const { logTransaction } = require('../../utils/logTransaction');
const {
    ROLES,
    TARGETS,
    getHeist,
    createLobby,
    joinLobby,
    endLobby,
    clearHeist,
    buildSkillCheck,
    calculateOutcome,
    computePayouts,
} = require('../../services/heistService');

const SKILL_TIMEOUT_MS = 30_000;
const LOBBY_POLL_MS    = 5_000; // edit lobby message every 5s

// ── Skill check DM helpers ─────────────────────────────────────────────────

function makeSkillRow(heistId, userId, check) {
    const row = new ActionRowBuilder();
    for (const choice of check.choices) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`heist_skill_${heistId}_${userId}_${String(choice)}`)
                .setLabel(String(choice))
                .setStyle(ButtonStyle.Primary)
        );
    }
    return row;
}

async function sendSkillCheck(member, heistId, role) {
    const check = buildSkillCheck(role);
    const roleMeta = ROLES[role];
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(`🔒 Heist In Progress — ${roleMeta.emoji} ${roleMeta.label} Check`)
        .setDescription(
            `**Your role:** ${roleMeta.label}\n${roleMeta.desc}\n\n` +
            `**Your challenge:**\n${check.question}\n\n` +
            `⏳ You have **30 seconds** to answer!`
        )
        .setFooter({ text: 'This is your private skill check — only you can see this.' });

    try {
        const dm = await member.send({ embeds: [embed], components: [makeSkillRow(heistId, member.id, check)] });
        return { dm, check };
    } catch {
        return { dm: null, check };
    }
}

// ── Lobby embed builder ────────────────────────────────────────────────────

function buildLobbyEmbed(heist) {
    const target = TARGETS[heist.target] ?? TARGETS.bank;
    const secondsLeft = Math.max(0, Math.floor((heist.lobbyEndsAt - Date.now()) / 1000));
    const roleLines = Object.entries(ROLES).map(([key, r]) => {
        const player = [...heist.players.entries()].find(([, p]) => p.role === key);
        return `${r.emoji} **${r.label}** — ${player ? `✅ ${player[1].username}` : '_open_'}`;
    });

    return new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎭 Heist Lobby — ${target.label}`)
        .setDescription(
            `**Initiator:** <@${heist.initiatorId}>\n\n` +
            `Pick a role and join the crew. Each role has a unique skill check that affects the payout.\n\n` +
            roleLines.join('\n')
        )
        .addFields({ name: '⏳ Lobby closes in', value: `${secondsLeft}s`, inline: true },
                   { name: '👥 Players', value: `${heist.players.size} / 4`, inline: true })
        .setFooter({ text: 'Click a role button below to join. Only one player per role.' })
        .setTimestamp();
}

function buildLobbyRows(heistId, heist) {
    const row = new ActionRowBuilder();
    for (const [key, r] of Object.entries(ROLES)) {
        const taken = [...heist.players.values()].some(p => p.role === key);
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`heist_join_${heistId}_${key}`)
                .setLabel(`${r.emoji} ${r.label}`)
                .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Primary)
                .setDisabled(taken)
        );
    }
    return [row];
}

// ── Heist resolution ───────────────────────────────────────────────────────

async function resolveHeist(client, heist) {
    // Atomic guard: prevent concurrent resolution from multiple timeout handlers
    // or simultaneous allDone checks.
    if (heist.resolving) return;
    heist.resolving = true;
    const guildId  = heist.guildId;
    const { outcome, passedCount, totalCount, ratio } = calculateOutcome(heist);
    const { share, total } = computePayouts(heist, passedCount, totalCount, ratio);
    const guildDoc = await Guild.findOne({ guildId }, 'economy heist').lean();
    const currency = guildDoc?.economy?.currency ?? '💰';
    const jailMins = guildDoc?.heist?.jailDurationMinutes ?? 30;

    const players = [...heist.players.entries()];
    const resultLines = [];

    for (const [userId, player] of players) {
        const roleMeta = ROLES[player.role];
        const passed   = player.skillPassed === true;
        const icon     = passed ? '✅' : '❌';
        resultLines.push(`${roleMeta.emoji} **${player.username}** (${roleMeta.label}) — ${icon} ${passed ? 'Passed' : 'Failed'}`);

        if (outcome === 'full_success' || (outcome === 'partial_success' && passed)) {
            await User.findOneAndUpdate(
                { userId, guildId },
                { $inc: { balance: share } }
            ).catch(() => {});
            if (share > 0) {
                const u = await User.findOne({ userId, guildId }, 'balance').lean();
                logTransaction({ userId, guildId, type: 'heist_payout', amount: share, balance: u?.balance ?? share, note: `Heist: ${TARGETS[heist.target]?.label}` });
            }
        } else if (outcome === 'failure' || (outcome === 'partial_success' && !passed)) {
            // Jail the caught players: lock economy commands and apply a fine
            // clamped to their current balance so it can't go negative.
            const jailUntil = new Date(Date.now() + jailMins * 60_000);
            const rawFine   = Math.floor(Math.random() * 200) + 50;
            const userDoc   = await User.findOne({ userId, guildId }, 'balance').lean();
            const fine      = Math.min(rawFine, userDoc?.balance ?? 0);
            await User.findOneAndUpdate(
                { userId, guildId },
                { $set: { heistJailedUntil: jailUntil }, ...(fine > 0 ? { $inc: { balance: -fine } } : {}) }
            ).catch(() => {});
        }
    }

    let title, desc, color;
    if (outcome === 'full_success') {
        title = '🎉 Heist Successful!';
        desc  = `Every crew member executed their role perfectly.\n\n**Payout:** ${currency}${share.toLocaleString()} each\n**Total stolen:** ${currency}${total.toLocaleString()}`;
        color = '#2ecc71';
    } else if (outcome === 'partial_success') {
        title = '⚠️ Partial Success';
        desc  = `Some crew members were caught, but the job got done.\n\n**Survivors earn:** ${currency}${share.toLocaleString()} each\n**Caught players** serve **${jailMins} min** jail time.`;
        color = '#f39c12';
    } else {
        title = '🚨 Heist Failed!';
        desc  = `The whole crew was caught. Everyone loses a fine and serves jail time (${jailMins} min).`;
        color = '#e74c3c';
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(desc)
        .addFields({ name: '👥 Crew Results', value: resultLines.join('\n') || '*No players*' })
        .setTimestamp();

    try {
        const dg = await client.guilds.fetch(guildId).catch(() => null);
        if (dg) {
            const channel = await dg.channels.fetch(heist.channelId).catch(() => null);
            if (channel?.isTextBased?.()) await channel.send({ embeds: [embed] });
        }
    } catch {}

    clearHeist(guildId);
}

// ── Button handler (called from interactionCreate) ─────────────────────────

async function handleHeistButton(interaction, client) {
    const id = interaction.customId;

    // heist_join_{heistId}_{role}
    // heistId = <guildId (digits)>-<timestamp (digits)>, no underscores
    // role is one of: hacker, lookout, muscle, driver — no underscores
    if (id.startsWith('heist_join_')) {
        const prefix     = 'heist_join_';
        const afterPrefix = id.slice(prefix.length);           // "{heistId}_{role}"
        const lastSep    = afterPrefix.lastIndexOf('_');
        if (lastSep === -1) return interaction.reply({ content: 'Malformed button ID.', flags: MessageFlags.Ephemeral });
        const heistId = afterPrefix.slice(0, lastSep);
        const role    = afterPrefix.slice(lastSep + 1);

        if (!/^\d+-\d+$/.test(heistId) || !ROLES[role]) {
            return interaction.reply({ content: 'Invalid heist button.', flags: MessageFlags.Ephemeral });
        }

        const guildId = interaction.guildId;
        const heist = getHeist(guildId);
        if (!heist || heist.heistId !== heistId || heist.phase !== 'lobby') {
            return interaction.reply({ content: 'This heist lobby is no longer active.', flags: MessageFlags.Ephemeral });
        }

        const result = joinLobby(guildId, interaction.user.id, interaction.user.username, role);
        if (!result.ok) {
            return interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
        }

        // Update the lobby embed
        await interaction.update({
            embeds: [buildLobbyEmbed(heist)],
            components: buildLobbyRows(heistId, heist)
        }).catch(() => {});
        return;
    }

    // heist_skill_{heistId}_{userId}_{answer}
    // heistId = <guildId>-<timestamp>, userId = Discord snowflake (digits), answer has no underscores
    if (id.startsWith('heist_skill_')) {
        const prefix      = 'heist_skill_';
        const afterPrefix = id.slice(prefix.length);          // "{heistId}_{userId}_{answer}"
        const lastSep     = afterPrefix.lastIndexOf('_');
        const beforeLast  = afterPrefix.lastIndexOf('_', lastSep - 1);
        if (lastSep === -1 || beforeLast === -1) {
            return interaction.reply({ content: 'Malformed skill-check button.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const answer  = afterPrefix.slice(lastSep + 1);
        const userId  = afterPrefix.slice(beforeLast + 1, lastSep);
        const heistId = afterPrefix.slice(0, beforeLast);

        // DM interactions don't carry guildId, so extract it from heistId (format: guildId-timestamp)
        let heist = null;
        const { activeHeists } = require('../../services/heistService');
        for (const [, h] of activeHeists) {
            if (h.heistId === heistId) { heist = h; break; }
        }

        if (!heist || !heist.players.has(userId)) {
            return interaction.reply({ content: 'This skill check has expired.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const player = heist.players.get(userId);
        if (player.skillPassed !== null) {
            return interaction.reply({ content: 'You already submitted your answer.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const check = heist._skillChecks?.[userId];
        const passed = check ? String(answer) === String(check.correct) : false;
        player.skillPassed = passed;

        // Clear the timeout for this player
        if (heist.skillTimers?.[userId]) {
            clearTimeout(heist.skillTimers[userId]);
            delete heist.skillTimers[userId];
        }

        await interaction.update({
            embeds: [
                new EmbedBuilder()
                    .setColor(passed ? '#2ecc71' : '#e74c3c')
                    .setTitle(passed ? '✅ Check Passed!' : '❌ Check Failed')
                    .setDescription(passed
                        ? 'You executed your role perfectly. Waiting for the rest of the crew…'
                        : `Wrong answer. The correct answer was **${check?.correct}**.\nYou may face jail time depending on the heist outcome.`)
                    .setTimestamp()
            ],
            components: []
        }).catch(() => {});

        // If all players have answered, resolve immediately
        const allDone = [...heist.players.values()].every(p => p.skillPassed !== null);
        if (allDone) {
            await resolveHeist(client, heist);
        }
    }
}

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

            // Periodically refresh the lobby embed countdown
            const refreshTimer = setInterval(async () => {
                if (heist.phase !== 'lobby') { clearInterval(refreshTimer); return; }
                await msg.edit({ embeds: [buildLobbyEmbed(heist)], components: buildLobbyRows(heist.heistId, heist) }).catch(() => {});
            }, LOBBY_POLL_MS);

            // Lobby timer
            setTimeout(async () => {
                clearInterval(refreshTimer);
                if (heist.phase !== 'lobby') return;

                const minPlayers = guildDoc.heist?.minPlayers ?? 2;
                if (heist.players.size < minPlayers) {
                    await msg.edit({
                        embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Heist Cancelled').setDescription(`Not enough crew members joined (need at least ${minPlayers}). Heist called off.`).setTimestamp()],
                        components: []
                    }).catch(() => {});
                    clearHeist(heist.guildId);
                    return;
                }

                endLobby(heist.guildId);
                await msg.edit({
                    embeds: [new EmbedBuilder().setColor('#9b59b6').setTitle('🔓 Heist Begins!').setDescription('The lobby is closed. Skill checks are being sent to each crew member via DM…\nResults will be posted here when everyone responds or time runs out.').setTimestamp()],
                    components: []
                }).catch(() => {});

                // Send skill checks via DM
                const dg = await client.guilds.fetch(heist.guildId).catch(() => null);
                heist._skillChecks = {};

                for (const [userId, player] of heist.players) {
                    const member = dg ? await dg.members.fetch(userId).catch(() => null) : null;
                    if (!member) {
                        player.skillPassed = false;
                        continue;
                    }
                    const { dm, check } = await sendSkillCheck(member, heist.heistId, player.role);
                    heist._skillChecks[userId] = check;

                    if (!dm) {
                        // Can't DM — auto-fail
                        player.skillPassed = false;
                    } else {
                        // Auto-fail on timeout
                        heist.skillTimers[userId] = setTimeout(async () => {
                            if (player.skillPassed !== null) return;
                            player.skillPassed = false;
                            await dm.edit({
                                embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('⏰ Time\'s up!').setDescription(`You ran out of time. The correct answer was **${check.correct}**.`).setTimestamp()],
                                components: []
                            }).catch(() => {});
                            const allDone = [...heist.players.values()].every(p => p.skillPassed !== null);
                            if (allDone) await resolveHeist(client, heist);
                        }, SKILL_TIMEOUT_MS);
                    }
                }

                // If everyone auto-failed (all DMs blocked), resolve immediately
                const allDone = [...heist.players.values()].every(p => p.skillPassed !== null);
                if (allDone) await resolveHeist(client, heist);

            }, lobbyDurationSeconds * 1000);
        }
    },

    handleHeistButton,
};
