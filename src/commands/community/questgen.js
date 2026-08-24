'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User     = require('../../models/User');
const Guild    = require('../../models/Guild');
const AiQuest  = require('../../models/AiQuest');
const { resolveProviderConfig, getCompletion } = require('../../services/aiService');
const COLORS = require('../../utils/embedColors');

const COST         = 200;       // coins to generate
const COOLDOWN_MS  = 23 * 60 * 60 * 1000; // 23h — allow slight drift
const MAX_AI_QUESTS = 1;        // only one legendary quest active at a time

const MECHANIC_EMOJIS = {
    hunt:    '🏹',
    fishing: '🎣',
    mining:  '⛏️',
    social:  '💬',
    economy: '💰',
    explore: '🔍',
};

const MECHANIC_LABELS = {
    hunt:    'Hunting',
    fishing: 'Fishing',
    mining:  'Mining',
    social:  'Chat',
    economy: 'Economy',
    explore: 'Commands',
};

// Target ranges per mechanic so the AI prompt gives sensible numbers
const MECHANIC_TARGETS = {
    hunt:    { min: 5,  max: 25 },
    fishing: { min: 5,  max: 25 },
    mining:  { min: 5,  max: 20 },
    social:  { min: 20, max: 80 },
    economy: { min: 200, max: 1000 },
    explore: { min: 5,  max: 20 },
};

function clampTarget(mechanic, value) {
    const { min, max } = MECHANIC_TARGETS[mechanic] ?? { min: 5, max: 25 };
    return Math.max(min, Math.min(max, Math.round(value)));
}

