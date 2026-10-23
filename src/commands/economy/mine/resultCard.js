'use strict';

// The picture on a kept /mine dig: what came out of the rock, drawn by
// utils/grindResultCard — the same card /hunt start draws for a kill and
// /fish cast for a catch, so the grinds' results read as one family. It rides
// above the result text as an image-only embed, so the art leads and the text
// beneath stays the record — every number on the card is also in that text,
// and the file carries alt text for anyone who cannot see it.
//
// Like a kill, a strike is measured by what it paid: the gauge sets this dig's
// payout against the miner's previous best and the server record.

const { EmbedBuilder } = require('discord.js');
const { createGrindResultCard, TIER_COLOR } = require('../../../utils/grindResultCard');
const { renderAttachment } = require('../../../utils/grindProfileView');
const { TIER_NUM } = require('../../../data/materialRarity');
const { resultItemId } = require('../../../data/activityItems');
const { standing } = require('../../../utils/grindRecord');

const CARD_FILE = 'mine-result.png';

const TIER_TITLE = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', event: 'Primordial' };

/** The dig's chips for the card, from the same facts the embed's text uses. */
function cardChips({ result, chosenIntensity, pickedIntensity, isFeaturedDepth, featuredPct, rarePetDrop }) {
    const chips = [];
    if (chosenIntensity?.promoted && pickedIntensity) {
        chips.push({ text: `Seam lifted ${pickedIntensity.name} to ${chosenIntensity.name}`, tone: 'gold' });
    }
    if (isFeaturedDepth) chips.push({ text: `Featured depth +${featuredPct}%`, tone: 'gold' });
    if (result.specialDrop) chips.push({ text: `Found: ${result.specialDrop.name}`, tone: 'gold' });
    if (rarePetDrop) chips.push({ text: `Companion: ${rarePetDrop.name}`, tone: 'gold' });
    if (result.pickaxeBroke) chips.push({ text: 'Pickaxe broke', tone: 'bad' });
    return chips;
}

/** A cave-in the miner got out of, as the banner under the badges. */
function caveInBanner(result) {
    if (!result.caveIn || result.caveInAbandoned) return null;
    // Digging out also counts as escaping, so it is asked about first.
    if (result.caveInDugOut) {
        return {
            label: 'CAVE-IN', outcome: 'survived',
            title: `Dug out by hand for ${result.caveInStaminaSpent ?? 0} stamina`,
            detail: result.caveInEscrowLost > 0 ? 'bonus buried' : 'ore saved',
        };
    }
    if (result.caveInEscaped) {
        const charges = result.caveInChargesSpent ?? 1;
        return {
            label: 'CAVE-IN', outcome: 'win',
            title: `Blasted clear with ${charges} charge${charges === 1 ? '' : 's'}`,
            detail: 'haul kept',
        };
    }
    return null;
}

/**
 * `records` is { priorBest, othersBest }: the miner's best payout before this
 * dig, and everyone else's (null when that read failed).
 */
function cardOptions({ result, depth, intensity = null, chips = [], username = 'Miner', records = {} }) {
    const { ore, tier } = result;
    const capped = !!result.cappedByHard;
    const payout = result.finalPayout ?? 0;

    let extraStat = null;
    if (result.isCrit)                      extraStat = { label: 'CRITICAL', value: `×${Number(result.critMultiplier).toFixed(2)}` };
    else if ((result.streakMult ?? 1) > 1)  extraStat = { label: 'MULTIPLIER', value: `×${Number(result.streakMult).toFixed(2)}` };
    else if (result.levelUp)                extraStat = { label: 'LEVEL UP', value: `${result.levelUp.oldLevel} → ${result.levelUp.newLevel}` };

    const subtitle = intensity
        ? `${TIER_TITLE[tier] ?? 'Common'} ore · ${intensity.name} dig ×${intensity.multiplier}`
        : `${TIER_TITLE[tier] ?? 'Common'} ore`;

    const where = standing(capped ? 0 : payout, records);
    const badges = [];
    if (where.serverRecord) badges.push({ text: 'SERVER RECORD', tone: 'gold' });
    if (where.personalBest) badges.push({ text: 'PERSONAL BEST', tone: 'good' });
    if (result.isCrit)      badges.push({ text: 'CRITICAL', tone: 'crit' });
    if (result.levelUp && extraStat?.label !== 'LEVEL UP') {
        badges.push({ text: `LEVEL ${result.levelUp.oldLevel} → ${result.levelUp.newLevel}`, tone: 'level' });
    }
    badges.push(...chips);

    return {
        activity: 'mine',
        kicker: `${username} struck`,
        subject: { name: ore.name, iconId: resultItemId('mine', ore.id) },
        tierNum: TIER_NUM[tier] ?? 1,
        subtitle,
        place: { name: depth.name, iconId: `mine:${depth.id}` },
        payout: capped ? 0 : payout,
        forfeited: capped ? (result.forfeited ?? 0) : null,
        xp: result.xpEarned ?? 0,
        extraStat,
        gauge: { best: where.best, record: where.record ?? 0 },
        badges,
        apex: caveInBanner(result),
    };
}

/** What a screen reader says for the card: the same facts, in a sentence. */
function altText(opts) {
    const tier = ['', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'primordial'][opts.tierNum];
    const parts = [
        `${opts.kicker.replace(/ struck$/, '')} struck ${/^[aeiou]/i.test(tier) ? 'an' : 'a'} ${tier} ${opts.subject.name} in ${opts.place.name} (${opts.subtitle}).`,
        opts.forfeited != null
            ? `No coins — the daily cap withheld ${opts.forfeited.toLocaleString('en-US')}.`
            : `${opts.payout.toLocaleString('en-US')} coins and ${opts.xp} XP.`,
    ];
    if (opts.extraStat) parts.push(`${opts.extraStat.label.toLowerCase()} ${opts.extraStat.value}.`);
    if (opts.badges.length) parts.push(`${opts.badges.map(c => c.text).join(', ')}.`);
    if (opts.apex) parts.push(`Cave-in: ${opts.apex.title}, ${opts.apex.detail}.`);
    return parts.join(' ');
}

/**
 * Renders the card for a dig whose ore came up. Returns { embed, file } — the
 * image-only embed to lead the message and its attachment — or null for a
 * failed swing, a haul abandoned in a cave-in, or a render that fails, in which
 * case the result goes out as text with the ore's thumbnail, as before.
 */
async function renderMineResultCard(args) {
    const { result } = args;
    if (!result?.success || !result.ore || result.caveInAbandoned) return null;
    const opts = cardOptions(args);
    const file = await renderAttachment(() => createGrindResultCard(opts), CARD_FILE, altText(opts));
    if (!file) return null;
    const embed = new EmbedBuilder()
        .setColor(TIER_COLOR[opts.tierNum])
        .setImage(`attachment://${CARD_FILE}`);
    return { embed, file };
}

module.exports = { CARD_FILE, altText, caveInBanner, cardChips, cardOptions, renderMineResultCard };
