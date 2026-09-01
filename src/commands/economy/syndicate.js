const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const User = require('../../models/User');
const Syndicate = require('../../models/Syndicate');
const { logTransaction } = require('../../utils/logTransaction');
const { creditCoinsOrOwe } = require('../../utils/creditOrOwe');
const { crewSharePayoutKey } = require('../../utils/payoutKey');
const { buildSkillCheck } = require('../../services/heistService');
const {
    activeSyndicateHeists,
    SYNDICATE_TARGETS,
    SYNDICATE_ROLES,
    createSyndicateLobby,
    joinSyndicateLobby,
    endSyndicateLobby,
    clearSyndicateHeist,
    getSyndicateHeist,
    getEffectiveHeat,
    computeSyndicateOutcome,
} = require('../../services/syndicateService');
const { hasUnlock } = require('../../utils/prestige');
const COLORS = require('../../utils/embedColors');

const CREATION_COST    = 50_000;
const MAX_MEMBERS      = 10;
const MAX_MEMBERS_P7   = 12; // syndicate_extra_slot unlock (P7+)
const HEIST_COOLDOWN_H = 4;

// Returns the effective member cap for a syndicate based on the leader's
// account prestige rank (P7+ unlocks 2 extra slots via syndicate_extra_slot).
async function getMaxMembers(synDoc) {
    const leaderDoc = await User.findOne({ userId: synDoc.leaderId, guildId: synDoc.guildId }, 'accountPrestige').lean();
    const rank = leaderDoc?.accountPrestige?.rank ?? 0;
    return hasUnlock(rank, 'syndicate_extra_slot') ? MAX_MEMBERS_P7 : MAX_MEMBERS;
}
const LOBBY_DURATION_S = 60;
const SKILL_TIMEOUT_MS = 30_000;
const SABOTAGE_HEAT_COST = 20;

// ── UI helpers ─────────────────────────────────────────────────────────────

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function heatBar(heat) {
    const filled = Math.round(Math.min(100, Math.max(0, heat)) / 10);
    return `${'🟥'.repeat(filled)}${'⬛'.repeat(10 - filled)} ${heat}/100`;
}

function buildLobbyEmbed(heist, synName, target) {
    const secondsLeft = Math.max(0, Math.floor((heist.lobbyEndsAt - Date.now()) / 1000));
    const roleLines = Object.entries(SYNDICATE_ROLES).map(([key, r]) => {
        const player = [...heist.players.entries()].find(([, p]) => p.role === key);
        return `${r.emoji} **${r.label}** — ${player ? `✅ ${player[1].username}` : '_open_'}`;
    });
    const highHeat = heist.heatAtStart > 50;

    return new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(`${target.emoji} Syndicate Heist — ${target.label}`)
        .setDescription(
            `**Syndicate:** ${synName}\n` +
            `**Min. Crew Required:** ${target.minPlayers}\n` +
            (highHeat ? '⚠️ **High heat** — +20% payout, but extra risk!\n' : '') +
            '\n' + roleLines.join('\n')
        )
        .addFields(
            { name: '⏳ Lobby closes in', value: `${secondsLeft}s`, inline: true },
            { name: '👥 Crew so far',      value: `${heist.players.size}`, inline: true },
            { name: '🌡️ Heat',              value: heatBar(heist.heatAtStart), inline: false }
        )
        .setFooter({ text: 'Only syndicate members can join · one player per role' })
        .setTimestamp();
}

function buildLobbyRows(heistId, heist) {
    const roleEntries = Object.entries(SYNDICATE_ROLES);
    const rows = [];
    for (let i = 0; i < roleEntries.length; i += 5) {
        const row = new ActionRowBuilder();
        for (const [key, r] of roleEntries.slice(i, i + 5)) {
            const taken = [...heist.players.values()].some(p => p.role === key);
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`syn_join_${heistId}_${key}`)
                    .setLabel(`${r.emoji} ${r.label}`)
                    .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Primary)
                    .setDisabled(taken)
            );
        }
        rows.push(row);
    }
    return rows;
}

// ── Skill check DM helpers ─────────────────────────────────────────────────

function makeSkillRow(heistId, userId, check) {
    const row = new ActionRowBuilder();
    for (const choice of check.choices) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`syn_skill_${heistId}_${userId}_${String(choice)}`)
                .setLabel(String(choice))
                .setStyle(ButtonStyle.Primary)
        );
    }
    return row;
}

