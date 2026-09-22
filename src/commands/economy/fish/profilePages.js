'use strict';

// The three pages of /fish profile — overview, catalog, progress — in the
// carded, tabbed shape /hunt and /explore share (utils/grindProfileView.js).
// profile.js loads the player and hands these to the tab row.

const { EmbedBuilder } = require('discord.js');
const {
    getLevelData,
    getMaxStamina,
    msUntilNextStamina,
    formatMs,
} = require('../../../services/fishService');
const {
    FISH, LOCATION_LIST, TIER_COLORS, TIER_LABELS, LOCATIONS,
    PRESTIGE_BONUSES, FISHER_LEVELS, LIMITS,
} = require('../../../data/fishData');
const { getActiveSynergies } = require('../../../services/synergyService');
const { msUntilDailyReset: grindMsUntilDailyReset } = require('../../../services/grindEngine');
const { createGrindProfileCard, createGrindCollectionCard } = require('../../../utils/grindProfileCard');
const {
    buildTodayField, levelProgress, joinWithin, pagePayload, renderAttachment, staminaLine, xpLine,
} = require('../../../utils/grindProfileView');
const { PRESTIGE_BADGES, PRESTIGE_LABELS } = require('./shared');
const { formatPrestigeBonuses } = require('./embeds');
const COLORS = require('../../../utils/embedColors');

const FISH_TIER_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'event'];
const FISH_LIST = Object.values(FISH);

/**
 * The catalog: species landed, rarest first for the shelf. Reads the log
 * fishService.recordCatalogCatch keeps; ids no longer in FISH are skipped.
 */
function readCatalog(f) {
    const log = f.catalog ?? {};
    const caught = FISH_LIST.filter(fish => (log[fish.id]?.count ?? 0) > 0);
    const shelf = caught.slice()
        .sort((a, b) => FISH_TIER_ORDER.indexOf(b.tier) - FISH_TIER_ORDER.indexOf(a.tier)
            || (log[b.id].count - log[a.id].count))
        .slice(0, 10);
    const total = caught.reduce((sum, fish) => sum + log[fish.id].count, 0);
    return { log, caught, shelf, total };
}

/** A catch count as a corner badge: 1–99 as-is, then "99+". */
function countBadge(n) {
    return n > 99 ? '99+' : String(n);
}


function fishColor(prestige) {
    return prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#3498db';
}

