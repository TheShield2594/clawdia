'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { attachGrind } = require('../../utils/grindProfile');
const Guild = require('../../models/Guild');
const {
    LIMITS, EXPLORER_LEVELS, TIER_COLORS, REGIONS, REGION_LIST,
    FOOTER_LINES, INJURY_LINES,
} = require('../../data/exploreData');
const {
    ensureExploreData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getLevelData,
    xpToNextLevel,
    getRegionProgress,
    isRegionInSeason,
    isRegionEnabled,
    getAvailableRegions,
    executeExplore,
    resolveEncounter,
    addJournalEntry,
    regionCompletion,
    renderMap,
    randomFrom,
    formatMs,
} = require('../../services/exploreService');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { applyXpGain, announceLevelUp } = require('../../utils/applyXpGain');
const {
    getEventXpMultiplier, getEventCoinMultiplier,
    hasActiveEvent, getEventCurrencyId, addEventCurrency,
} = require('../../services/seasonalEventService');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');
const { buildCooldownEmbed } = require('../../utils/cooldownEmbed');
const { logTransaction } = require('../../utils/logTransaction');
const { logBigWin } = require('../../utils/bigWinLogger');
const { progressBar } = require('../../utils/progressBar');

const REGION_CHOICES = REGION_LIST.map(r => ({
    name: `${r.emoji} ${r.name}${r.seasonalEventId ? ' (seasonal)' : ''}`,
    value: r.id,
}));

const EVENT_TYPE_EMOJI = {
    discovery: '🗿', lore: '📜', secret: '✨', treasure: '🪙',
    trap: '🪤', encounter: '👁️', quiet: '🌫️',
};

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('explore')
        .setDescription('World exploration: set out into the wilds, chart your map, and find what hides there.')
        .addSubcommand(sub =>
            sub.setName('go')
                .setDescription('Set out on an expedition. Uses 1 stamina. Cooldown: 60s.')
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Region to explore (defaults to your active region)')
                        .setRequired(false)
                        .addChoices(...REGION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('map')
                .setDescription("View your Explorer's Map — every region, landmark, and secret you've charted."))
        .addSubcommand(sub =>
            sub.setName('travel')
                .setDescription('Travel to a region (unlocking it first if needed) and make it your active region.')
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Destination region')
                        .setRequired(true)
                        .addChoices(...REGION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('regions')
                .setDescription('Browse every known region — requirements, season windows, and your progress.'))
        .addSubcommand(sub =>
            sub.setName('journal')
                .setDescription('Reread your expedition journal — your most recent finds, in order.'))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another wanderer's explorer profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Explorer to inspect')
                        .setRequired(false))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'go')      return handleGo(interaction);
        if (sub === 'map')     return handleMap(interaction);
        if (sub === 'travel')  return handleTravel(interaction);
        if (sub === 'regions') return handleRegions(interaction);
        if (sub === 'journal') return handleJournal(interaction);
        if (sub === 'profile') return handleProfile(interaction);
    },

    // Exposed so /map can render the same Explorer's Map
    handleMap,
};

// ─── Shared guards ────────────────────────────────────────────────────────────

async function loadContext(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        await interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        return null;
    }
    if (guildSettings?.exploration?.enabled === false) {
        await interaction.reply({ content: 'Exploration is switched off on this server. The wilds will wait — they\'re good at it.', flags: MessageFlags.Ephemeral });
        return null;
    }
    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureExploreData(user);
    return { guildSettings, user, currency: guildSettings?.economy?.currency ?? '💰' };
}

// Region gate shared by go/travel: returns an error string or null
function regionGateError(user, region, guildSettings) {
    const e = user.exploration;
    if (!region) {
        return 'I don\'t have that place on any map, and I have several maps.';
    }
    if (!isRegionEnabled(region, guildSettings)) {
        return `**${region.name}** is closed by decree of the server staff. Even the wilds answer to someone.`;
    }
    if (region.seasonalEventId && !isRegionInSeason(region, guildSettings)) {
        return `**${region.emoji} ${region.name}** is out of season. It will be back — that kind of place always comes back. Keep an eye on \`/event status\`.`;
    }
    if (!region.seasonalEventId && !e.unlockedRegions.includes(region.id)) {
        return `You haven't opened the way to **${region.emoji} ${region.name}** yet. Use \`/explore travel\` — it costs **${region.unlockCost.toLocaleString()}** coins and Explorer Level **${region.unlockLevel}**.`;
    }
    if (!region.seasonalEventId && e.level < region.unlockLevel) {
        return `**${region.emoji} ${region.name}** requires Explorer Level **${region.unlockLevel}**. The place isn't going anywhere. You should be, though — go level up.`;
    }
    return null;
}

