'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User    = require('../../models/User');
const Guild   = require('../../models/Guild');
const AiItem  = require('../../models/AiItem');
const { resolveProviderConfig, getCompletion } = require('../../services/aiService');
const { grantInventoryItem } = require('../../utils/inventoryGrant');
const { requestModelJson } = require('../../utils/modelJson');
const cooldownStore = require('../../utils/commandCooldowns');

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

// A single pictographic grapheme: one base emoji, its skin-tone and
// presentation modifiers, and any ZWJ-joined parts. The model is *asked* for
// one emoji and will hand back whatever it likes — a word, a sentence, a
// `<:name:id>` token it invented — and clamping that to eight characters only
// ever bounded how much of it landed in the embed. This is the check that was
// missing; anything failing it falls back to the rarity's own emoji (#829).
const SINGLE_EMOJI = /^\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u20E3)*(?:\u200D\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u20E3)*)*$/u;

function pickEmoji(raw, fallback) {
    const candidate = String(raw ?? '').trim();
    return SINGLE_EMOJI.test(candidate) ? candidate : fallback;
}

/**
 * Hand back a cooldown window nothing was forged with.
 *
 * Best-effort, and awaited rather than dropped: the caller is on its way to
 * telling the user what happened, and a failure to release is a line in the log
 * rather than a reason to fail that message too.
 */
async function releaseWindow(interaction, cooldownScope) {
    if (!cooldownScope) return;
    await cooldownStore.release(interaction.client, cooldownScope).catch(err =>
        console.error('[FORGE] Cooldown release failed:', err));
}

/**
 * Put the forge's cost back, and say whether it actually went back.
 *
 * Both failure paths below tell the user their coins have been returned, so
 * both have to know whether that is true. The AI-failure path already checked;
 * the persistence-failure path swallowed the refund's own error and promised a
 * refund regardless, which is how a user could pay 25,000 coins for nothing and
 * be told otherwise (#829). One helper, so the two cannot drift apart again.
 *
 * The claimed cooldown window goes back with the coins: a forge that produced
 * no item should not lock its rarity for the next day either.
 */
async function refundForge(interaction, cost, cooldownScope, context) {
    const refunded = await User.updateOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $inc: { balance: cost } },
    ).then(res => res.modifiedCount > 0)
     .catch(err => { console.error(`[FORGE] Refund failed after ${context}:`, err); return false; });

    await releaseWindow(interaction, cooldownScope);

    return refunded;
}

const REFUND_FAILED = 'The refund failed to process — please contact a server admin, your coins were not returned automatically.';

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

        // Cooldown per rarity (only for rare+). Taken, not just read: the old
        // check asked the most recent AiItem how long ago the last forge was and
        // then acted on the answer, and two `/forge legendary` calls a moment
        // apart both read "long enough" before either had written an item (#829).
        // utils/commandCooldowns takes the window in the same operation that
        // checks it — the same store and the same lock the dispatcher uses. It
        // is a different record of the same thing, so the deploy that moves to
        // it hands back whatever windows were open at the time, once.
        const cooldownMs = COOLDOWNS_MS[rarityKey] ?? 0;
        const cooldownScope = cooldownMs > 0
            ? {
                bucket: `forge:${rarityKey}`,
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                cooldownMs,
            }
            : null;

        if (cooldownScope) {
            const expiry = await cooldownStore.claimIfAvailable(interaction.client, cooldownScope);
            if (expiry) {
                const remaining = expiry - Date.now();
                const h = Math.floor(remaining / 3_600_000);
                const m = Math.floor((remaining % 3_600_000) / 60_000);
                const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
                return interaction.editReply({
                    content: `The ${cfg.emoji} ${cfg.label} forge is cooling down. Try again in **${timeStr}**.`,
                });
            }
        }

        // Atomic balance deduction — guards against concurrent forge requests
        let chargedUser;
        try {
            chargedUser = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: cfg.cost } },
                { $inc: { balance: -cfg.cost } },
                { new: true }
            );
        } catch (err) {
            // The window is claimed and this forge is not happening, so the
            // window goes back. The debit does not: a rejected write says
            // nothing about whether the server applied it, and refunding on the
            // guess would mint the cost every time it had not. So the one thing
            // that is knowable is undone, and the user is told what to check —
            // rather than being handed the dispatcher's generic apology with a
            // day-long cooldown they never spent anything on.
            console.error('[FORGE] Balance deduction failed:', err?.message || err);
            await releaseWindow(interaction, cooldownScope);
            return interaction.editReply({
                content: 'The forge could not take your payment, so nothing was made. Check your balance — if the coins are missing, contact a server admin.',
            });
        }
        if (!chargedUser) {
            // The window was claimed a moment ago and nothing was forged with
            // it, so it goes straight back — a user who could not afford the
            // item must not be locked out of the rarity for a day over it.
            await releaseWindow(interaction, cooldownScope);
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
            // The fence-stripping, brace-isolating, budget-growing retry lives in
            // utils/modelJson — /questgen asks for a JSON object the same way, and
            // the two copies of it were the least tested code in the tree (#830).
            parsed = await requestModelJson(maxTokens => getCompletion({
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
            }));
        } catch (err) {
            console.error('[FORGE] AI generation failed:', err?.message || err);
            // The refund is what the message below promises, so its outcome
            // decides what the message says. A swallowed write error used to
            // leave the user told they had been refunded when they had not,
            // with nothing but the log to say otherwise.
            const refunded = await refundForge(interaction, cfg.cost, cooldownScope, 'AI failure');
            const failure = err?.rateLimited
                ? `This server's AI limit has been reached (${err.limit} per ${err.windowMin}m).`
                : 'The forge misfired!';
            return interaction.editReply({
                content: refunded
                    ? `${failure} Your coins have been refunded. Try again in a moment.`
                    : `${failure} ${REFUND_FAILED}`,
            });
        }

        // Sanitize
        const name        = String(parsed.name        || 'Mysterious Relic').slice(0, 60);
        const emoji       = pickEmoji(parsed.emoji, cfg.emoji);
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
            const refunded = await refundForge(interaction, cfg.cost, cooldownScope, 'persistence failure');
            return interaction.editReply({
                content: refunded
                    ? 'The forge failed to save your item! Your coins have been refunded. Try again in a moment.'
                    : `The forge failed to save your item! ${REFUND_FAILED}`,
            });
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
