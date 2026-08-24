const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');
const COLORS = require('../../utils/embedColors');

const DISTRICTS = [
    {
        id:      'marketplace',
        name:    'Marketplace',
        emoji:   '🏪',
        benefit: '+10% shop item drop chance from activities',
        color:   '#27ae60',
    },
    {
        id:      'bank',
        name:    'Bank',
        emoji:   '🏦',
        benefit: '+5% interest on banked coins (weekly, first 100k)',
        color:   '#2980b9',
    },
    {
        id:      'underground',
        name:    'Underground',
        emoji:   '🌑',
        benefit: '-15% crime fine severity',
        color:   '#8e44ad',
    },
    {
        id:      'wilderness',
        name:    'Wilderness',
        emoji:   '🌿',
        benefit: '+10% hunt/fish/mine yield for all members',
        color:   '#16a085',
    },
    {
        id:      'arena',
        name:    'Arena',
        emoji:   '⚔️',
        benefit: '+15% duel prize pool',
        color:   '#e74c3c',
    },
];

const ACTIVATE_DURATION_MS = 7 * 24 * 3_600_000; // 7 days

function isActive(meta) {
    return meta.activeUntil && meta.activeUntil.getTime() > Date.now();
}

function progressBar(current, goal, length = 20) {
    const filled = Math.round((current / goal) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function ensureDistricts(guildDoc) {
    if (!guildDoc.districts || guildDoc.districts.length === 0) {
        guildDoc.districts = DISTRICTS.map(d => ({
            districtId: d.id,
            pool: 0,
            goal: 1_000_000,
            activeUntil: null,
            topContributors: [],
        }));
    }
    // Fill in any missing districts
    for (const d of DISTRICTS) {
        if (!guildDoc.districts.find(x => x.districtId === d.id)) {
            guildDoc.districts.push({ districtId: d.id, pool: 0, goal: 1_000_000, activeUntil: null, topContributors: [] });
        }
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invest')
        .setDescription('Contribute coins to server districts and unlock server-wide benefits.')
        .addSubcommand(sub =>
            sub.setName('contribute')
                .setDescription('Invest coins into a server district.')
                .addStringOption(o =>
                    o.setName('district')
                        .setDescription('Which district to invest in')
                        .setRequired(true)
                        .addChoices(...DISTRICTS.map(d => ({ name: `${d.emoji} ${d.name}`, value: d.id })))
                )
                .addIntegerOption(o =>
                    o.setName('amount')
                        .setDescription('Amount to invest (minimum 100 coins)')
                        .setMinValue(100)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('View all district funding progress and active benefits.')
        ),

    async execute(interaction) {
        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        ensureDistricts(guildSettings);
        if (guildSettings.isModified('districts')) {
            await guildSettings.save();
        }

        const currency = guildSettings.economy.currency || '💰';
        const sub = interaction.options.getSubcommand();

        // ── STATUS ──────────────────────────────────────────────────────────
        if (sub === 'status') {
            const embed = new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle('🏙️ Server Investment Districts')
                .setDescription(
                    'Members collectively fund districts. When fully funded, the district activates its ' +
                    'bonus for **7 days**, then decays and must be re-funded.\n​'
                )
                .setTimestamp();

            for (const d of DISTRICTS) {
                const meta    = guildSettings.districts.find(x => x.districtId === d.id);
                const pool    = meta?.pool ?? 0;
                const goal    = meta?.goal ?? 1_000_000;
                const active  = meta && isActive(meta);
                const bar     = progressBar(active ? goal : pool, goal);
                const pct     = active ? 100 : Math.min(100, Math.round((pool / goal) * 100));
                const expires = active ? `<t:${Math.floor(meta.activeUntil.getTime() / 1000)}:R>` : null;
                const top     = (meta?.topContributors ?? []).slice(0, 3);

                let value = active
                    ? `✅ **ACTIVE** — expires ${expires}\n**Benefit:** ${d.benefit}`
                    : `${bar} ${pct}%\n${currency}${pool.toLocaleString()} / ${goal.toLocaleString()}\n**Benefit:** ${d.benefit}`;

                if (top.length > 0) {
                    value += '\n**Top investors:** ' + top.map((t, i) => `${['🥇','🥈','🥉'][i]} ${t.username} (${currency}${t.amount.toLocaleString()})`).join(', ');
                }

                embed.addFields({ name: `${d.emoji} ${d.name}`, value, inline: false });
            }

            embed.setFooter({ text: 'Use /invest contribute <district> <amount> to fund a district.' });
            return interaction.reply({ embeds: [embed] });
        }

        // ── CONTRIBUTE ──────────────────────────────────────────────────────
        const districtId = interaction.options.getString('district');
        const amount     = interaction.options.getInteger('amount');
        const distMeta   = DISTRICTS.find(d => d.id === districtId);
        if (!distMeta) {
            return interaction.reply({ content: 'Unknown district.', flags: MessageFlags.Ephemeral });
        }

        // Check district is not already active before touching the user's balance
        const distEntryCheck = guildSettings.districts.find(x => x.districtId === districtId);
        if (distEntryCheck && isActive(distEntryCheck)) {
            return interaction.reply({
                content: `The **${distMeta.name}** district is already active!`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!userDoc || userDoc.balance < amount) {
            const bal = userDoc?.balance ?? 0;
            return interaction.reply({
                content: `You need ${currency}${amount.toLocaleString()} but only have ${currency}${bal.toLocaleString()}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // Deduct coins from user
        const updatedUser = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        );
        if (!updatedUser) {
            return interaction.reply({ content: 'Insufficient balance — please try again.', flags: MessageFlags.Ephemeral });
        }

        logTransaction({
            userId:  interaction.user.id,
            guildId: interaction.guild.id,
            type:    'invest',
            amount:  -amount,
            balance: updatedUser.balance,
            note:    `district:${districtId}`,
        });

        // Atomically increment the district pool to prevent concurrent contributions
        // from overwriting each other. The $inc is safe against race conditions.
        const freshGuild = await Guild.findOneAndUpdate(
            {
                guildId: interaction.guild.id,
                districts: { $elemMatch: { districtId, activeUntil: { $not: { $gt: new Date() } } } },
            },
            { $inc: { 'districts.$.pool': amount } },
            { new: true }
        );

        if (!freshGuild) {
            // District was activated by a concurrent contribution after our pre-check — refund
            const refunded = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: amount } },
                { new: true }
            );
            logTransaction({
                userId:  interaction.user.id,
                guildId: interaction.guild.id,
                type:    'invest_refund',
                amount,
                balance: refunded?.balance ?? 0,
                note:    `district:${districtId} (already active — refunded)`,
            });
            return interaction.reply({
                content: `The **${distMeta.name}** district just activated! Coins refunded.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        ensureDistricts(freshGuild);
        const distEntry = freshGuild.districts.find(x => x.districtId === districtId);

        // Update top contributors (cosmetic — non-atomic is acceptable here)
        const existing = distEntry.topContributors.find(c => c.userId === interaction.user.id);
        if (existing) {
            existing.amount += amount;
            existing.username = interaction.user.username;
        } else {
            distEntry.topContributors.push({ userId: interaction.user.id, username: interaction.user.username, amount });
        }
        distEntry.topContributors.sort((a, b) => b.amount - a.amount);
        if (distEntry.topContributors.length > 10) distEntry.topContributors.length = 10;

        const goal     = distEntry.goal ?? 1_000_000;
        const newPool  = distEntry.pool;
        const activated = newPool >= goal;

        if (activated) {
            distEntry.activeUntil = new Date(Date.now() + ACTIVATE_DURATION_MS);
            distEntry.pool = 0;
            distEntry.topContributors = [];
        }

        await freshGuild.save();

        const pct = Math.min(100, Math.round((newPool / goal) * 100));
        const bar = progressBar(activated ? goal : newPool, goal);

        const embed = new EmbedBuilder()
            .setColor(activated ? '#FFD700' : distMeta.color)
            .setTitle(activated ? `🎉 ${distMeta.emoji} ${distMeta.name} District ACTIVATED!` : `${distMeta.emoji} ${distMeta.name} — Investment Received`)
            .setTimestamp();

        if (activated) {
            embed.setDescription(
                `Your investment of ${currency}**${amount.toLocaleString()}** pushed the ${distMeta.name} district over the funding goal!\n\n` +
                `✅ **Benefit active for 7 days:** ${distMeta.benefit}\n\n` +
                `All server members now enjoy the bonus. Well played.`
            );

            // Announce in the designated channel if set
            const announceChannelId = freshGuild.districtAnnounceChannelId ?? freshGuild.economy?.announcementChannelId;
            if (announceChannelId && announceChannelId !== interaction.channelId) {
                const announceChannel = interaction.guild?.channels?.cache?.get(announceChannelId);
                if (announceChannel) {
                    const broadcastEmbed = new EmbedBuilder()
                        .setColor(COLORS.PRIZE)
                        .setTitle(`🏙️ ${distMeta.emoji} ${distMeta.name} District — FUNDED!`)
                        .setDescription(
                            `The community invested and it paid off!\n\n` +
                            `✅ **${distMeta.benefit}** is now active for **7 days**.\n\n` +
                            `Thanks to everyone who contributed — especially ${interaction.user} whose final investment pushed it over the line.`
                        )
                        .setTimestamp();
                    await announceChannel.send({ embeds: [broadcastEmbed] }).catch(() => {});
                }
            }
        } else {
            embed.setDescription(
                `You invested ${currency}**${amount.toLocaleString()}** in the **${distMeta.name}** district.\n\n` +
                `${bar} **${pct}%**\n` +
                `${currency}${newPool.toLocaleString()} / ${goal.toLocaleString()} raised\n\n` +
                `**Benefit when funded:** ${distMeta.benefit}\n` +
                `**Remaining:** ${currency}${(goal - newPool).toLocaleString()}`
            );
        }

        embed.addFields({ name: 'Your Balance', value: `${currency}${updatedUser.balance.toLocaleString()}`, inline: true });
        embed.setFooter({ text: 'Use /invest status to see all districts.' });

        return interaction.reply({ embeds: [embed] });
    },
};