// ─── GO ───────────────────────────────────────────────────────────────────────

async function handleGo(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;

    applyStaminaRegen(user);
    applyDailyReset(user);
    if (user.isModified()) {
        await user.save().catch(e => console.error('[explore] pre-check save error:', e));
    }

    const e = user.exploration;
    const regionId = interaction.options.getString('region') ?? e.activeRegion;
    const region = REGIONS[regionId];

    const gateError = regionGateError(user, region, guildSettings);
    if (gateError) return interaction.reply({ content: gateError, flags: MessageFlags.Ephemeral });

    if (e.injuryUntil && Date.now() < e.injuryUntil.getTime()) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🤕 Patching Yourself Up',
                description: 'The last trap left a mark. The wilds will still be wild when you can walk straight.',
                color: '#2e7d32',
                nextAt: new Date(e.injuryUntil.getTime()),
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (e.lastExplore && Date.now() - e.lastExplore.getTime() < LIMITS.EXPLORE_COOLDOWN_MS) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '🥾 Catching Your Breath',
                description: 'You just got back. Shake the dust off, check your boots for stowaways, then go again.',
                color: '#2e7d32',
                nextAt: new Date(e.lastExplore.getTime() + LIMITS.EXPLORE_COOLDOWN_MS),
                nextRewardPreview: e.sinceSecret >= 10
                    ? `It's been ${e.sinceSecret} expeditions since your last secret. Something is overdue to find you.`
                    : 'The map never fills itself in.',
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    if (e.stamina <= 0) {
        return interaction.reply({
            embeds: [buildCooldownEmbed({
                title: '😮‍💨 Out of Stamina',
                description: 'Even legends sleep. Your legs have unionized and their demands are reasonable.',
                color: '#2e7d32',
                nextAt: new Date(Date.now() + msUntilNextStamina(user)),
                nextRewardPreview: 'Stamina regenerates 1 every 5 minutes.',
            })],
            flags: MessageFlags.Ephemeral,
        });
    }

    // ── Run the expedition ────────────────────────────────────────────────────
    const coinMultiplier = getEventCoinMultiplier(guildSettings);
    const result = executeExplore(user, region, guildSettings, { coinMultiplier });
    const firstVisit = result.firstVisit;

    // Commit stamina spend + cooldown timestamp now, before the (up to 20s)
    // encounter prompt below. Otherwise a second /explore go fired while this
    // one is still waiting on a button press reads stale DB state and slips
    // past the cooldown/stamina gate.
    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') {
            return interaction.reply({ content: 'A simultaneous request tangled your expedition log. Try `/explore go` again.', flags: MessageFlags.Ephemeral });
        }
        console.error('[explore] pre-encounter save error:', err);
        return interaction.reply({ content: 'Something went wrong writing your expedition down. Try again.', flags: MessageFlags.Ephemeral });
    }

    // Staged narration: the setting-out beat, then the find
    const delay = ms => new Promise(r => setTimeout(r, ms));
    await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(region.color)
            .setTitle(`${region.emoji} Setting out — ${region.name}`)
            .setDescription(`*${result.intro}*`)
            .setFooter({ text: region.tagline })],
    });
    await delay(2000);

    // ── Encounter choice ──────────────────────────────────────────────────────
    if (result.pendingChoice) {
        const enc = result.encounter;
        const encId = `explore_${interaction.id}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${encId}_approach`).setLabel('🤝 Approach').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${encId}_observe`).setLabel('🌿 Keep Your Distance').setStyle(ButtonStyle.Secondary),
        );
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(region.color)
                .setTitle(`${enc.emoji} ${enc.name}`)
                .setDescription(`*${enc.intro}*\n\nApproach it, or watch from a safe distance? Bold pays better. Careful always pays.`)
                .setFooter({ text: '20 seconds to decide. Hesitation counts as keeping your distance, which is honest of it.' })],
            components: [row],
        });
        const msg = await interaction.fetchReply();
        const choice = await new Promise(resolve => {
            const col = msg.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id && i.customId.startsWith(encId),
                time: 20_000,
                max: 1,
            });
            col.on('collect', async i => { await i.deferUpdate(); resolve(i.customId.endsWith('_approach') ? 'approach' : 'observe'); });
            col.on('end', (_, reason) => { if (reason !== 'limit') resolve(null); });
        });
        resolveEncounter(user, region, guildSettings, result, choice);
    }

    // ── Cross-system rewards ──────────────────────────────────────────────────
    // Seasonal event currency: a real handful in the seasonal region, loose
    // change anywhere else while an event runs.
    let eventDrop = null;
    const currencyId = getEventCurrencyId(guildSettings);
    if (currencyId && hasActiveEvent(guildSettings)) {
        const range = region.eventCurrency ?? { min: 1, max: 2 };
        const amount = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
        addEventCurrency(user, currencyId, amount);
        eventDrop = { currencyId, amount };
    }

    // Guild leveling XP mirrors half the explorer XP
    const mainXp = Math.floor((result.xp ?? 0) * 0.5 * getEventXpMultiplier(guildSettings));
    let leveledUp = false;
    if (mainXp > 0) {
        ({ leveled: leveledUp } = applyXpGain(user, mainXp));
    }

    // Journal
    addJournalEntry(user, region.id, result.type, summarizeResult(result, currency));

    // Achievements (checked against the freshly mutated user doc)
    const newAchievements = await checkAndAward(user, guildSettings).catch(() => []);

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') {
            return interaction.editReply({ content: 'A simultaneous request tangled your expedition log. Try `/explore go` again.', embeds: [], components: [] });
        }
        console.error('[explore] save error:', err);
        return interaction.editReply({ content: 'Something went wrong writing your expedition down. Try again.', embeds: [], components: [] });
    }

    if (newAchievements.length) {
        announceAchievements(interaction.client, guildSettings, user, interaction.member, newAchievements).catch(() => null);
    }
    if (leveledUp) {
        announceLevelUp(user, guildSettings, interaction.member, interaction.guild, interaction.channel).catch(() => null);
    }

    // Transaction audit log
    if (result.payout > 0) {
        logTransaction({ userId: user.userId, guildId: user.guildId, type: 'explore', amount: result.payout, balance: user.balance, note: `${region.name} · ${result.type}` });
    } else if (result.penalty > 0) {
        logTransaction({ userId: user.userId, guildId: user.guildId, type: 'explore', amount: -result.penalty, balance: user.balance, note: `${region.name} · ${result.type}` });
    }

    // Big-win feed for legendary treasure and secrets
    if (result.payout > 0 && (result.treasureTier?.tier === 'legendary' || result.type === 'secret')) {
        logBigWin({ guildId: interaction.guild.id, userId: interaction.user.id, username: interaction.user.username, amount: result.payout, source: 'explore', details: result.secret?.name ?? `${region.name} legendary treasure` });
    }

    // ── Result embed ──────────────────────────────────────────────────────────
    const embed = buildResultEmbed(result, region, user, currency, eventDrop, mainXp, firstVisit);
    await interaction.editReply({ embeds: [embed], components: [] });

    // Server-wide whisper for secrets
    if (result.type === 'secret' && guildSettings?.exploration?.announceSecrets !== false) {
        const channelId = guildSettings?.economy?.announcementChannelId;
        const resolved = channelId ? interaction.guild.channels.cache.get(channelId) : null;
        const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
        announceChannel.send({
            embeds: [new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('✨ A Secret Has Been Found')
                .setDescription(
                    `<@${interaction.user.id}> just uncovered **${result.secret.name}** in ${region.emoji} **${region.name}**.\n\n` +
                    `*The map has fewer blank spaces tonight. The blank spaces are taking it personally.*`
                )
                .setTimestamp()],
        }).catch(() => null);
    }
}

function summarizeResult(result, currency) {
    switch (result.type) {
        case 'discovery': return `Charted ${result.landmark.name}`;
        case 'lore':      return `Recovered a lore fragment`;
        case 'secret':    return `Uncovered the secret: ${result.secret.name}`;
        case 'treasure':  return `${result.relic ? `Recovered ${result.relic.itemId} and ` : ''}hauled ${currency}${result.payout.toLocaleString()} in treasure`;
        case 'trap':      return `Sprang ${result.trap.name} (−${currency}${(result.penalty ?? 0).toLocaleString()})`;
        case 'encounter': return result.outcome === 'win'
            ? `Faced ${result.encounter.name} and came out ahead`
            : result.outcome === 'safe'
                ? `Watched ${result.encounter.name} from a respectful distance`
                : `Faced ${result.encounter.name} and paid the tuition`;
        default:          return 'A long, quiet walk';
    }
}

function buildResultEmbed(result, region, user, currency, eventDrop, mainXp, firstVisit) {
    const e = user.exploration;
    const embed = new EmbedBuilder().setTimestamp();
    const lines = [];

    switch (result.type) {
        case 'discovery':
            embed.setColor(region.color).setTitle(`🗿 Landmark Charted — ${result.landmark.name}`);
            lines.push(`*${result.landmark.line}*`);
            break;
        case 'lore':
            embed.setColor('#b39ddb').setTitle('📜 Lore Fragment Recovered');
            lines.push(`*You find words someone meant to be found:*`, '', `> ${result.lore.text}`);
            break;
        case 'secret':
            embed.setColor('#FFD700').setTitle(`✨ SECRET UNCOVERED — ${result.secret.name}`);
            lines.push(`*${result.secret.reveal}*`);
            break;
        case 'treasure': {
            const tier = result.treasureTier;
            embed.setColor(TIER_COLORS[tier.tier] ?? region.color)
                .setTitle(`🪙 Treasure — ${tier.tier.charAt(0).toUpperCase() + tier.tier.slice(1)} ${tier.stars}`);
            lines.push(`*${result.treasureLine}*`);
            if (result.relic) {
                lines.push('', `🏺 **Relic recovered: ${result.relic.itemId}**`, `> *${result.relic.lore}*`, `> It's in your \`/inventory\` now. It was always going to end up there.`);
            }
            break;
        }
        case 'trap':
            embed.setColor('#b5651d').setTitle(`🪤 Trap — ${result.trap.name}`);
            lines.push(`*${result.trap.line}*`);
            if (result.injured) lines.push('', `🤕 *${randomFrom(INJURY_LINES)}* (10 min)`);
            break;
        case 'encounter': {
            const enc = result.encounter;
            if (result.outcome === 'win') {
                embed.setColor('#00CC55').setTitle(`${enc.emoji} ${enc.name} — Well Played`);
                lines.push(`*${enc.winLine}*`);
            } else if (result.outcome === 'safe') {
                embed.setColor(region.color).setTitle(`${enc.emoji} ${enc.name} — Watched From the Ferns`);
                lines.push(`*${enc.safeLine}*`);
            } else {
                embed.setColor('#CC4400').setTitle(`${enc.emoji} ${enc.name} — That Went Differently`);
                lines.push(`*${enc.loseLine}*`);
                if (result.injured) lines.push('', `🤕 *${randomFrom(INJURY_LINES)}* (10 min)`);
            }
            break;
        }
        default:
            embed.setColor('#78909c').setTitle('🌫️ A Quiet Expedition');
            lines.push(`*${result.quietLine}*`);
            break;
    }

    if (firstVisit) {
        lines.push('', `🗺️ **New region charted: ${region.emoji} ${region.name}** — it has a place on your map now. So do its blank spaces.`);
    }

    embed.setDescription(lines.join('\n'));

    const gains = [];
    if (result.payout > 0)  gains.push(`+${currency}${result.payout.toLocaleString()}`);
    if (result.penalty > 0) gains.push(`−${currency}${result.penalty.toLocaleString()}`);
    if (result.xp > 0)      gains.push(`+${result.xp} Explorer XP`);
    if (mainXp > 0)         gains.push(`+${mainXp} XP`);
    if (eventDrop) {
        const def = Object.values(SEASONAL_EVENTS).find(s => s.currency?.id === eventDrop.currencyId);
        gains.push(`+${eventDrop.amount} ${def?.currency?.emoji ?? '🎟️'} ${def?.currency?.name ?? eventDrop.currencyId}`);
    }
    if (gains.length) embed.addFields({ name: '🎒 The Haul', value: gains.join('  ·  '), inline: false });

    embed.setFooter({ text: `⚡ ${e.stamina}/${LIMITS.MAX_STAMINA} stamina · ${randomFrom(FOOTER_LINES)}` });
    return embed;
}

