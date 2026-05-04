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

// Builds a visual wheel showing the surrounding segments and a pointer at the
// chosen index — this is what we display as the "spin" animates.
function wheelStrip(highlightIndex) {
    const len = SEGMENTS.length;
    const around = 2; // segments shown on each side of the pointer
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

function spinningEmbed(currentIndex, username, source, cost) {
    const sourceLine = source === 'free'
        ? '🎟️ Using your **free daily spin**'
        : `🪙 Paid spin · cost **${cost.toLocaleString()}** coins`;

    return new EmbedBuilder()
        .setColor('#ffcc00')
        .setTitle('🎡 Wheel of Fortune')
        .setDescription(`${sourceLine}\n\n${wheelStrip(currentIndex)}\n\n*Spinning…*`)
        .setFooter({ text: `Player: ${username}` });
}

function resultEmbed(segment, finalIndex, username, balance, source, cost, respinGranted) {
    let prizeLine;
    if (segment.type === 'respin') {
        prizeLine = '🔁 You won a **free re-spin** — your daily cooldown has been reset!';
    } else if (segment.value === 0) {
        prizeLine = '💀 The wheel landed on **Bust**. Better luck next time!';
    } else {
        prizeLine = `🏆 You won **${segment.value.toLocaleString()}** coins!`;
    }

    const sourceLine = source === 'free'
        ? '🎟️ Free daily spin'
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
            .setCustomId('wheel_buy_spin')
            .setLabel(`Buy Extra Spin (${cost.toLocaleString()} coins)`)
            .setEmoji('🪙')
            .setStyle(ButtonStyle.Primary),
    );
}

async function performSpin(interaction, user, source, cost) {
    const username = interaction.user.username;
    const finalSegment = pickSegment();
    const finalIndex = SEGMENTS.indexOf(finalSegment);
    const len = SEGMENTS.length;

    // Animation: rotate through several full revolutions before stopping at finalIndex.
    const totalSteps = len * 2 + finalIndex; // ~2 full rotations + offset
    const frames = [];
    for (let step = 0; step <= totalSteps; step++) {
        frames.push(step % len);
    }

    await interaction.editReply({
        embeds: [spinningEmbed(frames[0], username, source, cost)],
        components: [],
    }).catch(() => {});

    // Animate. Slow down as we approach the final segment to feel like a real wheel.
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 1; i < frames.length; i++) {
        const remaining = frames.length - 1 - i;
        // ease-out: more delay near the end
        const wait = 120 + Math.max(0, 30 - remaining) * 25;
        await delay(wait);
        await interaction.editReply({
            embeds: [spinningEmbed(frames[i], username, source, cost)],
        }).catch(() => {});
    }

    // Apply rewards
    let respinGranted = false;
    if (finalSegment.type === 'respin') {
        user.lastWheelSpin = null; // reset cooldown
        respinGranted = true;
    } else if (finalSegment.value > 0) {
        user.balance += finalSegment.value;
    }
    await user.save();

    await interaction.editReply({
        embeds: [resultEmbed(finalSegment, finalIndex, username, user.balance, source, cost, respinGranted)],
        components: [buyButtonRow(cost || 0)],
    }).catch(() => {});

    // Collector for buying additional spins from the result message.
    try {
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === 'wheel_buy_spin',
            time: 60_000,
            max: 1,
        });

        collector.on('collect', async (btn) => {
            try {
                // Re-load fresh state
                const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
                const buyCost = guildSettings?.economy?.wheelExtraSpinCost ?? 200;
                const fresh = await User.findOne({
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                });

                if (!fresh || fresh.balance < buyCost) {
                    await btn.reply({
                        content: `You need **${buyCost.toLocaleString()}** coins to buy another spin. Your balance: ${(fresh?.balance ?? 0).toLocaleString()}.`,
                        ephemeral: true,
                    });
                    return;
                }

                fresh.balance -= buyCost;
                await fresh.save();

                await btn.deferUpdate().catch(() => {});
                await performSpin(interaction, fresh, 'paid', buyCost);
            } catch (err) {
                console.error('[Wheel] buy-spin error:', err);
                if (!btn.replied) {
                    await btn.reply({ content: 'Something went wrong buying a spin.', ephemeral: true }).catch(() => {});
                }
            }
        });

        collector.on('end', async (_collected, reason) => {
            // If the user actually clicked the button, performSpin will replace
            // the components — don't clobber its UI here.
            if (reason === 'limit') return;
            await interaction.editReply({ components: [] }).catch(() => {});
        });
    } catch (err) {
        console.error('[Wheel] collector setup error:', err);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wheel')
        .setDescription('Spin the Wheel of Fortune for a chance at coins and prizes!')
        .addBooleanOption(opt =>
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

            let user = await User.findOne({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
            });
            if (!user) {
                user = await User.create({
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                });
            }

            const now = Date.now();
            const lastSpin = user.lastWheelSpin ? user.lastWheelSpin.getTime() : 0;
            const onCooldown = lastSpin && now - lastSpin < cooldownMs;

            if (wantsToBuy) {
                if (user.balance < buyCost) {
                    return interaction.editReply({
                        content: `You need **${buyCost.toLocaleString()}** coins to buy a spin. Your balance: **${user.balance.toLocaleString()}**.`,
                    });
                }
                user.balance -= buyCost;
                // Paid spins don't reset or consume the daily cooldown.
                await user.save();
                await performSpin(interaction, user, 'paid', buyCost);
                return;
            }

            if (onCooldown) {
                const remaining = cooldownMs - (now - lastSpin);
                const embed = new EmbedBuilder()
                    .setColor('#ff9900')
                    .setTitle('🎡 Wheel of Fortune')
                    .setDescription(
                        `You've already used your free spin. Come back in **${formatCooldown(remaining)}**.\n\n` +
                        `Or buy an extra spin for **${buyCost.toLocaleString()}** coins below.`,
                    )
                    .addFields({
                        name: '💰 Balance',
                        value: `${user.balance.toLocaleString()} coins`,
                        inline: true,
                    })
                    .setFooter({ text: `Cooldown: ${cooldownHours}h` });

                return interaction.editReply({
                    embeds: [embed],
                    components: [buyButtonRow(buyCost)],
                });
            }

            // Free daily spin
            user.lastWheelSpin = new Date();
            await user.save();
            await performSpin(interaction, user, 'free', 0);

        } catch (err) {
            console.error('[Wheel] error:', err);
            await interaction.editReply({
                content: 'Something went wrong spinning the wheel. Please try again.',
            }).catch(() => {});
        }
    },
};
