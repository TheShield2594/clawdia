// In-memory state for active heist lobbies and in-progress heists.
// Keyed by guildId so only one heist can run per guild at a time.
//
// Same boundary as src/utils/crashLobby.js: a heist is a sequence of role
// minigames driven by collectors on live messages, so the session cannot be
// moved to Mongo without redesigning the round itself. A second process would
// allow two concurrent heists in one guild, and a restart abandons one — the
// payout is credited per participant with an `$inc` at the end, so neither
// duplicates anyone's coins. The per-user action lock, which is the thing that
// actually gates money, is in Mongo; see src/utils/activeGameLock.js.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const Guild = require('../models/Guild');
const User  = require('../models/User');
const { assertGuildAffinity } = require('../utils/sharding');
const { logTransaction } = require('../utils/logTransaction');
const { debitUpTo } = require('../utils/balanceDebit');
const { ROLES, TARGETS } = require('../data/heistData');
const { makeSkillRow, buildLobbyEmbed, buildLobbyRows } = require('../views/heistView');

const SKILL_TIMEOUT_MS = 30_000;
const LOBBY_POLL_MS    = 5_000; // edit the lobby message every 5s

const activeHeists = new Map();

function generateHeistId(guildId) {
    return `${guildId}-${Date.now()}`;
}

function getHeist(guildId) {
    return activeHeists.get(guildId) ?? null;
}

function createLobby({ guildId, channelId, initiatorId, target, lobbyDurationSeconds, maxPayout }) {
    const safeDuration = (Number.isFinite(lobbyDurationSeconds) && lobbyDurationSeconds > 0) ? lobbyDurationSeconds : 60;
    const safePayout   = (Number.isFinite(maxPayout) && maxPayout > 0) ? maxPayout : 10000;
    lobbyDurationSeconds = safeDuration;
    maxPayout = safePayout;
    const heistId = generateHeistId(guildId);
    const state = {
        heistId,
        guildId,
        channelId,
        initiatorId,
        target: TARGETS[target] ? target : 'bank',
        lobbyEndsAt: new Date(Date.now() + lobbyDurationSeconds * 1000),
        phase: 'lobby',
        players: new Map(), // userId -> { role, username, skillPassed: null }
        maxPayout,
        lobbyMessage: null,
        skillResults: {},
        skillTimers: {},
    };
    // One heist per guild only holds while one shard handles that guild; see
    // src/utils/sharding.js (#732).
    assertGuildAffinity(guildId, 'heist lobby');
    activeHeists.set(guildId, state);
    return state;
}

function joinLobby(guildId, userId, username, role) {
    const heist = activeHeists.get(guildId);
    if (!heist || heist.phase !== 'lobby') return { ok: false, reason: 'No active lobby.' };
    if (!ROLES[role]) return { ok: false, reason: 'Invalid role.' };

    // Each role can only be taken once
    for (const [pid, p] of heist.players) {
        if (p.role === role) return { ok: false, reason: `The ${ROLES[role].label} role is already taken.` };
        if (pid === userId) return { ok: false, reason: 'You already joined this heist.' };
    }

    heist.players.set(userId, { role, username, skillPassed: null });
    return { ok: true };
}

function endLobby(guildId) {
    const heist = activeHeists.get(guildId);
    if (!heist) return null;
    heist.phase = 'active';
    return heist;
}

function clearHeist(guildId) {
    const heist = activeHeists.get(guildId);
    if (heist) {
        // Cancel any outstanding skill check timers
        for (const timer of Object.values(heist.skillTimers || {})) {
            clearTimeout(timer);
        }
    }
    activeHeists.delete(guildId);
}

// ── Skill check generators ─────────────────────────────────────────────────

function makeHackerCheck() {
    // Simple arithmetic question with 4 choices
    const a = Math.floor(Math.random() * 20) + 5;
    const b = Math.floor(Math.random() * 20) + 5;
    const ops = [
        { op: '+', answer: a + b },
        { op: '×', answer: a * b },
        { op: '-', answer: Math.max(a, b) - Math.min(a, b) },
    ];
    const chosen = ops[Math.floor(Math.random() * ops.length)];
    const correct = chosen.answer;
    const question = `What is **${a} ${chosen.op} ${b}**?`;

    // Build 4 choices — correct + 3 distractors
    const wrong = new Set();
    while (wrong.size < 3) {
        const off = Math.floor(Math.random() * 10) + 1;
        const candidate = correct + (Math.random() < 0.5 ? off : -off);
        if (candidate !== correct && candidate >= 0) wrong.add(candidate);
    }
    const choices = shuffle([correct, ...[...wrong]]);
    return { question, correct, choices };
}

function makeLookoutCheck() {
    // Show 5 numbers, one appears twice — identify the duplicate
    const pool = [];
    while (pool.length < 5) {
        const n = Math.floor(Math.random() * 9) + 1;
        if (!pool.includes(n)) pool.push(n);
    }
    const dup = pool[Math.floor(Math.random() * pool.length)];
    const sequence = shuffle([...pool, dup]);
    const question = `Spot the **duplicate number** in: ${sequence.join('  ')}`;
    return { question, correct: dup, choices: shuffle([...pool]) };
}

