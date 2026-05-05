const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const THUMB = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3a1.png';

const SEGMENTS = [
    { emoji: '💀', label: 'Bust',          type: 'coins',  value: 0,    color: '#555555', weight: 22 },
    { emoji: '⭐', label: '50 coins',       type: 'coins',  value: 50,   color: '#aaaaaa', weight: 24 },
    { emoji: '🪙', label: '150 coins',      type: 'coins',  value: 150,  color: '#ffaa00', weight: 20 },
    { emoji: '💰', label: '300 coins',      type: 'coins',  value: 300,  color: '#22cc66', weight: 14 },
    { emoji: '💎', label: '600 coins',      type: 'coins',  value: 600,  color: '#33aaff', weight: 9  },
    { emoji: '✨', label: '1,000 coins',    type: 'coins',  value: 1000, color: '#aa55ff', weight: 6  },
    { emoji: '🔁', label: 'Free Re-Spin',  type: 'respin', value: 0,    color: '#00ddaa', weight: 3  },
    { emoji: '🎰', label: 'JACKPOT 2,500', type: 'coins',  value: 2500, color: '#ff00aa', weight: 2  },
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
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0) return `${h}h ${m}m`;
    const s = Math.floor((ms % 60_000) / 1_000);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function cooldownLabel(hours) {
    if (hours > 0 && hours % 24 === 0) {
        const days = hours / 24;
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${hours} hour${hours === 1 ? '' : 's'}`;
}

// Full segment ring display: all 8 segments shown, active one highlighted
function wheelRing(highlightIndex) {
    return SEGMENTS.map((seg, i) =>
        i === highlightIndex
            ? `**▶ ${seg.emoji} ${seg.label} ◀**`
            : `${seg.emoji} ${seg.label}`
    ).join('  ·  ');
}

// Short strip (5 visible): used during the spin animation
function wheelStrip(highlightIndex) {
    const len    = SEGMENTS.length;
    const around = 2;
    const parts  = [];
    for (let offset = -around; offset <= around; offset++) {
        const i   = ((highlightIndex + offset) % len + len) % len;
        const seg = SEGMENTS[i];
        parts.push(offset === 0 ? `**▶ ${seg.emoji} ${seg.label} ◀**` : `${seg.emoji} ${seg.label}`);
    }
    return parts.join('  ·  ');
}

// Odds table shown in cooldown and result embeds
function oddsField() {
    const total = TOTAL_WEIGHT;
    return SEGMENTS.map(s => `${s.emoji} **${s.label}** — ${((s.weight / total) * 100).toFixed(1)}%`).join('\n');
}

function embedAuthor(interaction) {
    return {
        name: interaction.member?.displayName || interaction.user.username,
        iconURL: interaction.user.displayAvatarURL({ dynamic: true }),
    };
}

function spinningEmbed(currentIndex, interaction, source, cost, cooldownHours) {
    const sourceLine = source === 'free'
        ? `🎟️ **Free spin** — resets every ${cooldownLabel(cooldownHours)}`
        : `🪙 **Paid spin** — cost **${cost.toLocaleString()}** coins`;

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#ffcc00')
        .setTitle('🎡 Wheel of Fortune — Spinning…')
        .setDescription(`${sourceLine}\n\n${wheelStrip(currentIndex)}\n\n*Spinning…*`)
        .setFooter({ text: 'No more bets!' });
}

function resultEmbed(segment, finalIndex, interaction, balance, source, cost, respinGranted, cooldownHours) {
    const sourceLine = source === 'free'
        ? `🎟️ Free spin (resets every ${cooldownLabel(cooldownHours)})`
        : `🪙 Paid spin (−${cost.toLocaleString()} coins)`;

    let prizeLine;
    if (segment.type === 'respin') {
        prizeLine = '🔁 You won a **Free Re-Spin** — cooldown reset! Spin again immediately.';
    } else if (segment.value === 0) {
        prizeLine = '💀 **Bust!** The wheel showed no mercy. Better luck next time!';
    } else if (segment.value === 2500) {
        prizeLine = `🎰 ✨ **JACKPOT! You won ${segment.value.toLocaleString()} coins!** ✨`;
    } else {
        prizeLine = `🏆 You won **${segment.value.toLocaleString()} coins!**`;
    }

    const fields = [
        { name: '🎡 Result',    value: `${segment.emoji} **${segment.label}**`, inline: true },
        { name: '🎟️ Spin Type', value: sourceLine,                               inline: true },
        { name: '​',            value: '​',                                       inline: false },
        { name: '💰 Balance',   value: `**${balance.toLocaleString()}** coins`,  inline: true },
    ];

    if (respinGranted) {
        fields.push({ name: '🔁 Re-Spin Ready', value: 'Your free spin has been reset — use `/wheel` again!', inline: false });
    }

    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor(segment.color)
        .setTitle('🎡 Wheel of Fortune')
        .setDescription(`${wheelStrip(finalIndex)}\n\n${prizeLine}`)
        .addFields(fields)
        .setFooter({ text: `Jackpot 2% · Free Re-Spin 3% · Bust 22%` })
        .setTimestamp();
}

function cooldownEmbed(interaction, remaining, balance, buyCost, cooldownHours) {
    return new EmbedBuilder()
        .setAuthor(embedAuthor(interaction))
        .setThumbnail(THUMB)
        .setColor('#ff9900')
        .setTitle('🎡 Wheel of Fortune — On Cooldown')
        .setDescription(
            `⏳ Your free spin resets in **${formatCooldown(remaining)}**.\n\n` +
            `Buy an extra spin below, or come back later!`,
        )
        .addFields(
            { name: '💰 Your Balance', value: `**${balance.toLocaleString()}** coins`, inline: true },
            { name: '🎟️ Cooldown',     value: cooldownLabel(cooldownHours),             inline: true },
            { name: '​',              value: '​',                                        inline: false },
            { name: '🎰 Segment Odds', value: oddsField(),                              inline: false },
        )
        .setFooter({ text: 'Free spin resets every ' + cooldownLabel(cooldownHours) });
}

function buyButtonRow(cost) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(BUY_BUTTON_ID)
            .setLabel(`🪙 Buy Extra Spin (${cost.toLocaleString()} coins)`)
            .setStyle(ButtonStyle.Primary),
    );
}

async function chargeForSpin(userId, guildId, buyCost) {
    return User.findOneAndUpdate(
        { userId, guildId, balance: { $gte: buyCost } },
        { $inc: { balance: -buyCost } },
        { new: true },
    );
}

async function claimFreeSpin(userId, guildId, cooldownMs) {
    const cutoff = new Date(Date.now() - cooldownMs);
    return User.findOneAndUpdate(
        { userId, guildId, $or: [{ lastWheelSpin: null }, { lastWheelSpin: { $lte: cutoff } }] },
        { $set: { lastWheelSpin: new Date() } },
        { new: true },
    );
}

async function applySpinReward(userId, guildId, segment) {
    if (segment.type === 'respin') {
        return User.findOneAndUpdate({ userId, guildId }, { $set: { lastWheelSpin: null } }, { new: true });
    }
    if (segment.value > 0) {
        return User.findOneAndUpdate({ userId, guildId }, { $inc: { balance: segment.value } }, { new: true });
    }
    return User.findOne({ userId, guildId });
}

function setupBuySpinCollector(interaction, buyCost, cooldownHours) {
    interaction.fetchReply().then(message => {
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === BUY_BUTTON_ID,
            time:   60_000,
            max:    1,
        });

        collector.on('collect', async btn => {
            try {
                const updated = await chargeForSpin(interaction.user.id, interaction.guild.id, buyCost);
                if (!updated) {
                    const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                    await btn.reply({
                        content: `❌ You need **${buyCost.toLocaleString()}** coins for a paid spin. Balance: **${(fresh?.balance ?? 0).toLocaleString()}**.`,
                        ephemeral: true,
                    });
                    return;
                }
                await btn.deferUpdate().catch(() => {});
                await performSpin(interaction, updated, 'paid', buyCost, buyCost, cooldownHours);
            } catch (err) {
                console.error('[Wheel] buy-spin error:', err);
                if (!btn.replied) await btn.reply({ content: 'Something went wrong buying a spin.', ephemeral: true }).catch(() => {});
            }
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'limit') return;
            await interaction.editReply({ components: [] }).catch(() => {});
        });
    }).catch(err => console.error('[Wheel] collector setup error:', err));
}

async function performSpin(interaction, user, source, cost, buyCost, cooldownHours) {
    const finalSegment = pickSegment();
    const finalIndex   = SEGMENTS.indexOf(finalSegment);
    const len          = SEGMENTS.length;
    const totalSteps   = len * 2 + finalIndex;
    const delay        = ms => new Promise(r => setTimeout(r, ms));

    await interaction.editReply({
        embeds:     [spinningEmbed(0, interaction, source, cost, cooldownHours)],
        components: [],
    }).catch(() => {});

    for (let i = 1; i <= totalSteps; i++) {
        const remaining = totalSteps - i;
        const wait      = 120 + Math.max(0, 30 - remaining) * 25;
        await delay(wait);
        await interaction.editReply({
            embeds: [spinningEmbed(i % len, interaction, source, cost, cooldownHours)],
        }).catch(() => {});
    }

    const updatedUser  = await applySpinReward(interaction.user.id, interaction.guild.id, finalSegment);
    const balance      = updatedUser?.balance ?? user.balance;
    const respinGranted = finalSegment.type === 'respin';

    await interaction.editReply({
        embeds:     [resultEmbed(finalSegment, finalIndex, interaction, balance, source, cost, respinGranted, cooldownHours)],
        components: [buyButtonRow(buyCost)],
    }).catch(() => {});

    setupBuySpinCollector(interaction, buyCost, cooldownHours);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wheel')
        .setDescription('Spin the Wheel of Fortune for a chance at coins and prizes!')
        .addBooleanOption(opt =>
            opt.setName('buy')
                .setDescription('Spend coins to buy an extra spin (skips cooldown).')
                .setRequired(false)),
    cooldown: 5,

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (guildSettings?.economy?.wheelEnabled === false) {
                return interaction.editReply({ content: 'The Wheel of Fortune is disabled on this server.' });
            }

            const cooldownHours = guildSettings?.economy?.wheelCooldownHours ?? 24;
            const cooldownMs    = cooldownHours * 3_600_000;
            const buyCost       = guildSettings?.economy?.wheelExtraSpinCost ?? 200;
            const wantsToBuy    = interaction.options.getBoolean('buy') === true;

            await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                { upsert: true, new: true },
            );

            if (wantsToBuy) {
                const charged = await chargeForSpin(interaction.user.id, interaction.guild.id, buyCost);
                if (!charged) {
                    const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                    return interaction.editReply({
                        content: `❌ You need **${buyCost.toLocaleString()}** coins for a paid spin. Balance: **${(fresh?.balance ?? 0).toLocaleString()}**.`,
                    });
                }
                await performSpin(interaction, charged, 'paid', buyCost, buyCost, cooldownHours);
                return;
            }

            const claimed = await claimFreeSpin(interaction.user.id, interaction.guild.id, cooldownMs);
            if (claimed) {
                await performSpin(interaction, claimed, 'free', 0, buyCost, cooldownHours);
                return;
            }

            // On cooldown
            const fresh     = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const lastSpin  = fresh?.lastWheelSpin ? fresh.lastWheelSpin.getTime() : 0;
            const remaining = Math.max(0, cooldownMs - (Date.now() - lastSpin));

            await interaction.editReply({
                embeds:     [cooldownEmbed(interaction, remaining, fresh?.balance ?? 0, buyCost, cooldownHours)],
                components: [buyButtonRow(buyCost)],
            });
            setupBuySpinCollector(interaction, buyCost, cooldownHours);

        } catch (err) {
            console.error('[Wheel] error:', err);
            await interaction.editReply({ content: 'Something went wrong spinning the wheel. Please try again.' }).catch(() => {});
        }
    },
};
