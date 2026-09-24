'use strict';

// The /fish cast catch card: turns a cast result into the options the card
// (utils/catchCard.js) draws, and the attachment the result embed shows as its
// image. Returns null when the card cannot be drawn, and the cast falls back to
// the fish's icon as a thumbnail.

const { createCatchCard } = require('../../../utils/catchCard');
const { renderAttachment } = require('../../../utils/grindProfileView');
const { TIER_COLORS, FISH_WEIGHTS, FISH_BASE_WEIGHTS, SIZE_TIERS } = require('../../../data/fishData');
const { TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');

const MIN_WEIGHT_MULT = Math.min(...SIZE_TIERS.map(t => t.weightMult));
const MAX_WEIGHT_MULT = Math.max(...SIZE_TIERS.map(t => t.weightMult));

const TIER_LABEL = { event: 'Mythical' };

function tierLabel(tier) {
    return TIER_LABEL[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * The card's options for a landed fish. Pure, so it is testable without a
 * canvas.
 */
function catchCardOptions({ result, location, worldRecord, reelResult, username }) {
    const { fish, tier } = result;
    const range = FISH_WEIGHTS[fish.id] ?? FISH_BASE_WEIGHTS[fish.tier];

    // The standing record to measure against: the one this catch beat, or the
    // one it fell short of. A record the catch set is the catch itself.
    const record = worldRecord?.set
        ? (worldRecord.previous?.weight ?? 0)
        : (worldRecord?.record?.weight ?? 0);

    const badges = [];
    if (worldRecord?.set)      badges.push({ text: 'SERVER RECORD', color: '#ffd166' });
    if (result.isPersonalBest) badges.push({ text: 'PERSONAL BEST', color: '#4cc27a' });
    if (result.firstCatch)     badges.push({ text: 'NEW SPECIES', color: '#45a6ec' });
    if (result.isCrit)         badges.push({ text: 'CRITICAL', color: '#ffd700' });
    if (reelResult?.caught && reelResult.icon !== '😬') badges.push({ text: 'PERFECT READ', color: '#c39bd3' });

    let extraStat = null;
    if (result.isCrit)                      extraStat = { label: 'CRITICAL', value: `×${Number(result.critMultiplier).toFixed(2)}` };
    else if ((result.streakMult ?? 1) > 1)  extraStat = { label: 'STREAK', value: `×${Number(result.streakMult).toFixed(2)}` };

    return {
        angler:    username,
        fish:      { name: fish.name, iconId: `fishcatch:${fish.id}` },
        tierLabel: tierLabel(tier),
        tierStars: TIER_STARS[TIER_NUM[tier] ?? 1] ?? '',
        tierColor: TIER_COLORS[tier] ?? TIER_COLORS.common,
        sizeLabel: result.sizeLabel ?? null,
        weight:    result.weightLbs ?? 0,
        gauge: range && result.weightLbs > 0 ? {
            min: range.min * MIN_WEIGHT_MULT,
            max: range.max * MAX_WEIGHT_MULT,
            previousBest: result.isPersonalBest || !result.firstCatch ? (result.previousBest ?? 0) : 0,
            record,
        } : null,
        payout:    result.finalPayout ?? 0,
        xp:        result.xpEarned ?? 0,
        extraStat,
        badges,
        place:     `${location.name}`,
    };
}

function catchCardAlt(opts) {
    const size = opts.weight > 0 ? `${opts.sizeLabel ? `${opts.sizeLabel.toLowerCase()} ` : ''}${opts.weight} lb ` : '';
    const what = `${size}${opts.fish.name}`;
    const article = /^[aeiou]/i.test(what) ? 'an' : 'a';
    const extras = opts.badges.map(b => b.text.toLowerCase()).join(', ');
    return `${opts.angler} landed ${article} ${what}, ${opts.tierLabel}, at ${opts.place}, `
        + `for ${opts.payout} coins and ${opts.xp} XP.${extras ? ` ${extras}.` : ''}`;
}

async function renderCatchCard(input) {
    const opts = catchCardOptions(input);
    return renderAttachment(() => createCatchCard(opts), 'catch.png', catchCardAlt(opts));
}

module.exports = { renderCatchCard, catchCardOptions, catchCardAlt };
