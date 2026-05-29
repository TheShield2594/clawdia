const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../../models/Guild');
const User = require('../../models/User');

const WAR_DURATION_DAYS = 7;
const WAR_DURATION_MS = WAR_DURATION_DAYS * 86400000;

// Points earned per action during a war
const WAR_POINTS = {
    daily:    1,
    work:     2,
    hunt:     2,
    fish:     2,
    mine:     2,
    quiz:     3,
    casino:   1,
    duel_win: 10
};

function progressBar(score, opponentScore) {
    const total = score + opponentScore;
    if (total === 0) return '░'.repeat(20) + ' (no points yet)';
    const myFill = Math.round((score / total) * 20);
    return '█'.repeat(myFill) + '░'.repeat(20 - myFill);
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function executeChallenge(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only administrators can initiate a server war.', ephemeral: true });
    }

    const inviteCode = interaction.options.getString('invite_code').trim();

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.activeWar?.status === 'active' || guildSettings?.activeWar?.status === 'pending') {
        return interaction.reply({ content: 'Your server already has an active or pending war.', ephemeral: true });
    }

    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        {
            $set: {
                activeWar: {
                    status: 'pending',
                    initiatorGuildId: interaction.guild.id,
                    opponentGuildId: null,
                    opponentGuildName: null,
                    myScore: 0,
                    opponentScore: 0,
                    inviteCode,
                    announcementChannelId: interaction.channelId
                }
            }
        },
        { upsert: true }
    );

    const embed = new EmbedBuilder()
        .setColor('#ff4444')
        .setTitle('⚔️ War Challenge Sent!')
        .setDescription(
            `**${interaction.guild.name}** has challenged another server to a **${WAR_DURATION_DAYS}-day war!**\n\n` +
            `The challenged server admin must run \`/war accept\` on their bot to start the war.\n\n` +
            `Share your server invite code: \`${inviteCode}\``
        )
        .addFields({
            name: 'Scoring',
            value: Object.entries(WAR_POINTS)
                .map(([k, v]) => `${k.replace('_', ' ')}: **${v} pt${v > 1 ? 's' : ''}**`)
                .join(' | ')
        })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeAccept(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only administrators can accept a war.', ephemeral: true });
    }

    const challengerInvite = interaction.options.getString('challenger_invite').trim();

    const myGuild = await Guild.findOne({ guildId: interaction.guild.id });
    if (myGuild?.activeWar?.status === 'active' || myGuild?.activeWar?.status === 'pending') {
        return interaction.reply({ content: 'Your server already has an active or pending war.', ephemeral: true });
    }

    // Find the challenger guild by invite code
    const challengerGuild = await Guild.findOne({
        'activeWar.inviteCode': challengerInvite,
        'activeWar.status': 'pending'
    });

    if (!challengerGuild) {
        return interaction.reply({
            content: 'No pending war challenge found for that invite code. Make sure the challenger ran `/war challenge` first.',
            ephemeral: true
        });
    }

    if (challengerGuild.guildId === interaction.guild.id) {
        return interaction.reply({ content: 'You can\'t accept your own war challenge.', ephemeral: true });
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + WAR_DURATION_MS);

    // Update both guilds
    await Promise.all([
        Guild.findOneAndUpdate(
            { guildId: challengerGuild.guildId },
            {
                $set: {
                    'activeWar.status': 'active',
                    'activeWar.opponentGuildId': interaction.guild.id,
                    'activeWar.opponentGuildName': interaction.guild.name,
                    'activeWar.myScore': 0,
                    'activeWar.opponentScore': 0,
                    'activeWar.startedAt': now,
                    'activeWar.endsAt': endsAt
                }
            }
        ),
        Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            {
                $set: {
                    activeWar: {
                        status: 'active',
                        initiatorGuildId: challengerGuild.guildId,
                        opponentGuildId: challengerGuild.guildId,
                        opponentGuildName: challengerGuild.name,
                        myScore: 0,
                        opponentScore: 0,
                        startedAt: now,
                        endsAt,
                        announcementChannelId: interaction.channelId
                    }
                }
            },
            { upsert: true }
        )
    ]);

    const embed = new EmbedBuilder()
        .setColor('#ff4444')
        .setTitle('⚔️ WAR DECLARED!')
        .setDescription(
            `**${interaction.guild.name}** vs **${challengerGuild.name}**\n\n` +
            `The **${WAR_DURATION_DAYS}-day war** has begun! Earn points for your server through daily activities.\n\n` +
            `Victory: All members of the winning server receive a **2x coin booster (24h)** + a **server badge** for 30 days!`
        )
        .addFields(
            { name: '⏰ War Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true },
            {
                name: 'Scoring',
                value: Object.entries(WAR_POINTS)
                    .map(([k, v]) => `${k.replace(/_/g, ' ')}: **${v} pt${v > 1 ? 's' : ''}**`)
                    .join(' | ')
            }
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeStatus(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const war = guildSettings?.activeWar;

    if (!war?.status || war.status === 'ended') {
        return interaction.reply({ content: 'No active war for this server.', ephemeral: true });
    }

    if (war.status === 'pending') {
        return interaction.reply({
            content: `⏳ War challenge pending. Waiting for the opponent server to run \`/war accept\`.`,
            ephemeral: true
        });
    }

    const now = Date.now();
    const endsAt = new Date(war.endsAt).getTime();
    const totalMs = WAR_DURATION_MS;
    const elapsed = now - new Date(war.startedAt).getTime();
    const day = Math.min(WAR_DURATION_DAYS, Math.ceil(elapsed / 86400000));

    const myScore = war.myScore ?? 0;
    const oppScore = war.opponentScore ?? 0;
    const myName = interaction.guild.name;
    const oppName = war.opponentGuildName ?? 'Enemy Server';

    const embed = new EmbedBuilder()
        .setColor('#ff4444')
        .setTitle(`⚔️ Server War — Day ${day}/${WAR_DURATION_DAYS}`)
        .setDescription(
            `${'━'.repeat(30)}\n` +
            `🏠 **${myName}**\n` +
            `${progressBar(myScore, oppScore)} **${myScore.toLocaleString()} pts**\n\n` +
            `⚔️ **${oppName}**\n` +
            `${progressBar(oppScore, myScore)} **${oppScore.toLocaleString()} pts**\n` +
            `${'━'.repeat(30)}`
        )
        .addFields(
            { name: '⏰ Ends', value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
            {
                name: 'Scoring',
                value: Object.entries(WAR_POINTS)
                    .map(([k, v]) => `${k.replace(/_/g, ' ')}: **${v} pt${v !== 1 ? 's' : ''}**`)
                    .join(' | ')
            }
        )
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeCancel(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrator only.', ephemeral: true });
    }

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const war = guildSettings?.activeWar;

    if (!war?.status || war.status === 'ended') {
        return interaction.reply({ content: 'No active war to cancel.', ephemeral: true });
    }

    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $set: { 'activeWar.status': 'ended' } }
    );

    // Also clear the opponent's war if they're in an active one vs us
    if (war.opponentGuildId) {
        await Guild.findOneAndUpdate(
            { guildId: war.opponentGuildId, 'activeWar.opponentGuildId': interaction.guild.id },
            { $set: { 'activeWar.status': 'ended' } }
        );
    }

    return interaction.reply({ content: '⚔️ The war has been cancelled.', ephemeral: false });
}

// ── Point granting utility (exported for use in other commands) ───────────────

/**
 * Grant war points to the guild for a given action type.
 * Call this from daily.js, work.js, hunt.js, etc. with appropriate action type.
 */
async function grantWarPoints(guildId, action) {
    const pts = WAR_POINTS[action];
    if (!pts) return;

    const guildSettings = await Guild.findOne({ guildId });
    const war = guildSettings?.activeWar;

    if (!war || war.status !== 'active') return;

    // Auto-resolve expired wars
    if (war.endsAt && Date.now() > new Date(war.endsAt).getTime()) {
        await resolveExpiredWar(guildId, guildSettings);
        return;
    }

    await Guild.findOneAndUpdate(
        { guildId, 'activeWar.status': 'active' },
        { $inc: { 'activeWar.myScore': pts } }
    );

    // Mirror the points increment to the opponent's opponentScore
    if (war.opponentGuildId) {
        await Guild.findOneAndUpdate(
            { guildId: war.opponentGuildId, 'activeWar.status': 'active' },
            { $inc: { 'activeWar.opponentScore': pts } }
        );
    }
}

async function resolveExpiredWar(guildId, guildSettings) {
    const war = guildSettings?.activeWar;
    if (!war || war.status !== 'active') return;

    const myScore = war.myScore ?? 0;
    const oppScore = war.opponentScore ?? 0;
    const iWon = myScore >= oppScore;

    await Guild.findOneAndUpdate(
        { guildId },
        { $set: { 'activeWar.status': 'ended' } }
    );
    if (war.opponentGuildId) {
        await Guild.findOneAndUpdate(
            { guildId: war.opponentGuildId },
            { $set: { 'activeWar.status': 'ended' } }
        );
    }

    // Apply 2x coin booster to all winners
    if (iWon) {
        const expiresAt = new Date(Date.now() + 86400000);
        await User.updateMany(
            { guildId },
            { $push: { activeEffects: { type: 'coin_boost_2x', expiresAt, charges: -1 } } }
        );
    }
}

module.exports = {
    cooldown: 5,
    grantWarPoints,
    data: new SlashCommandBuilder()
        .setName('war')
        .setDescription('Server vs server war events.')
        .addSubcommand(sub =>
            sub.setName('challenge')
                .setDescription('[Admin] Challenge another server to a 7-day war.')
                .addStringOption(opt =>
                    opt.setName('invite_code')
                        .setDescription('Your server invite code to share with the opponent')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('accept')
                .setDescription('[Admin] Accept a war challenge from another server.')
                .addStringOption(opt =>
                    opt.setName('challenger_invite')
                        .setDescription('The invite code from the server that challenged you')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('View the current war scoreboard.')
        )
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('[Admin] Cancel the current war.')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'challenge') return await executeChallenge(interaction);
            if (sub === 'accept')    return await executeAccept(interaction);
            if (sub === 'status')    return await executeStatus(interaction);
            if (sub === 'cancel')    return await executeCancel(interaction);
        } catch (err) {
            console.error('[war] error:', err);
            const msg = { content: 'Something went wrong with the war command.', ephemeral: true };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
