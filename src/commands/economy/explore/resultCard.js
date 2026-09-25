'use strict';

// The picture on a paying /explore go: what the expedition turned up, drawn by
// utils/grindResultCard — the same card /hunt start draws for a kill, /fish
// cast for a catch and /mine dig for a strike, so the grinds' results read as
// one family. It rides above the result text as an image-only embed, so the
// art leads and the text beneath stays the record — every number on the card
// is also in that text, and the file carries alt text for anyone who cannot
// see it.
//
// The subject is the recovered relic when there is one, otherwise the region
// itself (explore art is bundle-only; a missing icon draws the medallion). The
// gauge sets the haul against the explorer's best haul and the server's.
// Traps, quiet walks and lost encounters are misses, and stay text-only.

const { EmbedBuilder } = require('discord.js');
const { createGrindResultCard, TIER_COLOR } = require('../../../utils/grindResultCard');
const { renderAttachment } = require('../../../utils/grindProfileView');
const { standing } = require('../../../utils/grindRecord');
const { TIER_NUM } = require('../../../data/materialRarity');
const { relicItemId, exploreRegionItemId } = require('../../../data/activityItems');
const { relicSlug } = require('../../../data/exploreData');
const { resolveRoute } = require('../../../services/exploreService');

const CARD_FILE = 'explore-result.png';

const TITLE = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

/** Whether this result gets a card: a find, not a miss. */
function isCardResult(result) {
    if (!result) return false;
    if (result.type === 'encounter') return result.outcome === 'win' || result.outcome === 'safe';
    return ['treasure', 'secret', 'discovery', 'lore'].includes(result.type);
}

/**
 * What the expedition turned up, as the card's subject: its name, its grade,
 * and the line under it. A relic is graded by its own rarity, not the
 * treasure it came in.
 */
function describeFind(result, region) {
    const regionArt = exploreRegionItemId(region.id);
    if (result.relic) {
        const chest = result.treasureTier?.tier;
        return {
            verb: 'recovered',
            subject: { name: result.relic.itemId, iconId: relicItemId(relicSlug(result.relic.itemId)) },
            tierNum: TIER_NUM[result.relic.rarity] ?? 3,
            subtitle: `${TITLE[result.relic.rarity] ?? 'Rare'} relic${chest ? ` · from ${/^[aeiou]/i.test(chest) ? 'an' : 'a'} ${chest} treasure` : ''}`,
        };
    }
    switch (result.type) {
        case 'treasure': {
            const tier = result.treasureTier?.tier ?? 'common';
            return {
                verb: 'found',
                subject: { name: `${TITLE[tier] ?? 'Common'} Treasure`, iconId: regionArt },
                tierNum: TIER_NUM[tier] ?? 1,
                subtitle: result.fallbackTreasure ? 'Treasure, where the map ran out' : 'Treasure',
            };
        }
        case 'secret':
            return { verb: 'uncovered', subject: { name: result.secret.name, iconId: regionArt }, tierNum: 5, subtitle: 'A secret of the region' };
        case 'discovery':
            return result.anomaly
                ? { verb: 'investigated', subject: { name: result.anomaly.name, iconId: regionArt }, tierNum: 3, subtitle: 'Anomaly' }
                : { verb: 'discovered', subject: { name: result.landmark.name, iconId: regionArt }, tierNum: 2, subtitle: 'Landmark, now on the map' };
        case 'lore':
            return {
                verb: 'found',
                subject: { name: 'Lore Fragment', iconId: regionArt },
                tierNum: 2,
                subtitle: result.loreCompleted ? 'The last of the story' : 'A piece of the region\'s story',
            };
        case 'encounter':
        default: {
            const won = result.outcome === 'win';
            return {
                verb: 'met',
                subject: { name: result.encounter?.name ?? 'A stranger', iconId: regionArt },
                tierNum: won ? 3 : 1,
                subtitle: won ? 'Approached, and won' : result.hesitated ? 'Hesitated, and kept your distance' : 'Kept your distance',
            };
        }
    }
}

/**
 * The expedition's chips for the card, from the same facts the embed's text
 * uses. The bonuses are said only on a run that paid, as the embed's
 * standing-bonus line is: on a capped run they multiplied nothing.
 */
