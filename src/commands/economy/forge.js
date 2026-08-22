'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User    = require('../../models/User');
const Guild   = require('../../models/Guild');
const AiItem  = require('../../models/AiItem');
const { resolveProviderConfig, getCompletion } = require('../../services/aiService');
const { grantInventoryItem } = require('../../utils/inventoryGrant');

const RARITY_CONFIG = {
    common:    { label: 'Common',    emoji: '⚪', color: 0xAAAAAA, cost: 500,   xpReward: 25  },
    uncommon:  { label: 'Uncommon',  emoji: '🟢', color: 0x2ECC71, cost: 1000,  xpReward: 50  },
    rare:      { label: 'Rare',      emoji: '🔵', color: 0x3498DB, cost: 2500,  xpReward: 100 },
    epic:      { label: 'Epic',      emoji: '🟣', color: 0x9B59B6, cost: 5000,  xpReward: 200 },
    mythic:    { label: 'Mythic',    emoji: '🟠', color: 0xFF6600, cost: 10000, xpReward: 400 },
    legendary: { label: 'Legendary', emoji: '⭐', color: 0xFFD700, cost: 25000, xpReward: 1000 },
};

const COOLDOWNS_MS = {
    common:    0,
    uncommon:  0,
    rare:      30 * 60 * 1000,       // 30 min
    epic:      2 * 60 * 60 * 1000,   // 2h
    mythic:    6 * 60 * 60 * 1000,   // 6h
    legendary: 24 * 60 * 60 * 1000,  // 24h
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forge')
        .setDescription('Spend coins to have the AI forge a unique, one-of-a-kind item just for you')
        .addStringOption(o =>
            o.setName('rarity')
             .setDescription('Rarity tier — higher costs more but yields more impressive items')
             .setRequired(true)
             .addChoices(
                 { name: '⚪ Common   (500 coins)',      value: 'common'    },
                 { name: '🟢 Uncommon (1,000 coins)',    value: 'uncommon'  },
                 { name: '🔵 Rare     (2,500 coins)',    value: 'rare'      },
                 { name: '🟣 Epic     (5,000 coins)',    value: 'epic'      },
                 { name: '🟠 Mythic   (10,000 coins)',   value: 'mythic'    },
                 { name: '⭐ Legendary (25,000 coins)',  value: 'legendary' },
             )
        ),

    async execute(interaction) {
        await interaction.deferReply();

        const rarityKey = interaction.options.getString('rarity');
        const cfg       = RARITY_CONFIG[rarityKey];

        const [user, guildSettings] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id }),
        ]);

        if (!guildSettings?.ai?.enabled) {
            return interaction.editReply({ content: 'AI features are not enabled on this server.' });
        }

        if (!user || user.balance < cfg.cost) {
            const currency = guildSettings?.economy?.currency ?? '💰';
            return interaction.editReply({
                content: `You need **${currency}${cfg.cost.toLocaleString()}** to forge a ${cfg.emoji} ${cfg.label} item. Your balance: **${currency}${(user?.balance ?? 0).toLocaleString()}**`,
            });
        }

        // Cooldown check per rarity (only for rare+)
        const cooldownMs = COOLDOWNS_MS[rarityKey] ?? 0;
        if (cooldownMs > 0) {
            const lastForge = await AiItem.findOne({
                createdBy: interaction.user.id,
                guildId: interaction.guild.id,
                rarity: cfg.label,
            }).sort({ createdAt: -1 }).lean();

            if (lastForge) {
                const elapsed = Date.now() - new Date(lastForge.createdAt).getTime();
                if (elapsed < cooldownMs) {
                    const remaining = cooldownMs - elapsed;
                    const h = Math.floor(remaining / 3_600_000);
                    const m = Math.floor((remaining % 3_600_000) / 60_000);
                    const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
                    return interaction.editReply({
                        content: `The ${cfg.emoji} ${cfg.label} forge is cooling down. Try again in **${timeStr}**.`,
                    });
                }
            }
        }

        // Atomic balance deduction — guards against concurrent forge requests
        const chargedUser = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: cfg.cost } },
            { $inc: { balance: -cfg.cost } },
            { new: true }
        );
        if (!chargedUser) {
            const currency = guildSettings?.economy?.currency ?? '💰';
            return interaction.editReply({
                content: `You need **${currency}${cfg.cost.toLocaleString()}** to forge a ${cfg.emoji} ${cfg.label} item. Your balance: **${currency}${(user?.balance ?? 0).toLocaleString()}**`,
            });
        }

        // Build AI prompt
        const level  = chargedUser.level ?? 0;
        const currency = guildSettings?.economy?.currency ?? '💰';

        const systemPrompt = `You are a master artificer creating unique magical items for a Discord economy bot called Clawdia.
Generate a single ${cfg.label}-rarity item as valid JSON with these exact fields:
- name: creative item name (2–5 words, thematic and memorable)
- emoji: a single emoji that fits the item (not just ✨)
- description: one sentence describing what the item does or represents (15–25 words)
- lore: one sentence of atmospheric flavour text, like from a fantasy novel (15–30 words)

The item should feel ${cfg.label.toLowerCase()} in power and prestige. Be creative and specific — avoid generic names.
Respond with ONLY the JSON object. No markdown, no extra text.`;

        const prompt = `Forge a ${cfg.label}-rarity item for a Level ${level} player. Make it feel earned and special.`;

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
                    temperature: 0.95,
                    maxTokens,
                    // Pure JSON out — no MCP tools, whose output would only muddy it.
                    mcp: false,
                });

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
            console.error('[FORGE] AI generation failed:', err?.message || err);
            // The refund is what the message below promises, so its outcome
            // decides what the message says. A swallowed write error used to
            // leave the user told they had been refunded when they had not,
            // with nothing but the log to say otherwise.
            const refunded = await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: cfg.cost } }
            ).then(res => res.modifiedCount > 0)
             .catch(refundErr => { console.error('[FORGE] Refund failed after AI failure:', refundErr); return false; });
            const failure = err?.rateLimited
                ? `This server's AI limit has been reached (${err.limit} per ${err.windowMin}m).`
                : 'The forge misfired!';
            return interaction.editReply({
                content: refunded
                    ? `${failure} Your coins have been refunded. Try again in a moment.`
                    : `${failure} The refund failed to process — please contact a server admin, your coins were not returned automatically.`,
            });
        }

        // Sanitize
        const name        = String(parsed.name        || 'Mysterious Relic').slice(0, 60);
        const emoji       = String(parsed.emoji       || cfg.emoji).slice(0, 8);
        const description = String(parsed.description || '').slice(0, 200);
        const lore        = String(parsed.lore        || '').slice(0, 300);

        // Create item record and update inventory/XP
        const itemId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        try {
            await AiItem.create({
                itemId, name, emoji, rarity: cfg.label, description, lore,
                createdBy: interaction.user.id, guildId: interaction.guild.id,
            });

            // One atomic update for the item and the XP: a mutate-then-save here
            // would write inventory and xp as absolute values read before the
            // (multi-second) AI call, flattening anything credited in between.
            // The itemId is freshly minted so no slot can exist yet, but the
            // shared upsert keeps every credit site the same shape.
            const granted = await grantInventoryItem(interaction.user.id, interaction.guild.id, itemId, 1, {
                extraSet: { xp: { $add: [{ $ifNull: ['$xp', 0] }, cfg.xpReward] } },
            });
            if (!granted) throw new Error('user document not found');
        } catch (err) {
            console.error('[FORGE] Persistence failed:', err?.message || err);
            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: cfg.cost } }
            ).catch(() => {});
            return interaction.editReply({ content: 'The forge failed to save your item! Your coins have been refunded. Try again in a moment.' });
        }

        const embed = new EmbedBuilder()
            .setColor(cfg.color)
            .setTitle(`${cfg.emoji} ${cfg.label} Item Forged!`)
            .setDescription(`> *${lore}*`)
            .addFields(
                { name: `${emoji} ${name}`, value: description || '​', inline: false },
                { name: '✨ Rarity',    value: `${cfg.emoji} ${cfg.label}`,            inline: true },
                { name: '📈 XP Bonus', value: `+${cfg.xpReward} XP`,                  inline: true },
                { name: '🆔 Item ID',  value: `\`${itemId}\``,                         inline: false },
            )
            .setFooter({ text: `Unique item added to your inventory  •  Cost: ${currency}${cfg.cost.toLocaleString()}` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    },
};
