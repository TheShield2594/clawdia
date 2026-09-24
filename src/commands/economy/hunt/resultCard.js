'use strict';

// The picture on a successful /hunt start: what the kill looks like, drawn by
// utils/grindResultCard. It rides above the result text as an image-only
// embed, so the art leads and the text beneath stays the record — every
// number on the card is also in that text, and the file carries alt text for
// anyone who cannot see it.

const { EmbedBuilder } = require('discord.js');
const { createGrindResultCard, TIER_COLOR } = require('../../../utils/grindResultCard');
const { renderAttachment } = require('../../../utils/grindProfileView');
const { TIER_NUM } = require('../../../data/materialRarity');

const CARD_FILE = 'hunt-result.png';

const GRADE_COLORS = { mythic: '#9b59b6', pristine: '#3498db', good: '#2ecc71' };

// How each part of the run reads on the card. The embed's run line says the
// same things with emoji; the canvas cannot draw those, so it has its own words.
const STEALTH_CHIPS = {
    perfect: { text: 'Perfect approach', tone: 'good' },
    decent:  { text: 'Decent approach',  tone: 'info' },
    spooked: { text: 'Spooked it',       tone: 'bad' },
    timeout: { text: 'Hesitated',        tone: 'bad' },
};
const AIM_CHIPS = {
    perfect: { text: 'Perfect shot', tone: 'good' },
    late:    { text: 'Clean shot',   tone: 'info' },
    early:   { text: 'Rushed shot',  tone: 'bad' },
    timeout: { text: 'Never fired',  tone: 'bad' },
};

/** The run's chips for the card, from the same facts the embed's run line uses. */
function cardChips({ result, stealth, aim, quick, flushed, isFeaturedZone, featuredPct, rarePetDrop }) {
    const chips = [];
    if (STEALTH_CHIPS[stealth?.outcome]) chips.push(STEALTH_CHIPS[stealth.outcome]);
    if (flushed) chips.push({ text: 'Flushed out bigger prey', tone: 'gold' });
    if (aim && AIM_CHIPS[aim.grade]) chips.push(AIM_CHIPS[aim.grade]);
    else if (!quick && (result.animal?.traits ?? []).includes('armored')) chips.push({ text: 'Armored: no crit to aim for', tone: 'info' });
    if (quick) chips.push({ text: 'Quick hunt', tone: 'info' });
    if (isFeaturedZone) chips.push({ text: `Featured zone +${featuredPct}%`, tone: 'gold' });
    if (result.specialDrop) chips.push({ text: `Found: ${result.specialDrop.name}`, tone: 'gold' });
    if (rarePetDrop) chips.push({ text: `Companion: ${rarePetDrop.name}`, tone: 'gold' });
    if (result.weaponBroke) chips.push({ text: 'Weapon broke', tone: 'bad' });
    return chips;
}

function cardOptions({ result, zone, chips, apex = null }) {
    const quality = result.trophyQuality;
    const multipliers = [];
    if ((result.streakMult ?? 1) > 1) multipliers.push({ label: 'streak', value: result.streakMult });
    if (result.isCrit) multipliers.push({ label: 'crit', value: result.critMultiplier });
    if (quality && quality.multiplier > 1) multipliers.push({ label: 'trophy', value: quality.multiplier });

    return {
        activity: 'hunt',
        subject: { name: result.animal.name, iconId: `animal:${result.animal.id}` },
        tierNum: TIER_NUM[result.tier] ?? 1,
        place: { name: zone.name, iconId: `hunt:${zone.id}` },
        payout: result.finalPayout ?? 0,
        forfeited: result.cappedByHard ? (result.forfeitedPayout ?? 0) : null,
        xp: result.xpEarned ?? 0,
        levelUp: result.levelUp ? { from: result.levelUp.oldLevel, to: result.levelUp.newLevel } : null,
        crit: !!result.isCrit,
        grade: quality && GRADE_COLORS[quality.id] ? { label: quality.label, color: GRADE_COLORS[quality.id] } : null,
        multipliers,
        chips,
        apex,
    };
}

/** What a screen reader says for the card: the same facts, in a sentence. */
function altText(opts) {
    const parts = [
        `Hunt result: ${opts.crit ? 'critical ' : ''}${opts.grade ? `${opts.grade.label} ` : ''}${opts.subject.name}`,
        `a ${['', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'][opts.tierNum]} kill in ${opts.place.name}.`,
        opts.forfeited != null && !(opts.payout > 0)
            ? `No coins — the daily cap withheld ${opts.forfeited.toLocaleString('en-US')}.`
            : `${opts.payout.toLocaleString('en-US')} coins and ${opts.xp} XP.`,
    ];
    if (opts.levelUp) parts.push(`Level up to ${opts.levelUp.to}.`);
    if (opts.chips.length) parts.push(`${opts.chips.map(c => c.text).join(', ')}.`);
    if (opts.apex) parts.push(`Apex duel: ${opts.apex.title}${opts.apex.payout > 0 ? `, ${opts.apex.payout.toLocaleString('en-US')} bonus coins` : ''}.`);
    return parts.join(' ');
}

/**
 * Renders the card for a successful hunt. Returns { embed, file } — the
 * image-only embed to lead the message and its attachment — or null when the
 * render fails, in which case the result goes out as text alone, as before.
 */
async function renderHuntResultCard(args) {
    if (!args.result?.success || !args.result.animal) return null;
    const opts = cardOptions(args);
    const file = await renderAttachment(() => createGrindResultCard(opts), CARD_FILE, altText(opts));
    if (!file) return null;
    const embed = new EmbedBuilder()
        .setColor(TIER_COLOR[opts.tierNum])
        .setImage(`attachment://${CARD_FILE}`);
    return { embed, file };
}

module.exports = { CARD_FILE, altText, cardChips, cardOptions, renderHuntResultCard };