function getWeeklyExpiry() {
    const d = new Date();
    const daysUntilSunday = (7 - d.getUTCDay()) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + daysUntilSunday);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('questgen')
        .setDescription('Spend 200 coins to have the AI forge you a unique Legendary Quest'),

    async execute(interaction) {
        await interaction.deferReply();

        const [user, guildSettings] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id }),
        ]);

        if (!guildSettings?.quests?.enabled) {
            return interaction.editReply({ content: 'Quests are not enabled on this server.' });
        }

        if (!guildSettings?.ai?.enabled) {
            return interaction.editReply({ content: 'AI features are not enabled on this server.' });
        }

        if (!user || user.balance < COST) {
            return interaction.editReply({
                content: `You need at least **${COST} coins** to forge a Legendary Quest. Current balance: **${user?.balance ?? 0}**`,
            });
        }

        // Cooldown: check the most recent AI quest this user created in this guild
        const lastAiQuest = await AiQuest.findOne({ userId: interaction.user.id, guildId: interaction.guild.id })
            .sort({ createdAt: -1 }).lean();
        if (lastAiQuest) {
            const elapsed = Date.now() - new Date(lastAiQuest.createdAt).getTime();
            if (elapsed < COOLDOWN_MS) {
                const remaining = COOLDOWN_MS - elapsed;
                const h = Math.floor(remaining / 3_600_000);
                const m = Math.floor((remaining % 3_600_000) / 60_000);
                return interaction.editReply({
                    content: `The Legendary Quest forge needs time to recharge. Try again in **${h}h ${m}m**.`,
                });
            }
        }

        // One active AI legendary quest at a time
        const now = new Date();
        const activeAiQuests = (user.quests || []).filter(q =>
            q.questId.startsWith('ai_') && !q.completedAt && q.expiresAt > now
        );
        if (activeAiQuests.length >= MAX_AI_QUESTS) {
            return interaction.editReply({
                content: 'You already have an active Legendary Quest. Complete it before forging a new one! Use `/quests` to check progress.',
            });
        }

        // Atomically claim the cost up front — the AI call below can take several
        // seconds, so deducting in-memory and saving at the end would let two
        // concurrent /questgen calls both pass the balance check before either
        // write commits.
        const debited = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: COST } },
            { $inc: { balance: -COST } },
            { new: true },
        );
        if (!debited) {
            return interaction.editReply({
                content: `You need at least **${COST} coins** to forge a Legendary Quest.`,
            });
        }
        user.balance = debited.balance;

        // Build AI prompt
        const level     = user.level ?? 0;
        const messages  = user.messages ?? 0;
        const balance   = user.balance ?? 0;
        const completed = user.questsCompleted ?? 0;

        const systemPrompt = `You are a dramatic fantasy quest narrator for a Discord bot called Clawdia.
Generate a single "Legendary Quest" as valid JSON with these exact fields:
- name: dramatic quest title (2–5 words, fantasy/adventure style)
- lore: one sentence of narrative backstory (immersive, vivid, 10–20 words)
- description: the plain objective e.g. "Complete 12 hunts" or "Send 50 messages" (keep it concise)
- mechanic: EXACTLY one of: hunt, fishing, mining, social, economy, explore
- target: integer (hunt 5–25, fishing 5–25, mining 5–20, social 20–80, economy 200–1000, explore 5–20)
- emoji: a single relevant emoji character

Respond with ONLY the JSON object. No markdown, no explanation.`;

        const prompt = `Player stats — Level: ${level}, Messages sent: ${messages}, Balance: ${balance} coins, Quests completed: ${completed}.
Create a legendary quest that feels fitting for their journey so far.`;

        let parsed;
        try {
            const config = resolveProviderConfig(guildSettings.ai);
            // Some providers (e.g. Gemini 2.5, OpenAI reasoning models) spend part of
            // the token budget on hidden reasoning before the visible JSON, which can
            // truncate a tight budget mid-string. Retry once with a much larger budget
            // if that happens rather than failing the whole request outright.
            const tokenBudgets = [700, 1600];
            let lastErr;
            for (const maxTokens of tokenBudgets) {
                const raw = await getCompletion({
                    ...config,
                    guildId: interaction.guild.id,
                    // Attribution for the guild's AI limits, which `config`
                    // carries: without it this command spends provider tokens
                    // bounded only by its own command cooldown.
                    userId: interaction.user.id,
                    channelId: interaction.channelId,
                    systemPrompt,
                    history: [],
                    prompt,
                    temperature: 0.9,
                    maxTokens,
                    // Pure JSON out — no MCP tools, whose output would only muddy it.
                    mcp: false,
                });

                // Strip any accidental markdown fences, then isolate the JSON object
                // in case the model added stray preamble/trailing text around it.
                const cleaned = raw.replace(/```json|```/gi, '').trim();
                const start = cleaned.indexOf('{');
                const end = cleaned.lastIndexOf('}');
                const jsonSlice = start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned;
                try {
                    parsed = JSON.parse(jsonSlice);
                    lastErr = null;
                    break;
                } catch (err) {
                    // Only a malformed/truncated JSON body is worth retrying with a
                    // bigger budget — auth, rate-limit, and network errors would just
                    // fail the same way again, so let those propagate immediately.
                    lastErr = err;
                }
            }
            if (lastErr) throw lastErr;
        } catch (err) {
            console.error('[QUESTGEN] AI generation failed:', err?.message || err);
            const refunded = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: COST } },
            ).catch(refundErr => { console.error('[QUESTGEN] Refund failed after AI failure:', refundErr); return null; });
            // A refusal by the server's own AI limit is not a misfire — say so,
            // or the user retries straight into the same wall.
            const failure = err?.rateLimited
                ? `This server's AI limit has been reached (${err.limit} per ${err.windowMin}m).`
                : 'The quest forge misfired!';
            return interaction.editReply({
                content: refunded
                    ? `${failure} Your coins have been refunded. Try again in a moment.`
                    : `${failure} The refund failed to process — please contact a server admin, your coins were not returned automatically.`,
            });
        }

        // Validate and sanitize
        const validMechanics = ['hunt', 'fishing', 'mining', 'social', 'economy', 'explore'];
        const mechanic = validMechanics.includes(parsed.mechanic) ? parsed.mechanic : 'hunt';
        const target   = clampTarget(mechanic, Number(parsed.target) || 10);
        const name     = String(parsed.name     || 'Legendary Quest').slice(0, 60);
        const lore     = String(parsed.lore     || '').slice(0, 200);
        const desc     = String(parsed.description || `Complete ${target} ${mechanic} activities`).slice(0, 150);
        const emoji    = String(parsed.emoji    || MECHANIC_EMOJIS[mechanic]).slice(0, 8);

        // Rewards scale with user level — notably better than standard quests
        const xpReward   = Math.round(300 + level * 10);
        const coinReward = Math.round(150 + level * 5);

        // Persist the definition
        const questId = `ai_${interaction.user.id}_${Date.now()}`;
        const expiresAt = getWeeklyExpiry();

        try {
            await AiQuest.create({
                questId, userId: interaction.user.id, guildId: interaction.guild.id,
                name, lore, description: desc, mechanic, target, emoji,
                xpReward, coinReward,
            });

            // Re-check the active-AI-quest cap atomically with the push — the earlier
            // check read a possibly-stale user doc, so without this a second
            // concurrent /questgen could still slip a quest past the MAX_AI_QUESTS cap.
            const pushed = await User.findOneAndUpdate(
                {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    quests: { $not: { $elemMatch: { questId: { $regex: '^ai_' }, completedAt: null, expiresAt: { $gt: now } } } },
                },
                { $push: { quests: { questId, progress: 0, completedAt: null, expiresAt } } },
            );
            if (!pushed) {
                await AiQuest.deleteOne({ questId }).catch(() => {});
                const refunded = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $inc: { balance: COST } },
                ).catch(refundErr => { console.error('[QUESTGEN] Refund failed after cap race:', refundErr); return null; });
                return interaction.editReply({
                    content: refunded
                        ? 'You already have an active Legendary Quest — your coins have been refunded.'
                        : 'You already have an active Legendary Quest, and the refund failed to process. Please contact a server admin.',
                });
            }
        } catch (err) {
            console.error('[QUESTGEN] Persistence failed:', err?.message || err);
            // Compensate: remove the quest doc if it was created before the user update failed
            await AiQuest.deleteOne({ questId }).catch(() => {});
            const refunded = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: COST } },
            ).catch(refundErr => { console.error('[QUESTGEN] Refund failed after persistence failure:', refundErr); return null; });
            return interaction.editReply({
                content: refunded
                    ? 'The quest forge failed to save! Your coins have been refunded. Try again in a moment.'
                    : 'The quest forge failed to save, and the refund failed to process. Please contact a server admin — your coins were not returned automatically.',
            });
        }

        const currency = guildSettings?.economy?.currency ?? '💰';
        const mechEmoji = MECHANIC_EMOJIS[mechanic];
        const mechLabel = MECHANIC_LABELS[mechanic];

        const embed = new EmbedBuilder()
            .setColor(COLORS.PRIZE)
            .setTitle(`⚔️ Legendary Quest Forged!`)
            .setDescription(`*${lore}*`)
            .addFields(
                { name: `${emoji} ${name}`, value: desc, inline: false },
                { name: '🎯 Mechanic', value: `${mechEmoji} ${mechLabel}`, inline: true },
                { name: '📊 Target',   value: `${target}`,                 inline: true },
                { name: '💎 Rewards',  value: `${xpReward} XP  •  ${currency}${coinReward}`, inline: true },
                { name: '⏰ Expires',  value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`, inline: true },
            )
            .setFooter({ text: `Cost: ${COST} coins deducted  •  Use /quests to track progress` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    },
};
