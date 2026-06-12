/**
 * Ambient chat events — the bot occasionally interrupts an active channel with
 * a claimable opportunity: a coin airdrop, a supply crate, or flash trivia.
 *
 * Pacing is per guild: an event can fire only after MIN_MESSAGES_BETWEEN
 * qualifying messages AND COOLDOWN_MS since the last event, and then only with
 * EVENT_CHANCE probability per message — so active servers see a few events
 * per hour and quiet ones aren't spammed.
 *
 * Claims are first-come-first-served. A per-event `claimed` flag settles
 * button races (single process; collector callbacks run sequentially), and
 * the award itself is an atomic $inc.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');
const QUIZ_FALLBACK = require('../data/quizFallback');

const EVENT_CHANCE         = 0.04;
const MIN_MESSAGES_BETWEEN = 20;
const COOLDOWN_MS          = 10 * 60 * 1000;
const CLAIM_WINDOW_MS      = 60_000;

const AIRDROP_MIN = 500;
const AIRDROP_MAX = 2_000;
const TRIVIA_REWARD = 1_000;

// Weighted item table for supply crates (itemIds from defaultShopItems)
const CRATE_ITEMS = [
    { itemId: 'lucky_charm',     name: 'Lucky Charm',     emoji: '🍀', weight: 30 },
    { itemId: 'xp_booster_2x',   name: '2x XP Booster',   emoji: '⭐', weight: 25 },
    { itemId: 'coin_booster_2x', name: '2x Coin Booster', emoji: '💰', weight: 25 },
    { itemId: 'lucky_streak',    name: 'Lucky Streak',    emoji: '🎯', weight: 15 },
    { itemId: 'lifesaver',       name: 'Lifesaver',       emoji: '🛟', weight: 5 },
];

const guildState = new Map(); // guildId -> { lastEventAt, messagesSince }

const randInt    = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomFrom = arr => arr[Math.floor(Math.random() * arr.length)];

function weightedPick(items) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let roll = Math.random() * total;
    for (const item of items) {
        roll -= item.weight;
        if (roll <= 0) return item;
    }
    return items[items.length - 1];
}

/**
 * Called from messageCreate for every non-bot guild message. Cheap unless an
 * event actually fires. Never throws.
 */
async function maybeTriggerChatEvent(message, guildSettings) {
    try {
        if (guildSettings?.economy?.enabled === false) return;
        if (guildSettings?.economy?.chatEventsEnabled === false) return;
        if (!message.guild || !message.channel?.isTextBased?.()) return;

        const guildId = message.guild.id;
        let state = guildState.get(guildId);
        if (!state) {
            state = { lastEventAt: 0, messagesSince: 0 };
            guildState.set(guildId, state);
        }

        state.messagesSince += 1;
        if (state.messagesSince < MIN_MESSAGES_BETWEEN) return;
        if (Date.now() - state.lastEventAt < COOLDOWN_MS) return;
        if (Math.random() >= EVENT_CHANCE) return;

        state.lastEventAt   = Date.now();
        state.messagesSince = 0;

        const roll = Math.random();
        if (roll < 0.45)      await spawnAirdrop(message, guildSettings);
        else if (roll < 0.75) await spawnCrate(message, guildSettings);
        else                  await spawnTrivia(message, guildSettings);
    } catch (err) {
        console.error('[chatEvent] error:', err);
    }
}

// ── Coin airdrop ──────────────────────────────────────────────────────────────