function cardChips({ result, rarePetDrop = null, featuredPct = 0 }) {
    const chips = [];
    if (result.payout > 0) {
        const route = result.route ? resolveRoute(result.route) : null;
        if (route?.payoutBonus) {
            const pct = Math.round(route.payoutBonus * 100);
            chips.push({ text: `${route.name} ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`, tone: pct > 0 ? 'info' : 'bad' });
        }
        if (result.streakBonus > 0) chips.push({ text: `Streak +${Math.round(result.streakBonus * 100)}%`, tone: 'gold' });
        if (result.featured) chips.push({ text: `Featured region +${featuredPct}%`, tone: 'gold' });
    }
    if (result.firstVisit) chips.push({ text: 'First visit', tone: 'info' });
    if (result.relicIsNew && !result.relicOwed) chips.push({ text: 'New to your case', tone: 'good' });
    if (result.material?.label) chips.push({ text: `Found: ${result.material.label}`, tone: 'info' });
    if (rarePetDrop) chips.push({ text: `Companion: ${rarePetDrop.name}`, tone: 'gold' });
    if (result.injured) chips.push({ text: 'Injured', tone: 'bad' });
    return chips;
}

/**
 * `records` is { priorBest, othersBest }: the explorer's best haul before this
 * expedition, and everyone else's (null when that read failed).
 */
function cardOptions({ result, region, chips = [], username = 'Explorer', records = {} }) {
    const find = describeFind(result, region);
    const payout = result.payout ?? 0;
    const capped = payout <= 0 && !!result.hardCapped;

    const levelUp = result.explorerLevelUp ?? null;
    const extraStat = levelUp ? { label: 'LEVEL UP', value: `${levelUp.oldLevel} → ${levelUp.newLevel}` } : null;

    const where = standing(capped ? 0 : payout, records);
    const badges = [];
    if (where.serverRecord) badges.push({ text: 'SERVER RECORD', tone: 'gold' });
    if (where.personalBest) badges.push({ text: 'PERSONAL BEST', tone: 'good' });
    badges.push(...chips);

    const apex = result.regionCompleted
        ? {
            label: 'REGION SURVEYED', outcome: 'perfect',
            title: `${region.name} is fully charted`,
            detail: `+${Math.round((result.surveyBonus ?? 0) * 100)}% here from now on`,
        }
        : null;

    return {
        activity: 'explore',
        kicker: `${username} ${find.verb}`,
        subject: find.subject,
        tierNum: find.tierNum,
        subtitle: find.subtitle,
        place: { name: region.name, iconId: exploreRegionItemId(region.id) },
        payout: capped ? 0 : payout,
        forfeited: capped ? (result.grossPayout ?? 0) : null,
        xp: result.xp ?? 0,
        extraStat,
        gauge: { best: where.best, record: where.record ?? 0 },
        badges,
        apex,
    };
}

/** What a screen reader says for the card: the same facts, in a sentence. */
function altText(opts) {
    const tier = ['', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'][opts.tierNum];
    const parts = [
        `${opts.kicker} ${opts.subject.name} in ${opts.place.name} (${tier}; ${opts.subtitle}).`,
        opts.forfeited != null
            ? `No coins — the daily cap withheld ${opts.forfeited.toLocaleString('en-US')}.`
            : `${opts.payout.toLocaleString('en-US')} coins and ${opts.xp} XP.`,
    ];
    if (opts.extraStat) parts.push(`${opts.extraStat.label.toLowerCase()} ${opts.extraStat.value}.`);
    if (opts.badges.length) parts.push(`${opts.badges.map(c => c.text).join(', ')}.`);
    if (opts.apex) parts.push(`${opts.apex.title}: ${opts.apex.detail}.`);
    return parts.join(' ');
}

/**
 * Renders the card for an expedition that found something. Returns
 * { embed, file } — the image-only embed to lead the message and its
 * attachment — or null for a miss or a render that fails, in which case the
 * result goes out as text with the relic or region thumbnail, as before.
 */
async function renderExploreResultCard(args) {
    if (!isCardResult(args.result)) return null;
    const opts = cardOptions(args);
    const file = await renderAttachment(() => createGrindResultCard(opts), CARD_FILE, altText(opts));
    if (!file) return null;
    const embed = new EmbedBuilder()
        .setColor(TIER_COLOR[opts.tierNum])
        .setImage(`attachment://${CARD_FILE}`);
    return { embed, file };
}

module.exports = { CARD_FILE, altText, cardChips, cardOptions, describeFind, isCardResult, renderExploreResultCard };