async function sendSkillCheck(member, heistId, role) {
    const roleMeta = SYNDICATE_ROLES[role];
    const check = buildSkillCheck(roleMeta.skillType);

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(`🔒 Syndicate Heist — ${roleMeta.emoji} ${roleMeta.label} Check`)
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

// ── Heist resolution ───────────────────────────────────────────────────────

async function resolveHeist(client, heist) {
    if (heist.resolving) return;
    heist.resolving = true;

    const target = SYNDICATE_TARGETS[heist.target];
    const { outcome, payout, perPlayer } = computeSyndicateOutcome(heist);

    const guildDoc = await getGuildSettings(heist.guildId);
    const currency = guildDoc?.economy?.currency ?? '💰';

    const players = [...heist.players.entries()];
    const resultLines = [];
    const failedCredits = [];

    for (const [userId, player] of players) {
        const roleMeta = SYNDICATE_ROLES[player.role];
        const passed   = player.skillPassed === true;
        resultLines.push(`${roleMeta.emoji} **${player.username}** (${roleMeta.label}) — ${passed ? '✅ Passed' : '❌ Failed'}`);

        const wins = (outcome === 'full_success') || (outcome === 'partial_success' && passed);
        if (wins && perPlayer > 0) {
            // This was three hand-rolled attempts around an unguarded `$inc`,
            // and it had both halves of the problem (#873). The retry could
            // double-credit — a `$inc` that commits and loses its response is
            // indistinguishable from one that never ran, and the next attempt
            // pays again — and `credited` was set from whether the call threw,
            // so a `findOneAndUpdate` that matched no document (which does not
            // throw) counted as paid and walked straight past the recovery
            // record written for exactly that case.
            //
            // The shared helper keys the credit, which is what makes the retry
            // safe, and files the debt where `npm run payouts:replay` can settle
            // it — the old record's `jobName` had no `.owed` suffix and its
            // payload no `kind`, so the replay could neither see it nor pay it.
            const paid = await creditCoinsOrOwe({ userId, guildId: heist.guildId }, perPlayer, {
                payoutKey: crewSharePayoutKey(heist.heistId, userId),
                service: 'syndicateService', jobName: 'syndicatePayout',
            });
            if (!paid.credited) {
                failedCredits.push({ userId, username: player.username, amount: perPlayer, recoveryLogged: paid.owed });
            } else {
                const u = await User.findOne({ userId, guildId: heist.guildId }, 'balance').lean();
                logTransaction({
                    userId,
                    guildId: heist.guildId,
                    type:    'syndicate_heist',
                    amount:  perPlayer,
                    balance: u?.balance ?? perPlayer,
                    note:    `Syndicate heist: ${target.label}`,
                });
            }
        }
    }

    // Persist heist results to the Syndicate document
    try {
        const synDoc = await Syndicate.findOne({ syndicateId: heist.syndicateId, guildId: heist.guildId });
        if (synDoc) {
            const heatGain = outcome !== 'bust' ? target.heatGain : 0;
            synDoc.lifetimeEarnings = (synDoc.lifetimeEarnings || 0) + payout;
            synDoc.heistCount       = (synDoc.heistCount || 0) + 1;
            synDoc.lastHeistAt      = new Date();
            synDoc.heat             = Math.min(100, Math.max(0, heist.heatAtStart + heatGain));
            await synDoc.save();
        }
    } catch (err) {
        console.error('[syndicate] Failed to update syndicate after heist:', err.message);
    }

    // Build result embed
    let title, desc, color;
    if (outcome === 'bust') {
        title = `🚨 ${target.label} — Busted!`;
        desc  = `Intelligence was wrong — enforcement was waiting. The crew escaped empty-handed.`;
        color = '#e74c3c';
    } else if (outcome === 'full_success') {
        title = `🎉 ${target.label} — Complete Success!`;
        desc  = `Flawless execution. Every crew member delivered.\n\n**Share:** ${currency}${perPlayer.toLocaleString()} each\n**Total haul:** ${currency}${payout.toLocaleString()}`;
        color = '#2ecc71';
    } else if (outcome === 'partial_success') {
        title = `⚠️ ${target.label} — Partial Success`;
        desc  = `The job got done, but some crew slipped up. Survivors collect their cut.\n\n**Survivors earn:** ${currency}${perPlayer.toLocaleString()} each`;
        color = '#f39c12';
    } else {
        title = `💀 ${target.label} — Operation Failed`;
        desc  = `Not enough crew completed their tasks. Nothing was collected.`;
        color = '#e74c3c';
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(desc)
        .addFields({ name: '👥 Crew Results', value: resultLines.join('\n') || '*No players*' })
        .setTimestamp();

    if (heist.sabotageCount > 0) {
        embed.addFields({
            name: '⚡ Sabotaged',
            value: `This heist was sabotaged **${heist.sabotageCount}** time(s) — success chance was reduced!`,
        });
    }

    if (failedCredits.length > 0) {
        embed.addFields({
            name: '⚠️ Payout Issue',
            value: failedCredits.map(f =>
                f.recoveryLogged
                    ? `Could not credit **${f.username}**'s share of ${currency}${f.amount.toLocaleString()} — it has been logged for recovery. Contact a server admin.`
                    : `Could not credit **${f.username}**'s share of ${currency}${f.amount.toLocaleString()} — and recovery logging also failed. Contact a server admin urgently with this message.`
            ).join('\n'),
        });
    }

    try {
        const dg = await client.guilds.fetch(heist.guildId).catch(() => null);
        if (dg) {
            const ch = await dg.channels.fetch(heist.channelId).catch(() => null);
            if (ch?.isTextBased?.()) await ch.send({ embeds: [embed] });
        }
    } catch {}

    clearSyndicateHeist(heist.guildId);
}

// ── Button handler (exported for interactionCreate) ────────────────────────

async function handleSyndicateButton(interaction, client) {
    const id = interaction.customId;

    // syn_join_{heistId}_{role}
    // heistId = syn-{guildId}-{ts} — uses hyphens only, no underscores
    if (id.startsWith('syn_join_')) {
        const afterPrefix = id.slice('syn_join_'.length);
        const parts = afterPrefix.split('_');
        if (parts.length < 2) {
            return interaction.reply({ content: 'Malformed button ID.', flags: MessageFlags.Ephemeral });
        }
        const heistId = parts[0];
        const role    = parts[1];

        if (!SYNDICATE_ROLES[role]) {
            return interaction.reply({ content: 'Invalid role.', flags: MessageFlags.Ephemeral });
        }

        const guildId = interaction.guildId;
        const heist   = getSyndicateHeist(guildId);
        if (!heist || heist.heistId !== heistId || heist.phase !== 'lobby') {
            return interaction.reply({ content: 'This heist lobby is no longer active.', flags: MessageFlags.Ephemeral });
        }

        // Only syndicate members may join
        const userDoc = await User.findOne({ userId: interaction.user.id, guildId }, 'syndicateId').lean();
        if (!userDoc?.syndicateId || userDoc.syndicateId !== heist.syndicateId) {
            return interaction.reply({ content: 'Only members of this syndicate can join.', flags: MessageFlags.Ephemeral });
        }

        const result = joinSyndicateLobby(guildId, interaction.user.id, interaction.user.username, role);
        if (!result.ok) {
            return interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
        }

        const synDoc = await Syndicate.findOne({ syndicateId: heist.syndicateId, guildId }, 'name').lean();
        const target = SYNDICATE_TARGETS[heist.target];

        await interaction.update({
            embeds:     [buildLobbyEmbed(heist, synDoc?.name ?? 'Unknown', target)],
            components: buildLobbyRows(heistId, heist),
        }).catch(() => {});
        return;
    }

    // syn_skill_{heistId}_{userId}_{answer}
    if (id.startsWith('syn_skill_')) {
        const afterPrefix = id.slice('syn_skill_'.length);
        const parts = afterPrefix.split('_');
        // parts[0] = heistId (syn-guildId-ts, no underscores)
        // parts[1] = userId
        // parts[2] = answer
        if (parts.length < 3) {
            return interaction.reply({ content: 'Malformed skill-check button.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const heistId = parts[0];
        const userId  = parts[1];
        const answer  = parts[2];

        // DM interactions have no guildId — find by heistId scan
        let heist = null;
        for (const [, h] of activeSyndicateHeists) {
            if (h.heistId === heistId) { heist = h; break; }
        }

        if (!heist || !heist.players.has(userId)) {
            return interaction.reply({ content: 'This skill check has expired.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const player = heist.players.get(userId);
        if (player.skillPassed !== null) {
            return interaction.reply({ content: 'You already submitted your answer.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const check  = heist._skillChecks?.[userId];
        const passed = check ? String(answer) === String(check.correct) : false;
        player.skillPassed = passed;

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
                        : `Wrong answer. The correct answer was **${check?.correct}**.\nThe overall outcome depends on how many others pass.`)
                    .setTimestamp(),
            ],
            components: [],
        }).catch(() => {});

        const allDone = [...heist.players.values()].every(p => p.skillPassed !== null);
        if (allDone) await resolveHeist(client, heist);
    }
}

// ── Subcommand handlers ────────────────────────────────────────────────────

async function executeCreate(interaction, guildDoc) {
    const name      = interaction.options.getString('name');
    const rawTag    = interaction.options.getString('tag');
    const openToJoin = interaction.options.getBoolean('open') ?? false;
    const currency  = guildDoc?.economy?.currency ?? '💰';

    if (name.length < 2 || name.length > 32) {
        return interaction.reply({ content: 'Syndicate name must be 2–32 characters.', flags: MessageFlags.Ephemeral });
    }
    if (rawTag && (rawTag.length < 2 || rawTag.length > 5)) {
        return interaction.reply({ content: 'Syndicate tag must be 2–5 characters.', flags: MessageFlags.Ephemeral });
    }

    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'balance syndicateId').lean();
    if (userDoc?.syndicateId) {
        return interaction.reply({ content: 'You are already in a syndicate. Leave it first.', flags: MessageFlags.Ephemeral });
    }

    const balance = userDoc?.balance ?? 0;
    if (balance < CREATION_COST) {
        return interaction.reply({
            content: `Creating a syndicate costs ${currency}${CREATION_COST.toLocaleString()}. You only have ${currency}${balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const existing = await Syndicate.findOne({
        guildId: interaction.guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
    }).lean();
    if (existing) {
        return interaction.reply({ content: `A syndicate named **${name}** already exists on this server.`, flags: MessageFlags.Ephemeral });
    }

    const tag         = rawTag ? rawTag.toUpperCase() : null;
    const syndicateId = `${interaction.guild.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // No multi-document transactions available (standalone MongoDB deployment), so
    // debit + enroll the user atomically first, then create the syndicate. If
    // creation fails, compensate by reverting the user's debit/enrollment.
    const debited = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: CREATION_COST }, syndicateId: null },
        { $inc: { balance: -CREATION_COST }, $set: { syndicateId } },
        { upsert: false, new: true }
    );
    if (!debited) {
        return interaction.reply({
            content: 'Could not create the syndicate — your balance or membership status changed. Please try again.',
            flags: MessageFlags.Ephemeral,
        });
    }

    try {
        await Syndicate.create({
            syndicateId,
            guildId: interaction.guild.id,
            name,
            nameLower: name.toLowerCase(),
            tag,
            leaderId:  interaction.user.id,
            memberIds: [interaction.user.id],
            openToJoin,
        });
    } catch (err) {
        await User.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id, syndicateId },
            { $inc: { balance: CREATION_COST }, $set: { syndicateId: null } },
        );
        throw err;
    }

    logTransaction({
        userId:  interaction.user.id,
        guildId: interaction.guild.id,
        type:    'syndicate_create',
        amount:  -CREATION_COST,
        balance: debited.balance,
        note:    `Founded syndicate: ${name}`,
    });

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('🦹 Syndicate Founded!')
        .setDescription(
            `**${name}**${tag ? ` [${tag}]` : ''} is now operational.\n\n` +
            `You spent ${currency}${CREATION_COST.toLocaleString()} to establish it.\n` +
            `Invite members with \`/syndicate invite @user\`, or enable open joining.`
        )
        .addFields(
            { name: 'Membership', value: openToJoin ? 'Open' : 'Invite-only', inline: true },
            { name: 'Members',    value: `1 / ${MAX_MEMBERS}`,                inline: true }
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeJoin(interaction) {
    const name    = interaction.options.getString('name');
    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (userDoc?.syndicateId) {
        return interaction.reply({ content: 'You are already in a syndicate. Leave it first.', flags: MessageFlags.Ephemeral });
    }

    const synDoc = await Syndicate.findOne({
        guildId: interaction.guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
    });
    if (!synDoc) {
        return interaction.reply({ content: `No syndicate named **${name}** was found on this server.`, flags: MessageFlags.Ephemeral });
    }

    const memberCap = await getMaxMembers(synDoc);
    if (synDoc.memberIds.length >= memberCap) {
        return interaction.reply({ content: `**${synDoc.name}** is full (${memberCap} members).`, flags: MessageFlags.Ephemeral });
    }

    const inInvites = synDoc.pendingInvites.includes(interaction.user.id);
    if (!synDoc.openToJoin && !inInvites) {
        return interaction.reply({ content: `**${synDoc.name}** is invite-only. Ask the leader to send you an invite.`, flags: MessageFlags.Ephemeral });
    }

    synDoc.memberIds.push(interaction.user.id);
    if (inInvites) synDoc.pendingInvites = synDoc.pendingInvites.filter(id => id !== interaction.user.id);
    await synDoc.save();

    await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $set: { syndicateId: synDoc.syndicateId } },
        { upsert: true }
    );

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('🦹 Joined Syndicate')
        .setDescription(`You've joined **${synDoc.name}**${synDoc.tag ? ` [${synDoc.tag}]` : ''}! You are member ${synDoc.memberIds.length} of ${memberCap}.`)
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeLeave(interaction) {
    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (!userDoc?.syndicateId) {
        return interaction.reply({ content: 'You are not in a syndicate.', flags: MessageFlags.Ephemeral });
    }

    const synDoc = await Syndicate.findOne({ syndicateId: userDoc.syndicateId, guildId: interaction.guild.id });
    if (!synDoc) {
        await User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, { $set: { syndicateId: null } });
        return interaction.reply({ content: 'Your syndicate no longer exists. Membership cleared.', flags: MessageFlags.Ephemeral });
    }

    if (synDoc.leaderId === interaction.user.id) {
        if (synDoc.memberIds.length > 1) {
            return interaction.reply({
                content: `You are the leader of **${synDoc.name}**. Kick all other members first with \`/syndicate kick\`, then \`/syndicate leave\` to disband.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // Last member — auto-disband
        await Syndicate.deleteOne({ syndicateId: synDoc.syndicateId });
        await User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, { $set: { syndicateId: null } });
        return interaction.reply({ content: `**${synDoc.name}** has been disbanded.`, flags: MessageFlags.Ephemeral });
    }

    synDoc.memberIds = synDoc.memberIds.filter(id => id !== interaction.user.id);
    await synDoc.save();
    await User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, { $set: { syndicateId: null } });

    return interaction.reply({ content: `You have left **${synDoc.name}**.`, flags: MessageFlags.Ephemeral });
}

async function executeInvite(interaction) {
    const target  = interaction.options.getUser('user');
    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (!userDoc?.syndicateId) {
        return interaction.reply({ content: 'You are not in a syndicate.', flags: MessageFlags.Ephemeral });
    }

    const synDoc = await Syndicate.findOne({ syndicateId: userDoc.syndicateId, guildId: interaction.guild.id });
    if (!synDoc) return interaction.reply({ content: 'Your syndicate no longer exists.', flags: MessageFlags.Ephemeral });

    if (synDoc.leaderId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the syndicate leader can invite members.', flags: MessageFlags.Ephemeral });
    }
    if (target.id === interaction.user.id) {
        return interaction.reply({ content: "You can't invite yourself.", flags: MessageFlags.Ephemeral });
    }
    if (synDoc.memberIds.includes(target.id)) {
        return interaction.reply({ content: `<@${target.id}> is already a member.`, flags: MessageFlags.Ephemeral });
    }
    if (synDoc.pendingInvites.includes(target.id)) {
        return interaction.reply({ content: `<@${target.id}> already has a pending invite.`, flags: MessageFlags.Ephemeral });
    }
    const memberCap = await getMaxMembers(synDoc);
    if (synDoc.memberIds.length >= memberCap) {
        return interaction.reply({ content: `Your syndicate is full (${memberCap} members).`, flags: MessageFlags.Ephemeral });
    }

    const targetDoc = await User.findOne({ userId: target.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (targetDoc?.syndicateId) {
        return interaction.reply({ content: `<@${target.id}> is already in a syndicate.`, flags: MessageFlags.Ephemeral });
    }

    synDoc.pendingInvites.push(target.id);
    await synDoc.save();

    return interaction.reply({
        content: `<@${target.id}> has been invited to **${synDoc.name}**. They can accept with \`/syndicate join ${synDoc.name}\`.`,
    });
}

async function executeKick(interaction) {
    const target  = interaction.options.getUser('user');
    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (!userDoc?.syndicateId) return interaction.reply({ content: 'You are not in a syndicate.', flags: MessageFlags.Ephemeral });

    const synDoc = await Syndicate.findOne({ syndicateId: userDoc.syndicateId, guildId: interaction.guild.id });
    if (!synDoc) return interaction.reply({ content: 'Your syndicate no longer exists.', flags: MessageFlags.Ephemeral });

    if (synDoc.leaderId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the syndicate leader can kick members.', flags: MessageFlags.Ephemeral });
    }
    if (target.id === interaction.user.id) {
        return interaction.reply({ content: "Use `/syndicate leave` to leave your own syndicate.", flags: MessageFlags.Ephemeral });
    }
    if (!synDoc.memberIds.includes(target.id)) {
        return interaction.reply({ content: `<@${target.id}> is not a member of your syndicate.`, flags: MessageFlags.Ephemeral });
    }

    synDoc.memberIds = synDoc.memberIds.filter(id => id !== target.id);
    await synDoc.save();

    await User.findOneAndUpdate(
        { userId: target.id, guildId: interaction.guild.id },
        { $set: { syndicateId: null } }
    );

    return interaction.reply({ content: `<@${target.id}> has been kicked from **${synDoc.name}**.` });
}

async function executeOpen(interaction) {
    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (!userDoc?.syndicateId) return interaction.reply({ content: 'You are not in a syndicate.', flags: MessageFlags.Ephemeral });

    const synDoc = await Syndicate.findOne({ syndicateId: userDoc.syndicateId, guildId: interaction.guild.id });
    if (!synDoc) return interaction.reply({ content: 'Your syndicate no longer exists.', flags: MessageFlags.Ephemeral });

    if (synDoc.leaderId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the syndicate leader can change membership settings.', flags: MessageFlags.Ephemeral });
    }

    synDoc.openToJoin = !synDoc.openToJoin;
    await synDoc.save();

    return interaction.reply({
        content: `**${synDoc.name}** is now **${synDoc.openToJoin ? 'open — anyone can join' : 'invite-only'}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function executeInfo(interaction, guildDoc) {
    const nameOpt = interaction.options.getString('name');
    const currency = guildDoc?.economy?.currency ?? '💰';

    let synDoc;
    if (nameOpt) {
        synDoc = await Syndicate.findOne({
            guildId: interaction.guild.id,
            name: { $regex: new RegExp(`^${escapeRegex(nameOpt)}$`, 'i') },
        });
        if (!synDoc) return interaction.reply({ content: `No syndicate named **${nameOpt}** was found.`, flags: MessageFlags.Ephemeral });
    } else {
        const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
        if (!userDoc?.syndicateId) {
            return interaction.reply({ content: 'You are not in a syndicate. Provide a name to look one up.', flags: MessageFlags.Ephemeral });
        }
        synDoc = await Syndicate.findOne({ syndicateId: userDoc.syndicateId, guildId: interaction.guild.id });
        if (!synDoc) return interaction.reply({ content: 'Your syndicate no longer exists.', flags: MessageFlags.Ephemeral });
    }

    const effectiveHeat = getEffectiveHeat(synDoc);
    const activeHeist   = getSyndicateHeist(interaction.guild.id);
    const hasActiveHeist = activeHeist?.syndicateId === synDoc.syndicateId;

    const memberCap = await getMaxMembers(synDoc);
    const memberLines = synDoc.memberIds.slice(0, memberCap).map((id, i) =>
        id === synDoc.leaderId ? `👑 <@${id}>` : `${i + 1}. <@${id}>`
    );

    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(`🦹 ${synDoc.name}${synDoc.tag ? ` [${synDoc.tag}]` : ''}`)
        .addFields(
            { name: '🌡️ Heat',              value: heatBar(effectiveHeat),                                                  inline: false },
            { name: '💰 Lifetime Earnings', value: `${currency}${(synDoc.lifetimeEarnings || 0).toLocaleString()}`,         inline: true },
            { name: '🎯 Heists Pulled',     value: String(synDoc.heistCount || 0),                                          inline: true },
            { name: '👥 Members',           value: `${synDoc.memberIds.length} / ${memberCap}`,                           inline: true },
            { name: '🚪 Membership',        value: synDoc.openToJoin ? 'Open' : 'Invite-only',                              inline: true },
            { name: '⚡ Active Heist',      value: hasActiveHeist ? 'In progress' : 'None',                                 inline: true },
            { name: '👤 Crew',              value: memberLines.join('\n') || '*none*',                                       inline: false }
        )
        .setFooter({ text: `Founded ${synDoc.createdAt.toLocaleDateString()}` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeLeaderboard(interaction, guildDoc) {
    const currency = guildDoc?.economy?.currency ?? '💰';
    const top = await Syndicate.find({ guildId: interaction.guild.id })
        .sort({ lifetimeEarnings: -1 })
        .limit(10)
        .lean();

    if (!top.length) {
        return interaction.reply({ content: 'No syndicates have been founded on this server yet.', flags: MessageFlags.Ephemeral });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = top.map((syn, i) => {
        const rank = medals[i] ?? `${i + 1}.`;
        const tag  = syn.tag ? ` [${syn.tag}]` : '';
        return `${rank} **${syn.name}**${tag} — ${currency}${(syn.lifetimeEarnings || 0).toLocaleString()} · ${syn.memberIds.length} members · Heat ${syn.heat || 0}`;
    });

    const embed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('🏆 Syndicate Leaderboard')
        .setDescription(lines.join('\n'))
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeHeist(interaction, guildDoc, client) {
    const targetKey = interaction.options.getString('target');
    const target    = SYNDICATE_TARGETS[targetKey];
    if (!target) return interaction.reply({ content: 'Invalid heist target.', flags: MessageFlags.Ephemeral });

    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (!userDoc?.syndicateId) return interaction.reply({ content: 'You are not in a syndicate.', flags: MessageFlags.Ephemeral });

    const synDoc = await Syndicate.findOne({ syndicateId: userDoc.syndicateId, guildId: interaction.guild.id });
    if (!synDoc) return interaction.reply({ content: 'Your syndicate no longer exists.', flags: MessageFlags.Ephemeral });

    if (synDoc.leaderId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the syndicate leader can initiate a heist.', flags: MessageFlags.Ephemeral });
    }
    if (target.requiresUpgrade && !synDoc.upgrades?.includes(target.requiresUpgrade)) {
        const upgrade = SYNDICATE_UPGRADES[target.requiresUpgrade];
        return interaction.reply({
            content: `**${target.label}** requires the **${upgrade?.label ?? target.requiresUpgrade}** upgrade. Purchase it with \`/syndicate upgrade\`.`,
            flags: MessageFlags.Ephemeral,
        });
    }
    const hasExtraSlot   = synDoc.upgrades?.includes('extra_heist_slot');
    const effectiveMinPlayers = hasExtraSlot ? Math.max(2, target.minPlayers - 1) : target.minPlayers;
    if (synDoc.memberIds.length < effectiveMinPlayers) {
        return interaction.reply({
            content: `**${target.label}** requires at least ${effectiveMinPlayers} syndicate members. You only have ${synDoc.memberIds.length}.`,
            flags: MessageFlags.Ephemeral,
        });
    }
    if (getSyndicateHeist(interaction.guild.id)) {
        return interaction.reply({ content: 'A syndicate heist is already active on this server.', flags: MessageFlags.Ephemeral });
    }

    const hasCooldownReduction = synDoc.upgrades?.includes('cooldown_reduction');
    const cooldownMs = (hasCooldownReduction ? HEIST_COOLDOWN_H - 1 : HEIST_COOLDOWN_H) * 60 * 60 * 1000;
    if (synDoc.lastHeistAt && (Date.now() - synDoc.lastHeistAt.getTime()) < cooldownMs) {
        const ts = Math.floor((synDoc.lastHeistAt.getTime() + cooldownMs) / 1000);
        return interaction.reply({
            content: `**${synDoc.name}** is on cooldown. Next heist available <t:${ts}:R>.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const currentHeat = getEffectiveHeat(synDoc);
    const heist = createSyndicateLobby({
        guildId:             interaction.guild.id,
        channelId:           interaction.channelId,
        syndicateId:         synDoc.syndicateId,
        leaderId:            interaction.user.id,
        target:              targetKey,
        lobbyDurationSeconds: LOBBY_DURATION_S,
        currentHeat,
    });

    const embed = buildLobbyEmbed(heist, synDoc.name, target);
    const rows  = buildLobbyRows(heist.heistId, heist);
    const msg   = await interaction.reply({ embeds: [embed], components: rows, fetchReply: true });
    heist.lobbyMessage = msg;

    // Periodic countdown refresh
    const refreshTimer = setInterval(async () => {
        if (heist.phase !== 'lobby') { clearInterval(refreshTimer); return; }
        await msg.edit({
            embeds:     [buildLobbyEmbed(heist, synDoc.name, target)],
            components: buildLobbyRows(heist.heistId, heist),
        }).catch(() => {});
    }, 5_000);

    // Lobby expiry
    setTimeout(async () => {
        clearInterval(refreshTimer);
        if (heist.phase !== 'lobby') return;

        if (heist.players.size < effectiveMinPlayers) {
            await msg.edit({
                embeds: [new EmbedBuilder()
                    .setColor(COLORS.ERROR)
                    .setTitle('❌ Heist Cancelled')
                    .setDescription(`Not enough crew joined (need ${effectiveMinPlayers}, got ${heist.players.size}). **${synDoc.name}**'s operation is called off.`)
                    .setTimestamp()],
                components: [],
            }).catch(() => {});
            clearSyndicateHeist(heist.guildId);
            return;
        }

        endSyndicateLobby(heist.guildId);
        await msg.edit({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.RARE)
                .setTitle('🔓 Heist Underway!')
                .setDescription('Lobby closed. Skill checks are being sent to each crew member via DM.\nResults will post here when everyone responds or time runs out.')
                .setTimestamp()],
            components: [],
        }).catch(() => {});

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
                player.skillPassed = false;
            } else {
                heist.skillTimers[userId] = setTimeout(async () => {
                    if (player.skillPassed !== null) return;
                    player.skillPassed = false;
                    await dm.edit({
                        embeds: [new EmbedBuilder()
                            .setColor(COLORS.ERROR)
                            .setTitle("⏰ Time's up!")
                            .setDescription(`You ran out of time. The correct answer was **${check.correct}**.`)
                            .setTimestamp()],
                        components: [],
                    }).catch(() => {});
                    const allDone = [...heist.players.values()].every(p => p.skillPassed !== null);
                    if (allDone) await resolveHeist(client, heist);
                }, SKILL_TIMEOUT_MS);
            }
        }

        const allDone = [...heist.players.values()].every(p => p.skillPassed !== null);
        if (allDone) await resolveHeist(client, heist);

    }, LOBBY_DURATION_S * 1000);
}