async function spawnAirdrop(message, guildSettings) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    const amount   = randInt(AIRDROP_MIN, AIRDROP_MAX);
    const claimId  = `chatev_air_${message.id}`;

    const embed = new EmbedBuilder()
        .setColor('#f1c40f')
        .setTitle('🪂 A supply drop tumbles from the sky!')
        .setDescription(`A crate of **${currency}${amount.toLocaleString()}** just landed.\nFirst to grab it keeps it!`)
        .setFooter({ text: 'Disappears in 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(claimId).setLabel('🪂 Grab it!').setStyle(ButtonStyle.Success),
    );

    const sent = await message.channel.send({ embeds: [embed], components: [row] });
    let claimed = false;

    const collector = sent.createMessageComponentCollector({
        filter: i => i.customId === claimId && !i.user.bot,
        time:   CLAIM_WINDOW_MS,
    });

    collector.on('collect', async i => {
        if (claimed) {
            return i.reply({ content: '💨 Too slow — someone got there first!', ephemeral: true }).catch(() => {});
        }
        // Reserve before the first await so interleaved clicks can't double-claim;
        // only stop the collector once the award has actually been persisted.
        claimed = true;
        let updated;
        try {
            updated = await User.findOneAndUpdate(
                { userId: i.user.id, guildId: message.guild.id },
                { $inc: { balance: amount }, $setOnInsert: { userId: i.user.id, guildId: message.guild.id } },
                { upsert: true, new: true }
            );
        } catch (err) {
            claimed = false; // release the reservation — the drop is still up for grabs
            console.error('[chatEvent] airdrop award failed:', err);
            return i.reply({ content: '⚠️ Something went wrong grabbing that — try again!', ephemeral: true }).catch(() => {});
        }
        collector.stop('claimed');
        logTransaction({ userId: i.user.id, guildId: message.guild.id, type: 'chat_event', amount, balance: updated?.balance ?? amount, note: 'Airdrop claim' });

        await i.update({
            embeds: [EmbedBuilder.from(embed)
                .setColor('#2ecc71')
                .setTitle('🪂 Supply drop claimed!')
                .setDescription(`**${i.member?.displayName ?? i.user.username}** grabbed **${currency}${amount.toLocaleString()}**! 💨`)
                .setFooter({ text: 'Keep chatting — more drops are coming.' })],
            components: [],
        }).catch(() => {});
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'claimed') {
            sent.edit({
                embeds: [EmbedBuilder.from(embed)
                    .setColor('#95a5a6')
                    .setTitle('🪂 The supply drop drifted away…')
                    .setDescription('Nobody grabbed it in time.')
                    .setFooter({ text: 'Stay alert for the next one!' })],
                components: [],
            }).catch(() => {});
        }
    });
}

// ── Supply crate (item drop) ─────────────────────────────────────────────────

async function spawnCrate(message, guildSettings) {
    const item    = weightedPick(CRATE_ITEMS);
    const claimId = `chatev_crate_${message.id}`;

    const embed = new EmbedBuilder()
        .setColor('#e67e22')
        .setTitle('📦 A mysterious crate appears!')
        .setDescription(`Something useful rattles inside.\nFirst to crack it open keeps the loot!`)
        .setFooter({ text: 'Disappears in 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(claimId).setLabel('📦 Crack it open').setStyle(ButtonStyle.Primary),
    );

    const sent = await message.channel.send({ embeds: [embed], components: [row] });
    let claimed = false;

    const collector = sent.createMessageComponentCollector({
        filter: i => i.customId === claimId && !i.user.bot,
        time:   CLAIM_WINDOW_MS,
    });

    collector.on('collect', async i => {
        if (claimed) {
            return i.reply({ content: '💨 Too slow — the crate is already open!', ephemeral: true }).catch(() => {});
        }
        // Reserve before the first await; only stop the collector once persisted.
        claimed = true;
        try {
            // Increment existing inventory slot, or push a new one
            const res = await User.updateOne(
                { userId: i.user.id, guildId: message.guild.id, 'inventory.itemId': item.itemId },
                { $inc: { 'inventory.$.quantity': 1 } }
            );
            if (res.matchedCount === 0) {
                await User.updateOne(
                    { userId: i.user.id, guildId: message.guild.id },
                    { $push: { inventory: { itemId: item.itemId, quantity: 1 } }, $setOnInsert: { userId: i.user.id, guildId: message.guild.id } },
                    { upsert: true }
                );
            }
        } catch (err) {
            claimed = false;
            console.error('[chatEvent] crate award failed:', err);
            return i.reply({ content: '⚠️ Something went wrong opening that — try again!', ephemeral: true }).catch(() => {});
        }
        collector.stop('claimed');
        logTransaction({ userId: i.user.id, guildId: message.guild.id, type: 'chat_event', amount: 0, balance: 0, note: `Crate drop: ${item.itemId}` });

        await i.update({
            embeds: [EmbedBuilder.from(embed)
                .setColor('#2ecc71')
                .setTitle('📦 Crate cracked open!')
                .setDescription(`**${i.member?.displayName ?? i.user.username}** found ${item.emoji} **${item.name}** inside!\n\n> Use it with \`/use ${item.itemId}\``)
                .setFooter({ text: 'Keep chatting — more crates are coming.' })],
            components: [],
        }).catch(() => {});
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'claimed') {
            sent.edit({
                embeds: [EmbedBuilder.from(embed)
                    .setColor('#95a5a6')
                    .setTitle('📦 The crate crumbled to dust…')
                    .setDescription('Nobody opened it in time.')
                    .setFooter({ text: 'Stay alert for the next one!' })],
                components: [],
            }).catch(() => {});
        }
    });
}