function makeMuscleCheck() {
    // Higher-lower: guess if next number is higher or lower than current
    const current = Math.floor(Math.random() * 8) + 2; // 2–9
    const next = Math.floor(Math.random() * 10) + 1;    // 1–10
    const correct = next > current ? 'higher' : next < current ? 'lower' : 'equal';
    const correctLabel = correct === 'equal' ? 'higher' : correct; // treat equal as higher
    const question = `The current number is **${current}**. Will the next number be **higher** or **lower**?`;
    return { question, correct: correctLabel, choices: ['higher', 'lower'] };
}

function makeDriverCheck() {
    // Pick the "safe" escape route from 3 options
    const routes = ['Route A — back alley', 'Route B — highway', 'Route C — docks'];
    const safeIdx = Math.floor(Math.random() * 3);
    const question = `Choose the **safe escape route**:\n${routes.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
    return { question, correct: String(safeIdx + 1), choices: ['1', '2', '3'] };
}

function buildSkillCheck(role) {
    switch (role) {
        case 'hacker':  return makeHackerCheck();
        case 'lookout': return makeLookoutCheck();
        case 'muscle':  return makeMuscleCheck();
        case 'driver':  return makeDriverCheck();
        default: return makeHackerCheck();
    }
}

// ── Outcome calculation ────────────────────────────────────────────────────

function calculateOutcome(heist) {
    const players = [...heist.players.values()];
    const total = players.length;
    if (!total) return { outcome: 'failure', passedCount: 0, totalCount: 0 };

    const passedCount = players.filter(p => p.skillPassed === true).length;
    const ratio = passedCount / total;

    let outcome;
    if (ratio === 1)       outcome = 'full_success';
    else if (ratio >= 0.5) outcome = 'partial_success';
    else                   outcome = 'failure';

    return { outcome, passedCount, totalCount: total, ratio };
}

function computePayouts(heist, passedCount, totalCount, ratio) {
    const target    = TARGETS[heist.target] ?? TARGETS.bank;
    const maxPayout = heist.maxPayout ?? 10000;
    const basePot   = Math.floor(maxPayout * target.baseReward);

    if (ratio === 1) {
        const share = Math.floor(basePot / totalCount);
        return { share, total: basePot, multiplier: '1.0×' };
    }
    if (ratio >= 0.5) {
        const reduced = Math.floor(basePot * 0.5);
        const share   = passedCount > 0 ? Math.floor(reduced / passedCount) : 0;
        return { share, total: reduced, multiplier: '0.5×' };
    }
    return { share: 0, total: 0, multiplier: '0×' };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Active heist state lives only in memory. On process restart all entries are
// gone; any in-flight lobby messages will have orphaned buttons. There is no
// persistence layer to restore from, so we simply export this no-op to make
// the intent explicit and allow callers to call it without branching.
function initActiveHeists() {
    // No-op: Map is always empty at startup. Orphaned lobby buttons will return
    // "no active lobby" when clicked, which is the correct safe fallback.
}

// ── Skill checks, resolution, and the lobby buttons ────────────────────────
//
// These three used to live in `commands/economy/heist.js`, which meant
// `events/interactionCreate` imported a command to dispatch a button and this
// service had to be required lazily from inside the handler to dodge the cycle
// that created (#614). They belong here: a skill check and a payout are the
// heist, not the slash command that starts one.

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
            // Jail the caught players: lock economy commands and apply a fine.
            // The clamp is inside the update, not against a separate read — a
            // read-then-clamp-then-$inc takes the amount the read justified even
            // once the wallet has emptied, which is how a fine walks a balance
            // negative. See src/utils/balanceDebit.js.
            const jailUntil = new Date(Date.now() + jailMins * 60_000);
            const rawFine   = Math.floor(Math.random() * 200) + 50;
            await debitUpTo(
                User, { userId, guildId }, rawFine, { heistJailedUntil: jailUntil },
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

/**
 * Runs a lobby from the moment its message is posted: the countdown refresh,
 * the close, the DM'd skill checks, and the resolution once every crew member
 * has answered or timed out.
 *
 * `msg` is the posted lobby message — the one Discord object this takes, and
 * only so it can be edited in place.
 */
function startLobbyCountdown(client, heist, msg, { minPlayers = 2, lobbyDurationSeconds = 60 } = {}) {
    // Periodically refresh the lobby embed countdown
    const refreshTimer = setInterval(async () => {
        if (heist.phase !== 'lobby') { clearInterval(refreshTimer); return; }
        await msg.edit({ embeds: [buildLobbyEmbed(heist)], components: buildLobbyRows(heist.heistId, heist) }).catch(() => {});
    }, LOBBY_POLL_MS);

    // Lobby timer
    setTimeout(async () => {
        clearInterval(refreshTimer);
        if (heist.phase !== 'lobby') return;

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

module.exports = {
    ROLES,
    TARGETS,
    activeHeists,
    getHeist,
    createLobby,
    joinLobby,
    endLobby,
    clearHeist,
    buildSkillCheck,
    calculateOutcome,
    computePayouts,
    initActiveHeists,
    sendSkillCheck,
    resolveHeist,
    startLobbyCountdown,
    handleHeistButton,
    SKILL_TIMEOUT_MS,
};