async function fishOverviewPage({ target, isSelf, userData, currency, catalog }) {
    const f         = userData.fishing;
    const levelData = getLevelData(f.level);
    const progress  = levelProgress(FISHER_LEVELS, f.level, f.xp);
    const maxStam   = getMaxStamina(userData);
    const location  = LOCATIONS[f.activeLocation];
    const prestige  = f.prestige ?? 0;
    const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    const successRate = f.totalCasts > 0
        ? `${Math.round((f.successfulCasts / f.totalCasts) * 100)}%`
        : 'N/A';

    const buffs = [];
    if (f.activeBait)     buffs.push(`Bait (${f.activeBaitCastsLeft} casts)`);
    if (f.activeLuck)     buffs.push('Luck (queued)');
    if (f.activeXpScroll) buffs.push('XP Scroll (queued)');

    const pb = f.personalBest?.fish ? `${f.personalBest.fish}, ${f.personalBest.weight} lbs` : null;

    const embed = new EmbedBuilder()
        .setColor(fishColor(prestige))
        .setTitle(`${badge ? `${badge} ` : ''}${target.username}'s Fishing Profile`)
        .setDescription([
            `**${levelData.title}** · Level ${f.level}${location ? ` · ${location.emoji} ${location.name}` : ''}`
                + (prestige > 0 ? ` · ${badge} P${prestige}` : ''),
            xpLine(progress, f.level),
            staminaLine(f.stamina, maxStam, msUntilNextStamina(userData), formatMs),
            buffs.length ? `🔋 ${buffs.join(' · ')}` : null,
        ].filter(Boolean).join('\n'))
        .addFields(
            {
                name: '📊 Record',
                value: [
                    `${f.totalCasts.toLocaleString()} casts · ${successRate} success`,
                    `${currency}${f.totalEarned.toLocaleString()} earned · best ${currency}${f.bestPayout.toLocaleString()}`,
                    `${f.legendaryCatches.toLocaleString()} legendary · ${f.eventCatches.toLocaleString()} event`,
                ].join('\n'),
                inline: true
            },
            {
                name: '📖 Catalog',
                value: `${catalog.caught.length}/${FISH_LIST.length} species · ${catalog.total.toLocaleString()} logged`
                    + (pb ? `\n🏅 Heaviest: ${pb}` : ''),
                inline: true
            }
        );

    if (isSelf) {
        embed.addFields(buildTodayField({
            coins:   f.dailyCoins ?? 0,
            actions: f.dailyCasts ?? 0,
            noun:    'casts',
            limits:  LIMITS,
            resetMs: grindMsUntilDailyReset(userData, 'fish'),
            currency,
            formatMs,
        }));
    }

    if (prestige === 0 && f.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /fish prestige to reset and unlock new bonuses.' });
    }

    const card = await renderAttachment(() => createGrindProfileCard({
        activity:      'fish',
        name:          target.username,
        avatarUrl:     target.displayAvatarURL({ extension: 'png', size: 256 }),
        rankTitle:     levelData.title,
        level:         f.level,
        prestige,
        prestigeLabel: prestige > 0 ? PRESTIGE_LABELS[Math.min(prestige, PRESTIGE_LABELS.length - 1)] : null,
        xp:            { total: f.xp, into: progress.into, span: progress.span },
        place:         location ? { name: location.name, iconId: `fish:${location.id}` } : null,
        stamina:       { current: f.stamina, max: maxStam },
        stats: [
            { label: 'Casts',     value: f.totalCasts.toLocaleString('en-US') },
            { label: 'Success',   value: successRate },
            { label: 'Earned',    value: f.totalEarned.toLocaleString('en-US') },
            { label: 'Legendary', value: f.legendaryCatches.toLocaleString('en-US') },
        ],
        shelfTitle: `Rarest catches · ${catalog.caught.length}/${FISH_LIST.length} species`,
        shelf: catalog.shelf.map(fish => ({
            iconId: `fishcatch:${fish.id}`, name: fish.name,
            badge: countBadge(catalog.log[fish.id].count), badgeColor: TIER_COLORS[fish.tier],
        })),
        shelfEmpty: 'The catalog fills as you land fish — every species gets a page.',
    }), 'fish-profile.png',
        `Fishing profile card for ${target.username}: ${levelData.title}, level ${f.level}, `
        + `${progress.span == null ? 'max level' : `${Math.floor(progress.frac * 100)}% to level ${f.level + 1}`}, `
        + `${location ? `fishing at ${location.name}, ` : ''}stamina ${f.stamina} of ${maxStam}, `
        + `${f.totalCasts} casts, ${successRate} success, ${f.legendaryCatches} legendary. `
        + (catalog.shelf.length ? `Rarest catches: ${catalog.shelf.map(fish => fish.name).join(', ')}.` : 'No species logged yet.'));

    return pagePayload(embed, card);
}

