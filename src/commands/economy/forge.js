'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User    = require('../../models/User');
const Guild   = require('../../models/Guild');
const AiItem  = require('../../models/AiItem');
const { resolveProviderConfig, getCompletion } = require('../../services/aiService');

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

        // Deduct coins
        user.balance -= cfg.cost;

        // Build AI prompt
        const level  = user.level ?? 0;
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
            const raw = await getCompletion({
                ...config,
                guildId: interaction.guild.id,
                systemPrompt,
                history: [],
                prompt,
                temperature: 0.95,
                maxTokens: 150,
            });

            const cleaned = raw.replace(/```json|```/gi, '').trim();
            parsed = JSON.parse(cleaned);
        } catch (err) {
            console.error('[FORGE] AI generation failed:', err?.message || err);
            user.balance += cfg.cost;
            await user.save();
            return interaction.editReply({ content: 'The forge misfired! Your coins have been refunded. Try again in a moment.' });
        }

        // Sanitize
        const name        = String(parsed.name        || 'Mysterious Relic').slice(0, 60);
        const emoji       = String(parsed.emoji       || cfg.emoji).slice(0, 8);
        const description = String(parsed.description || '').slice(0, 200);
        const lore        = String(parsed.lore        || '').slice(0, 300);

        // Create item record
        const itemId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await AiItem.create({
            itemId, name, emoji, rarity: cfg.label, description, lore,
            createdBy: interaction.user.id, guildId: interaction.guild.id,
        });

        // Add to inventory and award XP
        user.inventory = user.inventory || [];
        const existing = user.inventory.find(i => i.itemId === itemId);
        if (existing) {
            existing.quantity += 1;
        } else {
            user.inventory.push({ itemId, quantity: 1 });
        }
        user.xp = (user.xp || 0) + cfg.xpReward;

        await user.save();

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