// ── Flash trivia ──────────────────────────────────────────────────────────────

async function spawnTrivia(message, guildSettings) {
    const currency = guildSettings?.economy?.currency ?? '💰';
    const pool     = [...(QUIZ_FALLBACK.medium ?? []), ...(QUIZ_FALLBACK.hard ?? [])];
    if (pool.length === 0) return spawnAirdrop(message, guildSettings);

    const q       = randomFrom(pool);
    const answers = [q.correct_answer, ...q.incorrect_answers].sort(() => Math.random() - 0.5);
    const baseId  = `chatev_triv_${message.id}`;

    const embed = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle('⚡ Flash Trivia!')
        .setDescription(`**${q.question}**\n\nFirst correct answer wins **${currency}${TRIVIA_REWARD.toLocaleString()}**. One guess each!`)
        .setFooter({ text: 'Expires in 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        answers.map((ans, idx) =>
            new ButtonBuilder()
                .setCustomId(`${baseId}_${idx}`)
                .setLabel(String(ans).slice(0, 80))
                .setStyle(ButtonStyle.Secondary)
        )
    );

    const sent = await message.channel.send({ embeds: [embed], components: [row] });
    let solved = false;
    const attempted = new Set();

    const collector = sent.createMessageComponentCollector({
        filter: i => i.customId.startsWith(baseId) && !i.user.bot,
        time:   CLAIM_WINDOW_MS,
    });

    collector.on('collect', async i => {
        if (solved) {
            return i.reply({ content: '💨 Too slow — already answered!', ephemeral: true }).catch(() => {});
        }
        if (attempted.has(i.user.id)) {
            return i.reply({ content: 'You already used your guess!', ephemeral: true }).catch(() => {});
        }
        attempted.add(i.user.id);

        const idx     = Number(i.customId.slice(baseId.length + 1));
        const correct = answers[idx] === q.correct_answer;

        if (!correct) {
            return i.reply({ content: `❌ Not **${answers[idx]}** — better luck next time!`, ephemeral: true }).catch(() => {});
        }

        // Reserve before the first await; only stop the collector once persisted.
        solved = true;
        let updated;
        try {
            updated = await User.findOneAndUpdate(
                { userId: i.user.id, guildId: message.guild.id },
                { $inc: { balance: TRIVIA_REWARD }, $setOnInsert: { userId: i.user.id, guildId: message.guild.id } },
                { upsert: true, new: true }
            );
        } catch (err) {
            solved = false;
            attempted.delete(i.user.id); // they answered correctly — let them claim again
            console.error('[chatEvent] trivia award failed:', err);
            return i.reply({ content: '⚠️ Something went wrong with the reward — answer again!', ephemeral: true }).catch(() => {});
        }
        collector.stop('solved');
        logTransaction({ userId: i.user.id, guildId: message.guild.id, type: 'chat_event', amount: TRIVIA_REWARD, balance: updated?.balance ?? TRIVIA_REWARD, note: 'Flash trivia win' });

        await i.update({
            embeds: [EmbedBuilder.from(embed)
                .setColor('#2ecc71')
                .setTitle('⚡ Trivia solved!')
                .setDescription(`**${i.member?.displayName ?? i.user.username}** nailed it — **${q.correct_answer}** — and wins **${currency}${TRIVIA_REWARD.toLocaleString()}**! 🧠`)
                .setFooter({ text: 'Keep chatting — more trivia is coming.' })],
            components: [],
        }).catch(() => {});
    });

    collector.on('end', (_, reason) => {
        if (reason !== 'solved') {
            sent.edit({
                embeds: [EmbedBuilder.from(embed)
                    .setColor('#95a5a6')
                    .setTitle('⚡ Trivia expired…')
                    .setDescription(`Nobody got it. The answer was **${q.correct_answer}**.`)
                    .setFooter({ text: 'Stay sharp for the next one!' })],
                components: [],
            }).catch(() => {});
        }
    });
}

module.exports = { maybeTriggerChatEvent };