// ─── MAP ──────────────────────────────────────────────────────────────────────

async function handleMap(interaction) {
    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
        Guild.findOne({ guildId: interaction.guild.id }),
    ]);
    await attachGrind(userData);

    if (!userData?.exploration?.totalExpeditions) {
        return interaction.reply({
            content: 'Your map is a blank page with your name on it. Poetic, but useless. `/explore go` fixes that.',
            flags: MessageFlags.Ephemeral,
        });
    }

    ensureExploreData(userData);
    const e = userData.exploration;
    const lines = renderMap(userData, guildSettings);
    const levelData = getLevelData(e.level);

    const embed = new EmbedBuilder()
        .setColor('#2e7d32')
        .setTitle(`🗺️ The Explorer's Map — ${interaction.user.username}`)
        .setDescription(
            `*Every line on this map cost somebody shoe leather. These lines cost yours.*\n\n` +
            lines.join('\n\n')
        )
        .addFields({
            name: '🧭 The Tally',
            value: [
                `**${levelData.title}** — Explorer Lv ${e.level}`,
                `🗿 ${e.landmarksDiscovered} landmarks · 📜 ${e.loreCollected} lore · ✨ ${e.secretsFound} secrets · 🏺 ${e.relicsRecovered} relics`,
                `${e.totalExpeditions.toLocaleString()} expeditions logged`,
            ].join('\n'),
            inline: false,
        })
        .setFooter({ text: 'The blank spaces aren\'t empty. They\'re waiting.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── TRAVEL ───────────────────────────────────────────────────────────────────

async function handleTravel(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;
    const e = user.exploration;

    const region = REGIONS[interaction.options.getString('region')];
    if (!region) {
        return interaction.reply({ content: 'I don\'t have that place on any map, and I have several maps.', flags: MessageFlags.Ephemeral });
    }
    if (!isRegionEnabled(region, guildSettings)) {
        return interaction.reply({ content: `**${region.name}** is closed by decree of the server staff.`, flags: MessageFlags.Ephemeral });
    }
    if (region.seasonalEventId && !isRegionInSeason(region, guildSettings)) {
        return interaction.reply({ content: `**${region.emoji} ${region.name}** is out of season. It will return when the calendar does its part.`, flags: MessageFlags.Ephemeral });
    }

    let unlockLine = '';
    if (!region.seasonalEventId && !e.unlockedRegions.includes(region.id)) {
        if (e.level < region.unlockLevel) {
            return interaction.reply({
                content: `The way to **${region.emoji} ${region.name}** needs Explorer Level **${region.unlockLevel}**. You're Level **${e.level}**. The road respects experience; go collect some.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        if (user.balance < region.unlockCost) {
            return interaction.reply({
                content: `Opening the route to **${region.emoji} ${region.name}** costs **${currency}${region.unlockCost.toLocaleString()}** — guides, bribes, one very specific key. You have ${currency}${user.balance.toLocaleString()}.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        user.balance -= region.unlockCost;
        e.unlockedRegions.push(region.id);
        unlockLine = `\n\n🔓 Route opened for **${currency}${region.unlockCost.toLocaleString()}**. Money well buried.`;
        logTransaction({ userId: user.userId, guildId: user.guildId, type: 'explore_unlock', amount: -region.unlockCost, balance: user.balance, note: region.name });
    }

    e.activeRegion = region.id;
    user.markModified('exploration');
    await user.save();

    return interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(region.color)
            .setTitle(`${region.emoji} Now Exploring: ${region.name}`)
            .setDescription(`*${region.description}*${unlockLine}`)
            .setFooter({ text: region.tagline })],
    });
}

// ─── REGIONS ──────────────────────────────────────────────────────────────────

async function handleRegions(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;
    const e = user.exploration;

    const sections = REGION_LIST
        .filter(r => isRegionEnabled(r, guildSettings))
        .map(region => {
            const progress = e.regions.find(r => r.regionId === region.id) ?? null;
            const pct = progress ? regionCompletion(region, progress) : 0;
            const active = e.activeRegion === region.id ? ' 🧭 *(active)*' : '';

            let status;
            if (region.seasonalEventId) {
                status = isRegionInSeason(region, guildSettings)
                    ? '🟢 **In season** — open to everyone, free entry, limited time'
                    : '⚪ Out of season — returns with its event';
            } else if (e.unlockedRegions.includes(region.id)) {
                status = e.level >= region.unlockLevel ? '🟢 Open to you' : `🟡 Unlocked, needs Explorer Lv ${region.unlockLevel}`;
            } else {
                status = `🔒 Explorer Lv ${region.unlockLevel} + ${currency}${region.unlockCost.toLocaleString()} via \`/explore travel\``;
            }

            return [
                `${region.emoji} **${region.name}**${active} — *${region.tagline}*`,
                `> ${status}`,
                `> ${progress ? `${pct}% charted · ${progress.expeditions} expeditions` : 'Uncharted'}`,
            ].join('\n');
        });

    const embed = new EmbedBuilder()
        .setColor('#2e7d32')
        .setTitle('🧭 Known Regions')
        .setDescription(sections.join('\n\n'))
        .setFooter({ text: 'Seasonal regions come and go with /event seasons. The core four are always out there, being patient.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── JOURNAL ──────────────────────────────────────────────────────────────────

async function handleJournal(interaction) {
    const userData = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    await attachGrind(userData);

    const journal = userData?.exploration?.journal ?? [];
    if (!journal.length) {
        return interaction.reply({
            content: 'Your journal is empty. Every page is still possible. `/explore go` writes the first one.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const lines = journal.slice(0, 12).map(entry => {
        const region = REGIONS[entry.regionId];
        const stamp = `<t:${Math.floor(new Date(entry.at).getTime() / 1000)}:R>`;
        return `${EVENT_TYPE_EMOJI[entry.eventType] ?? '🥾'} ${region?.emoji ?? ''} **${region?.name ?? entry.regionId}** — ${entry.summary} *(${stamp})*`;
    });

    const embed = new EmbedBuilder()
        .setColor('#8d6e63')
        .setTitle(`📔 Expedition Journal — ${interaction.user.username}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'The last 20 entries are kept. The rest live in the retelling.' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: target.id, guildId: interaction.guild.id }),
        Guild.findOne({ guildId: interaction.guild.id }),
    ]);
    await attachGrind(userData);

    if (!userData?.exploration?.totalExpeditions) {
        return interaction.reply({
            content: isSelf
                ? 'You haven\'t set out yet. The wilds have noticed. `/explore go` settles the matter.'
                : `${target.username} hasn't set a single boot past the gate yet.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    ensureExploreData(userData);
    if (isSelf) applyStaminaRegen(userData);

    const e = userData.exploration;
    const currency = guildSettings?.economy?.currency ?? '💰';
    const levelData = getLevelData(e.level);
    const toNext = xpToNextLevel(e.level, e.xp);
    const activeRegion = REGIONS[e.activeRegion];
    const nextThreshold = EXPLORER_LEVELS.find(l => l.level === e.level + 1)?.xpRequired;

    const stamBar = '⚡'.repeat(e.stamina) + '▪️'.repeat(Math.max(0, LIMITS.MAX_STAMINA - e.stamina));
    const regenMs = msUntilNextStamina(userData);

    const embed = new EmbedBuilder()
        .setColor(activeRegion?.color ?? '#2e7d32')
        .setTitle(`🧭 ${target.username}'s Explorer Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '🥾 Rank',
                value: `**${levelData.title}** (Level ${e.level})`,
                inline: true,
            },
            {
                name: '⭐ Explorer XP',
                value: toNext !== null
                    ? `${e.xp.toLocaleString()} / ${nextThreshold.toLocaleString()} XP\n${progressBar(e.xp, nextThreshold, 12)}\n${toNext.toLocaleString()} to Level ${e.level + 1}`
                    : `${e.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true,
            },
            {
                name: '🗺️ Active Region',
                value: activeRegion ? `${activeRegion.emoji} ${activeRegion.name}` : 'Unknown',
                inline: true,
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${e.stamina}/${LIMITS.MAX_STAMINA}${e.stamina < LIMITS.MAX_STAMINA ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
                inline: true,
            },
            {
                name: '💰 Balance',
                value: `${currency}${userData.balance.toLocaleString()}`,
                inline: true,
            },
            {
                name: '📊 Field Record',
                value: [
                    `Expeditions:     **${e.totalExpeditions.toLocaleString()}**`,
                    `Total Earned:    **${currency}${e.totalEarned.toLocaleString()}**`,
                    `Best Haul:       **${currency}${e.bestHaul.toLocaleString()}**`,
                    `Secrets Found:   **${e.secretsFound}**`,
                    `Relics:          **${e.relicsRecovered}**`,
                    `Traps Sprung:    **${e.trapsSprung}** *(we don't judge here. much.)*`,
                ].join('\n'),
                inline: false,
            }
        )
        .setTimestamp();

    if (isSelf) {
        embed.setFooter({ text: `Daily: ${e.dailyExpeditions} expeditions · ${currency}${e.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    return interaction.reply({ embeds: [embed] });
}