async function executeSabotage(interaction, _guildDoc) {
    const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'syndicateId').lean();
    if (!userDoc?.syndicateId) return interaction.reply({ content: 'You are not in a syndicate.', flags: MessageFlags.Ephemeral });

    const synDoc = await Syndicate.findOne({ syndicateId: userDoc.syndicateId, guildId: interaction.guild.id });
    if (!synDoc) return interaction.reply({ content: 'Your syndicate no longer exists.', flags: MessageFlags.Ephemeral });

    if (synDoc.leaderId !== interaction.user.id) {
        return interaction.reply({ content: 'Only the syndicate leader can perform a sabotage.', flags: MessageFlags.Ephemeral });
    }

    const activeHeist = getSyndicateHeist(interaction.guild.id);
    if (!activeHeist) {
        return interaction.reply({ content: 'There is no active syndicate heist on this server to sabotage.', flags: MessageFlags.Ephemeral });
    }
    if (activeHeist.syndicateId === synDoc.syndicateId) {
        return interaction.reply({ content: "You can't sabotage your own heist.", flags: MessageFlags.Ephemeral });
    }
    if (activeHeist.phase === 'lobby') {
        return interaction.reply({ content: 'The rival heist is still in the lobby phase. Sabotage can only be used once it has started.', flags: MessageFlags.Ephemeral });
    }

    const effectiveHeat = getEffectiveHeat(synDoc);
    if (effectiveHeat < SABOTAGE_HEAT_COST) {
        return interaction.reply({
            content: `Sabotage costs **${SABOTAGE_HEAT_COST} heat**. **${synDoc.name}** only has **${effectiveHeat}** heat. Run more heists to build it up.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const rivalDoc = await Syndicate.findOne({ syndicateId: activeHeist.syndicateId, guildId: interaction.guild.id }, 'name').lean();
    const rivalName = rivalDoc?.name ?? 'Unknown Syndicate';

    // Deduct heat from saboteur's syndicate
    synDoc.heat = Math.max(0, effectiveHeat - SABOTAGE_HEAT_COST);
    await synDoc.save();

    // Apply sabotage to the rival heist
    activeHeist.sabotageCount++;

    const embed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('⚡ Sabotage Deployed!')
        .setDescription(
            `**${synDoc.name}** has compromised **${rivalName}**'s ongoing heist!\n\n` +
            `Their success chance has been reduced by **15%**.\n` +
            `Cost to you: **${SABOTAGE_HEAT_COST} heat** (${effectiveHeat} → ${synDoc.heat})`
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ── Syndicate upgrade tree ──────────────────────────────────────────────────

const SYNDICATE_UPGRADES = {
    extra_heist_slot:   { label: 'Extra Heist Slot',     emoji: '🎯', earningsRequired: 100_000,  description: 'Reduces the crew requirement for every heist target by 1 player.' },
    cooldown_reduction: { label: 'Cooldown Reduction',   emoji: '⏱️', earningsRequired: 500_000,  description: 'Reduces your heist cooldown by 1 hour (3h instead of 4h).' },
    fourth_target:      { label: 'Fourth Target',         emoji: '🏦', earningsRequired: 1_000_000, description: 'Unlocks the Vault Breach heist target exclusive to upgraded syndicates.' },
};

async function executeUpgrade(interaction, guildDoc) {
    const upgradeId = interaction.options.getString('id');
    const upgrade   = SYNDICATE_UPGRADES[upgradeId];
    if (!upgrade) {
        return interaction.reply({ content: 'Unknown upgrade.', flags: MessageFlags.Ephemeral });
    }

    const synDoc = await Syndicate.findOne({ guildId: interaction.guild.id, leaderId: interaction.user.id });
    if (!synDoc) {
        return interaction.reply({ content: 'You must be the **leader** of a syndicate to purchase upgrades.', flags: MessageFlags.Ephemeral });
    }

    if (synDoc.upgrades?.includes(upgradeId)) {
        return interaction.reply({ content: `**${upgrade.emoji} ${upgrade.label}** is already purchased.`, flags: MessageFlags.Ephemeral });
    }

    if (synDoc.lifetimeEarnings < upgrade.earningsRequired) {
        const need = upgrade.earningsRequired - synDoc.lifetimeEarnings;
        return interaction.reply({
            content: `Your syndicate needs **${upgrade.earningsRequired.toLocaleString()} lifetime earnings** for this upgrade. You have **${synDoc.lifetimeEarnings.toLocaleString()}** — **${need.toLocaleString()} more** needed.`,
            flags: MessageFlags.Ephemeral
        });
    }

    synDoc.upgrades = [...(synDoc.upgrades ?? []), upgradeId];
    await synDoc.save();

    const currency = guildDoc?.economy?.currency ?? '💰';
    const embed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(`${upgrade.emoji} Upgrade Purchased: ${upgrade.label}`)
        .setDescription(
            `**${synDoc.name}** has unlocked a new upgrade!\n\n` +
            `> ${upgrade.description}\n\n` +
            `**Lifetime Earnings:** ${currency}${synDoc.lifetimeEarnings.toLocaleString()}\n` +
            `**Upgrades owned:** ${synDoc.upgrades.length} / ${Object.keys(SYNDICATE_UPGRADES).length}`
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ── Command definition ─────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('syndicate')
        .setDescription('Crime syndicate system — cooperative heists, territory, and rivalry.')
        .addSubcommand(sub => sub
            .setName('create')
            .setDescription(`Found a new syndicate (costs ${CREATION_COST.toLocaleString()} coins).`)
            .addStringOption(opt => opt.setName('name').setDescription('Syndicate name (2–32 chars)').setRequired(true))
            .addStringOption(opt => opt.setName('tag').setDescription('Short tag shown on the leaderboard (2–5 chars)').setRequired(false))
            .addBooleanOption(opt => opt.setName('open').setDescription('Allow anyone to join without an invite (default: false)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('join')
            .setDescription('Join an open syndicate or accept an invite.')
            .addStringOption(opt => opt.setName('name').setDescription('Syndicate name').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('leave')
            .setDescription('Leave your current syndicate (leaders must kick all members first).')
        )
        .addSubcommand(sub => sub
            .setName('invite')
            .setDescription('Invite a player to your syndicate (leader only).')
            .addUserOption(opt => opt.setName('user').setDescription('User to invite').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('kick')
            .setDescription('Kick a member from your syndicate (leader only).')
            .addUserOption(opt => opt.setName('user').setDescription('Member to kick').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('open')
            .setDescription('Toggle open / invite-only membership for your syndicate (leader only).')
        )
        .addSubcommand(sub => sub
            .setName('info')
            .setDescription('View syndicate details.')
            .addStringOption(opt => opt.setName('name').setDescription('Syndicate name (defaults to your own)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('leaderboard')
            .setDescription('Top syndicates on this server by lifetime heist earnings.')
        )
        .addSubcommand(sub => sub
            .setName('heist')
            .setDescription('Plan and initiate a cooperative syndicate heist (leader only, 3+ members required).')
            .addStringOption(opt => opt
                .setName('target')
                .setDescription('The target to hit.')
                .setRequired(true)
                .addChoices(
                    { name: 'Bank Job (3 players, 45% base, 10k–25k)', value: 'bank_job' },
                    { name: 'Museum Heist (5 players, 30% base, 30k–80k)', value: 'museum_heist' },
                    { name: 'City Hall Con (7 players, 20% base, 100k–200k)', value: 'city_hall_con' },
                    { name: 'Vault Breach (9 players, 15% base, 250k–500k) — requires Fourth Target upgrade', value: 'vault_breach' }
                )
            )
        )
        .addSubcommand(sub => sub
            .setName('sabotage')
            .setDescription(`Sabotage an active rival heist (costs ${SABOTAGE_HEAT_COST} heat from your syndicate).`)
        )
        .addSubcommand(sub => sub
            .setName('upgrade')
            .setDescription('Purchase a syndicate upgrade using lifetime earnings (leader only).')
            .addStringOption(opt =>
                opt.setName('id')
                    .setDescription('Upgrade to purchase')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Extra Heist Slot (100k earnings) — -1 crew required per target', value: 'extra_heist_slot' },
                        { name: 'Cooldown Reduction (500k earnings) — -1h heist cooldown', value: 'cooldown_reduction' },
                        { name: 'Fourth Target (1M earnings) — unlocks Vault Breach', value: 'fourth_target' }
                    )
            )
        ),

    cooldownKey:    (interaction) => `syndicate:${interaction.options.getSubcommand()}`,
    cooldownAmount: () => 5,

    async execute(interaction, client) {
        const guildDoc = await getGuildSettings(interaction.guild.id);

        if (!guildDoc?.economy?.enabled) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();

        // Info and leaderboard are read-only — no syndicates.enabled gate
        if (!['info', 'leaderboard'].includes(sub) && !guildDoc?.syndicates?.enabled) {
            return interaction.reply({ content: 'The syndicate system is not enabled on this server. An admin can enable it in server settings.', flags: MessageFlags.Ephemeral });
        }

        switch (sub) {
            case 'create':      return executeCreate(interaction, guildDoc);
            case 'join':        return executeJoin(interaction);
            case 'leave':       return executeLeave(interaction);
            case 'invite':      return executeInvite(interaction);
            case 'kick':        return executeKick(interaction);
            case 'open':        return executeOpen(interaction);
            case 'info':        return executeInfo(interaction, guildDoc);
            case 'leaderboard': return executeLeaderboard(interaction, guildDoc);
            case 'heist':       return executeHeist(interaction, guildDoc, client);
            case 'sabotage':    return executeSabotage(interaction, guildDoc);
            case 'upgrade':     return executeUpgrade(interaction, guildDoc);
        }
    },

    handleSyndicateButton,
};
module.exports.__test__ = { resolveHeist };  // where the crew's shares are paid