async function fishCatalogPage({ target, isSelf, userData, catalog }) {
    const f = userData.fishing;

    const tierCounts = FISH_TIER_ORDER.map(tier => {
        const inTier = FISH_LIST.filter(fish => fish.tier === tier);
        const got = inTier.filter(fish => catalog.log[fish.id]?.count > 0).length;
        return inTier.length ? `${TIER_LABELS[tier]} ${got}/${inTier.length}` : null;
    }).filter(Boolean);

    const reachable = new Set(f.unlockedLocations);
    const missing = FISH_LIST
        .filter(fish => !(catalog.log[fish.id]?.count > 0) && fish.tier !== 'event'
            && (fish.locations.includes('all') || fish.locations.some(l => reachable.has(l))))
        .map(fish => `${fish.emoji} ${fish.name}`);

    const heaviest = catalog.caught
        .filter(fish => catalog.log[fish.id].heaviest > 0)
        .sort((a, b) => catalog.log[b.id].heaviest - catalog.log[a.id].heaviest)
        .slice(0, 3)
        .map(fish => `${fish.emoji} ${fish.name} — ${catalog.log[fish.id].heaviest} lbs`);

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`📖 ${target.username}'s Fish Catalog`)
        .setDescription([
            `**${catalog.caught.length} of ${FISH_LIST.length} species** · ${catalog.total.toLocaleString()} fish logged`,
            tierCounts.join(' · '),
        ].join('\n'))
        .setFooter({ text: 'Badges count catches of each species · the log began with this update, so older catches are not in it' });

    if (heaviest.length) embed.addFields({ name: '⚖️ Heaviest in the log', value: heaviest.join('\n'), inline: false });
    if (missing.length) {
        embed.addFields({
            name: isSelf ? '🎯 Still to land in your waters' : '🎯 Still to land in their waters',
            value: joinWithin(missing, ' · ', 1024),
            inline: false,
        });
    }

    const card = await renderAttachment(() => createGrindCollectionCard({
        activity: 'fish',
        title:    `${target.username}'s Fish Catalog`,
        subtitle: `${catalog.caught.length} of ${FISH_LIST.length} species · ${catalog.total.toLocaleString('en-US')} fish logged`,
        sections: FISH_TIER_ORDER.map(tier => ({
            label: TIER_LABELS[tier],
            color: TIER_COLORS[tier],
            entries: FISH_LIST.filter(fish => fish.tier === tier).map(fish => {
                const count = catalog.log[fish.id]?.count ?? 0;
                return {
                    iconId: `fishcatch:${fish.id}`, name: fish.name, owned: count > 0,
                    badge: count > 0 ? countBadge(count) : null, badgeColor: TIER_COLORS[tier],
                };
            }),
        })),
    }), 'fish-catalog.png',
        `Fish catalog for ${target.username}: ${catalog.caught.length} of ${FISH_LIST.length} species. ${tierCounts.join(', ')}.`);

    return pagePayload(embed, card);
}

async function fishProgressPage({ target, userData }) {
    const f        = userData.fishing;
    const prestige = f.prestige ?? 0;
    const badge    = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';
    const pBonus   = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(fishColor(prestige))
        .setTitle(`🎖️ ${target.username}'s Fishing Progress`)
        .addFields(
            {
                name: prestige > 0 ? `${badge} Prestige ${prestige} Bonuses` : '✨ Prestige',
                value: prestige > 0
                    ? formatPrestigeBonuses(pBonus)
                    : `None yet — reach Level 50 and use \`/fish prestige\` (Level ${f.level} now).`,
                inline: true,
            },
            {
                name: `🗺️ Locations (${f.unlockedLocations.length}/${LOCATION_LIST.length})`,
                value: LOCATION_LIST.map(l => f.unlockedLocations.includes(l.id)
                    ? `${l.emoji} ${l.name}`
                    : `🔒 ${l.name} · Lv ${l.unlockLevel}`).join('\n'),
                inline: true,
            }
        );

    if (f.trophies?.length) {
        embed.addFields({ name: '🎗️ Ribbons', value: joinWithin(f.trophies, '\n', 1024), inline: false });
    }

    const activeSynergies = getActiveSynergies(userData);
    embed.addFields({
        name: '🔗 Synergies',
        value: activeSynergies.length
            ? activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n')
            : 'Reach combined level milestones across Hunt, Fish, Mine & Explore to unlock cross-system bonuses — see `/synergies`.',
        inline: false,
    });

    return pagePayload(embed, null);
}

module.exports = {
    fishCatalogPage,
    fishOverviewPage,
    fishProgressPage,
    readCatalog,
};
