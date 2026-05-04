const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

// Wheel segments. `value` is in coins unless `type` says otherwise.
// `weight` is the relative chance of landing on that segment.
const SEGMENTS = [
    { emoji: '💀', label: 'Bust',    type: 'coins', value: 0,    color: '#555555', weight: 22 },
    { emoji: '⭐', label: '50',      type: 'coins', value: 50,   color: '#cccccc', weight: 24 },
    { emoji: '🪙', label: '150',     type: 'coins', value: 150,  color: '#ffaa00', weight: 20 },
    { emoji: '💰', label: '300',     type: 'coins', value: 300,  color: '#22cc66', weight: 14 },
    { emoji: '💎', label: '600',     type: 'coins', value: 600,  color: '#33aaff', weight: 9  },
    { emoji: '✨', label: '1,000',   type: 'coins', value: 1000, color: '#aa55ff', weight: 6  },
    { emoji: '🔁', label: 'Free Re-Spin', type: 'respin', value: 0, color: '#00ddaa', weight: 3 },
    { emoji: '🎰', label: 'JACKPOT 2,500', type: 'coins', value: 2500, color: '#ff00aa', weight: 2 },
];

const TOTAL_WEIGHT = SEGMENTS.reduce((s, seg) => s + seg.weight, 0);
const BUY_BUTTON_ID = 'wheel_buy_spin';

function pickSegment() {
    let r = Math.random() * TOTAL_WEIGHT;
    for (const seg of SEGMENTS) {
        r -= seg.weight;
        if (r <= 0) return seg;
    }
    return SEGMENTS[0];
}

function formatCooldown(ms) {
    if (ms <= 0) return 'now';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
}

