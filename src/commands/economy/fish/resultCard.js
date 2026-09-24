'use strict';

// The picture on a landed /fish cast: what the catch looks like, drawn by
// utils/grindResultCard — the same card /hunt start draws for a kill, so the
// two grinds' results read as one family. It rides above the result text as an
// image-only embed, so the art leads and the text beneath stays the record —
// every number on the card is also in that text, and the file carries alt
// text for anyone who cannot see it.
//
// Where a kill is measured by what it paid, a fish is measured by its weight:
// the gauge sets this catch against the species' whole range, with the
// angler's previous best of that species and the server record marked on it.

const { EmbedBuilder } = require('discord.js');
const { createGrindResultCard, TIER_COLOR } = require('../../../utils/grindResultCard');
const { renderAttachment } = require('../../../utils/grindProfileView');
const { TIER_NUM } = require('../../../data/materialRarity');
const { FISH_WEIGHTS, FISH_BASE_WEIGHTS, SIZE_TIERS } = require('../../../data/fishData');

const CARD_FILE = 'fish-result.png';

const MAX_WEIGHT_MULT = Math.max(...SIZE_TIERS.map(t => t.weightMult));

const TIER_TITLE = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', event: 'Mythical' };

// How the fight reads on the card. The embed says the same with emoji; the
// canvas cannot draw those, so it has its own words.
const REEL_CHIPS = {
    '🎯': { text: 'Perfect read', tone: 'good' },
    '🏆': { text: 'Won the fight', tone: 'good' },
    '😬': { text: 'The rare one slipped', tone: 'bad' },
};

/** The run's chips for the card, from the same facts the embed's text uses. */
function cardChips({ result, reelResult, isFeaturedSpot, featuredPct, rarePetDrop, winterMaterialName }) {
    const chips = [];
    if (reelResult && REEL_CHIPS[reelResult.icon]) chips.push(REEL_CHIPS[reelResult.icon]);
    if (result.karmaUsed) chips.push({ text: 'River karma', tone: 'info' });
    if (isFeaturedSpot) chips.push({ text: `Featured spot +${featuredPct}%`, tone: 'gold' });
    if (result.specialDrop) chips.push({ text: `Found: ${result.specialDrop.name}`, tone: 'gold' });
    if (winterMaterialName) chips.push({ text: `Found: ${winterMaterialName}`, tone: 'info' });
    if (rarePetDrop) chips.push({ text: `Companion: ${rarePetDrop.name}`, tone: 'gold' });
    if (result.rodBroke) chips.push({ text: 'Rod broke', tone: 'bad' });
    return chips;
}

/**
 * `worldRecord` is what cast.checkAndUpdateWorldRecord returned: whether this
 * catch set the server record, the one it beat, or the one it fell short of.
 */
function cardOptions({ result, location, worldRecord = null, chips = [], username = 'Angler', apex = null }) {
    const { fish, tier } = result;
    const capped = !!result.cappedByHard;
    const weight = result.weightLbs ?? 0;

    let extraStat = null;
    if (result.isCrit)                      extraStat = { label: 'CRITICAL', value: `×${Number(result.critMultiplier).toFixed(2)}` };
    else if ((result.streakMult ?? 1) > 1)  extraStat = { label: 'MULTIPLIER', value: `×${Number(result.streakMult).toFixed(2)}` };
    else if (result.levelUp)                extraStat = { label: 'LEVEL UP', value: `${result.levelUp.oldLevel} → ${result.levelUp.newLevel}` };

    const subtitle = weight > 0
        ? `${result.sizeLabel ? `${result.sizeLabel} · ` : ''}${weight.toLocaleString('en-US')} lbs`
        : `${TIER_TITLE[tier] ?? 'Clean'} catch`;

    // The standing record: the one this catch beat, or the one it fell short
    // of. A record the catch set is the catch itself, so the tick marks the old.
    const record = worldRecord?.set
        ? (worldRecord.previous?.weight ?? 0)
        : (worldRecord?.record?.weight ?? 0);
    const range = FISH_WEIGHTS[fish.id] ?? FISH_BASE_WEIGHTS[fish.tier];

    const badges = [];
    if (worldRecord?.set)      badges.push({ text: 'SERVER RECORD', tone: 'gold' });
    if (result.isPersonalBest) badges.push({ text: 'PERSONAL BEST', tone: 'good' });
    if (result.firstCatch)     badges.push({ text: 'NEW SPECIES', tone: 'info' });
    if (result.isCrit)         badges.push({ text: 'CRITICAL', tone: 'crit' });
    if (result.levelUp && extraStat?.label !== 'LEVEL UP') {
        badges.push({ text: `LEVEL ${result.levelUp.oldLevel} → ${result.levelUp.newLevel}`, tone: 'level' });
    }
    badges.push(...chips);

    return {
        activity: 'fish',
        kicker: `${username} landed`,
        subject: { name: fish.name, iconId: `fishcatch:${fish.id}` },
        tierNum: TIER_NUM[tier] ?? 1,
        subtitle,
        place: { name: location.name, iconId: `fish:${location.id}` },
        payout: capped ? 0 : (result.finalPayout ?? 0),
        forfeited: capped ? (result.uncappedPayout ?? 0) : null,
        xp: result.xpEarned ?? 0,
        extraStat,
        gauge: weight > 0 && range ? {
            value: weight,
            unit: 'lbs',
            max: Math.max(range.max * MAX_WEIGHT_MULT, weight, record) * 1.02,
            best: result.previousBest ?? 0,
            record,
        } : null,
        badges,
        apex,
    };
}

/** What a screen reader says for the card: the same facts, in a sentence. */
function altText(opts) {
    const tier = ['', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'][opts.tierNum];
    const parts = [
        `${opts.kicker.replace(/ landed$/, '')} landed ${/^[aeiou]/i.test(tier) ? 'an' : 'a'} ${tier} ${opts.subject.name} at ${opts.place.name} (${opts.subtitle}).`,
        opts.forfeited != null
            ? `No coins — the daily cap withheld ${opts.forfeited.toLocaleString('en-US')}.`
            : `${opts.payout.toLocaleString('en-US')} coins and ${opts.xp} XP.`,
    ];
    if (opts.extraStat) parts.push(`${opts.extraStat.label.toLowerCase()} ${opts.extraStat.value}.`);
    if (opts.badges.length) parts.push(`${opts.badges.map(c => c.text).join(', ')}.`);
    if (opts.apex) parts.push(`Boss fight: ${opts.apex.title}${opts.apex.payout > 0 ? `, ${opts.apex.payout.toLocaleString('en-US')} bonus coins` : ''}.`);
    return parts.join(' ');
}

/**
 * Renders the card for a landed fish. Returns { embed, file } — the image-only
 * embed to lead the message and its attachment — or null when there is no fish
 * or the render fails, in which case the result goes out as text alone.
 */
async function renderFishResultCard(args) {
    if (!args.result?.success || args.result.catchType !== 'fish' || !args.result.fish) return null;
    const opts = cardOptions(args);
    const file = await renderAttachment(() => createGrindResultCard(opts), CARD_FILE, altText(opts));
    if (!file) return null;
    const embed = new EmbedBuilder()
        .setColor(TIER_COLOR[opts.tierNum])
        .setImage(`attachment://${CARD_FILE}`);
    return { embed, file };
}

module.exports = { CARD_FILE, altText, cardChips, cardOptions, renderFishResultCard };