// Express the configured cooldown as "X hour(s)" or "Y day(s)" when divisible by 24.
function cooldownLabel(hours) {
    if (hours > 0 && hours % 24 === 0) {
        const days = hours / 24;
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${hours} hour${hours === 1 ? '' : 's'}`;
}

// Builds a visual wheel showing the surrounding segments and a pointer at the
// chosen index — this is what we display as the "spin" animates.
function wheelStrip(highlightIndex) {
    const len = SEGMENTS.length;
    const around = 2;
    const parts = [];
    for (let offset = -around; offset <= around; offset++) {
        const i = ((highlightIndex + offset) % len + len) % len;
        const seg = SEGMENTS[i];
        if (offset === 0) {
            parts.push(`▶ **${seg.emoji} ${seg.label}** ◀`);
        } else {
            parts.push(`${seg.emoji} ${seg.label}`);
        }
    }
    return parts.join('   ·   ');
}

function spinningEmbed(currentIndex, username, source, cost, cooldownHours) {
    const sourceLine = source === 'free'
        ? `🎟️ Using your **free spin** (resets every ${cooldownLabel(cooldownHours)})`
        : `🪙 Paid spin · cost **${cost.toLocaleString()}** coins`;

    return new EmbedBuilder()
        .setColor('#ffcc00')
        .setTitle('🎡 Wheel of Fortune')
        .setDescription(`${sourceLine}\n\n${wheelStrip(currentIndex)}\n\n*Spinning…*`)
        .setFooter({ text: `Player: ${username}` });
}

function resultEmbed(segment, finalIndex, username, balance, source, cost, respinGranted, cooldownHours) {
    let prizeLine;
    if (segment.type === 'respin') {
        prizeLine = '🔁 You won a **free re-spin** — your cooldown has been reset!';
    } else if (segment.value === 0) {
        prizeLine = '💀 The wheel landed on **Bust**. Better luck next time!';
    } else {
        prizeLine = `🏆 You won **${segment.value.toLocaleString()}** coins!`;
    }

    const sourceLine = source === 'free'
        ? `🎟️ Free spin (every ${cooldownLabel(cooldownHours)})`
        : `🪙 Paid spin (-${cost.toLocaleString()} coins)`;

    const fields = [
        { name: 'Result', value: `${segment.emoji} **${segment.label}**`, inline: true },
        { name: 'Spin', value: sourceLine, inline: true },
        { name: '💰 Balance', value: `${balance.toLocaleString()} coins`, inline: false },
    ];

    if (respinGranted) {
        fields.push({
            name: '🔁 Re-spin',
            value: 'Use `/wheel` again — your free spin is ready!',
            inline: false,
        });
    }

    return new EmbedBuilder()
        .setColor(segment.color)
        .setTitle('🎡 Wheel of Fortune')
        .setDescription(`${wheelStrip(finalIndex)}\n\n${prizeLine}`)
        .addFields(fields)
        .setFooter({ text: `Player: ${username}` })
        .setTimestamp();
}

function buyButtonRow(cost) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(BUY_BUTTON_ID)
            .setLabel(`Buy Extra Spin (${cost.toLocaleString()} coins)`)
            .setEmoji('🪙')
            .setStyle(ButtonStyle.Primary),
    );
}

// Atomically deduct the buy cost. Returns the updated user, or null if the
// user couldn't afford it. This prevents double-spend under concurrent clicks.
async function chargeForSpin(userId, guildId, buyCost) {
    return User.findOneAndUpdate(
        { userId, guildId, balance: { $gte: buyCost } },
        { $inc: { balance: -buyCost } },
        { new: true },
    );
}

// Atomically claim the free spin. Sets `lastWheelSpin` only if the previous
// timestamp is null or older than the cooldown cutoff. Returns the updated
// user, or null if the cooldown has not yet elapsed.
async function claimFreeSpin(userId, guildId, cooldownMs) {
    const cutoff = new Date(Date.now() - cooldownMs);
    return User.findOneAndUpdate(
        {
            userId,
            guildId,
            $or: [{ lastWheelSpin: null }, { lastWheelSpin: { $lte: cutoff } }],
        },
        { $set: { lastWheelSpin: new Date() } },
        { new: true },
    );
}

// Apply the result of a spin atomically. For coins: $inc balance. For respin:
// clear lastWheelSpin so the user can spin again immediately.
async function applySpinReward(userId, guildId, segment) {
    if (segment.type === 'respin') {
        return User.findOneAndUpdate(
            { userId, guildId },
            { $set: { lastWheelSpin: null } },
            { new: true },
        );
    }
    if (segment.value > 0) {
        return User.findOneAndUpdate(
            { userId, guildId },
            { $inc: { balance: segment.value } },
            { new: true },
        );
    }
    return User.findOne({ userId, guildId });
}

// Sets up a one-shot collector for the "Buy Extra Spin" button. Used after
// both the cooldown reply and the post-spin result reply so the button works
// in either flow.
function setupBuySpinCollector(interaction, buyCost, cooldownHours) {
    interaction.fetchReply().then((message) => {
        const collector = message.createMessageComponentCollector({
            filter: (i) => i.user.id === interaction.user.id && i.customId === BUY_BUTTON_ID,
            time: 60_000,
            max: 1,
        });

        collector.on('collect', async (btn) => {
            try {
                const updated = await chargeForSpin(
                    interaction.user.id,
                    interaction.guild.id,
                    buyCost,
                );

                if (!updated) {
                    const fresh = await User.findOne({
                        userId: interaction.user.id,
                        guildId: interaction.guild.id,
                    });
                    await btn.reply({
                        content: `You need **${buyCost.toLocaleString()}** coins to buy another spin. Your balance: ${(fresh?.balance ?? 0).toLocaleString()}.`,
                        ephemeral: true,
                    });
                    return;
                }

                await btn.deferUpdate().catch(() => {});
                await performSpin(interaction, updated, 'paid', buyCost, buyCost, cooldownHours);
            } catch (err) {
                console.error('[Wheel] buy-spin error:', err);
                if (!btn.replied) {
                    await btn.reply({ content: 'Something went wrong buying a spin.', ephemeral: true }).catch(() => {});
                }
            }
        });

        collector.on('end', async (_collected, reason) => {
            // The button was clicked — performSpin replaced the components, don't clobber.
            if (reason === 'limit') return;
            await interaction.editReply({ components: [] }).catch(() => {});
        });
    }).catch((err) => {
        console.error('[Wheel] collector setup error:', err);
    });
}

async function performSpin(interaction, user, source, cost, buyCost, cooldownHours) {
    const username = interaction.user.username;
    const finalSegment = pickSegment();
    const finalIndex = SEGMENTS.indexOf(finalSegment);
    const len = SEGMENTS.length;

    // Animation: rotate through several full revolutions before stopping at finalIndex.
    const totalSteps = len * 2 + finalIndex;
    const frames = [];
    for (let step = 0; step <= totalSteps; step++) {
        frames.push(step % len);
    }

    await interaction.editReply({
        embeds: [spinningEmbed(frames[0], username, source, cost, cooldownHours)],
        components: [],
    }).catch(() => {});

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 1; i < frames.length; i++) {
        const remaining = frames.length - 1 - i;
        const wait = 120 + Math.max(0, 30 - remaining) * 25;
        await delay(wait);
        await interaction.editReply({
            embeds: [spinningEmbed(frames[i], username, source, cost, cooldownHours)],
        }).catch(() => {});
    }

    // Apply rewards atomically — never save a stale loaded document.
    const updatedUser = await applySpinReward(
        interaction.user.id,
        interaction.guild.id,
        finalSegment,
    );
    const balance = updatedUser?.balance ?? user.balance;
    const respinGranted = finalSegment.type === 'respin';

    await interaction.editReply({
        embeds: [resultEmbed(finalSegment, finalIndex, username, balance, source, cost, respinGranted, cooldownHours)],
        components: [buyButtonRow(buyCost)],
    }).catch(() => {});

    setupBuySpinCollector(interaction, buyCost, cooldownHours);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wheel')
        .setDescription('Spin the Wheel of Fortune for a chance at coins and prizes!')
        .addBooleanOption((opt) =>
            opt.setName('buy')
                .setDescription('Spend coins to buy an extra spin (skip the cooldown).')
                .setRequired(false)),
    cooldown: 5,

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (guildSettings && guildSettings.economy?.wheelEnabled === false) {
                return interaction.editReply({
                    content: 'The Wheel of Fortune is disabled on this server.',
                });
            }

            const cooldownHours = guildSettings?.economy?.wheelCooldownHours ?? 24;
            const cooldownMs = cooldownHours * 3600000;
            const buyCost = guildSettings?.economy?.wheelExtraSpinCost ?? 200;
            const wantsToBuy = interaction.options.getBoolean('buy') === true;

            // Ensure a user document exists so subsequent atomic updates have a target.
            await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                } },
                { upsert: true, new: true },
            );

            if (wantsToBuy) {
                const charged = await chargeForSpin(
                    interaction.user.id,
                    interaction.guild.id,
                    buyCost,
                );
                if (!charged) {
                    const fresh = await User.findOne({
                        userId: interaction.user.id,
                        guildId: interaction.guild.id,
                    });
                    return interaction.editReply({
                        content: `You need **${buyCost.toLocaleString()}** coins to buy a spin. Your balance: **${(fresh?.balance ?? 0).toLocaleString()}**.`,
                    });
                }
                // Paid spins don't consume the free-spin cooldown.
                await performSpin(interaction, charged, 'paid', buyCost, buyCost, cooldownHours);
                return;
            }

            // Try to claim the free spin atomically.
            const claimed = await claimFreeSpin(
                interaction.user.id,
                interaction.guild.id,
                cooldownMs,
            );

            if (claimed) {
                await performSpin(interaction, claimed, 'free', 0, buyCost, cooldownHours);
                return;
            }

            // Still on cooldown — show remaining time and the buy-extra-spin button.
            const fresh = await User.findOne({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
            });
            const lastSpin = fresh?.lastWheelSpin ? fresh.lastWheelSpin.getTime() : 0;
            const remaining = Math.max(0, cooldownMs - (Date.now() - lastSpin));

            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle('🎡 Wheel of Fortune')
                .setDescription(
                    `You've already used your free spin. Come back in **${formatCooldown(remaining)}**.\n\n` +
                    `Or buy an extra spin for **${buyCost.toLocaleString()}** coins below.`,
                )
                .addFields({
                    name: '💰 Balance',
                    value: `${(fresh?.balance ?? 0).toLocaleString()} coins`,
                    inline: true,
                })
                .setFooter({ text: `Cooldown: ${cooldownLabel(cooldownHours)}` });

            await interaction.editReply({
                embeds: [embed],
                components: [buyButtonRow(buyCost)],
            });
            setupBuySpinCollector(interaction, buyCost, cooldownHours);

        } catch (err) {
            console.error('[Wheel] error:', err);
            await interaction.editReply({
                content: 'Something went wrong spinning the wheel. Please try again.',
            }).catch(() => {});
        }
    },
};
