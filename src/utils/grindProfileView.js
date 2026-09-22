'use strict';

/**
 * The text half of `/hunt profile`, `/fish profile` and `/explore profile`,
 * and the tab row that switches between their pages.
 *
 * The three profiles each grew their own long embed: a stamina bar and a count
 * and a "Full!" saying the same thing three ways, a balance that `/balance`
 * owns, an empty "Active Buffs: None", an unlocked-places list, and — on hunt —
 * a trophy wall that filled half the message. They now share one shape:
 *
 *   Overview     a short embed (rank, XP, place, stamina, record, today) with
 *                the profile card as its image
 *   Collection   the trophy cabinet / fish log / relic case, drawn as a grid
 *   Progress     prestige bonuses, permanent upgrades, synergies, places
 *
 * Every number the cards draw is in the embed text as well (#672): a failed
 * render, a screen reader or a channel search still gets them.
 *
 * @module utils/grindProfileView
 */

const {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ComponentType,
} = require('discord.js');
const { ownedBy } = require('./collectorOwner');

// How long the tab row stays live. Long enough to look around, short enough
// that a profile scrolled past an hour ago does not keep a collector open.
const TAB_WINDOW_MS = 180_000;

// ─── Level progress ──────────────────────────────────────────────────────────

/**
 * Where a player stands inside their current level.
 *
 * Every grind stores XP as a running total against a ladder of cumulative
 * thresholds (grindEngine.applyXp). The fish and explore profiles divided that
 * total by the *next* threshold, so a player one XP into level 24 read as 96%
 * of the way to 25. The bar measures the rung, not the climb.
 *
 * @param {{xpRequired: number}[]} levels the ladder, level N at index N-1
 * @param {number} level
 * @param {number} xp running total
 * @returns {{into: number, span: ?number, toNext: ?number, frac: number}}
 *   span and toNext are null at the top of the ladder
 */
function levelProgress(levels, level, xp) {
    const base = levels[level - 1]?.xpRequired ?? 0;
    const next = levels[level]?.xpRequired;
    if (next == null) return { into: Math.max(0, xp - base), span: null, toNext: null, frac: 1 };
    const span = Math.max(1, next - base);
    const into = Math.min(span, Math.max(0, xp - base));
    return { into, span, toNext: Math.max(0, next - xp), frac: into / span };
}

/** A fixed-width text bar, for the embed half of a meter the card draws. */
function textBar(frac, len = 12) {
    const filled = Math.min(len, Math.max(0, Math.round(frac * len)));
    return `${'█'.repeat(filled)}${'░'.repeat(len - filled)}`;
}

// ─── Compact lines ───────────────────────────────────────────────────────────

/** "`████████░░░░` 63% · 442 XP to Level 25", or the max-level line. */
function xpLine(progress, level) {
    if (progress.span == null) return `\`${textBar(1)}\` **Max level**`;
    return `\`${textBar(progress.frac)}\` ${Math.floor(progress.frac * 100)}% · `
        + `${progress.toNext.toLocaleString()} XP to Level ${level + 1}`;
}

/** "⚡ 10/10 stamina · full", or "⚡ 4/10 stamina · +1 in 3m 12s". */
function staminaLine(current, max, regenMs, formatMs) {
    const tail = current >= max ? 'full' : `+1 in ${formatMs(regenMs)}`;
    return `⚡ ${current}/${max} stamina · ${tail}`;
}

/**
 * The diminishing-returns band a daily action count is in, and the next one.
 * Hunt and fish share the ladder (×0.85, ×0.70, ×0.55 at three thresholds
 * their LIMITS set); explore has none, and passes no limits.
 */
const DIM_MULTIPLIERS = [0.85, 0.70, 0.55];
function dimBand(count, limits) {
    const thresholds = [limits?.DIM_RETURNS_THRESHOLD_1, limits?.DIM_RETURNS_THRESHOLD_2, limits?.DIM_RETURNS_THRESHOLD_3];
    if (thresholds.some(t => typeof t !== 'number')) return null;
    let multiplier = 1;
    let next = null;
    for (let i = 0; i < thresholds.length; i++) {
        if (count >= thresholds[i]) multiplier = DIM_MULTIPLIERS[i];
        else if (!next) next = { at: thresholds[i], multiplier: DIM_MULTIPLIERS[i] };
    }
    return { multiplier, next };
}

/**
 * The "📅 Today" field: the soft cap is the wall a player actually meets, so
 * the bar measures that, not the hard cap three times further off.
 *
 * @param {object} o
 * @param {number} o.coins         earned in the current window
 * @param {number} o.actions       hunts / casts / expeditions in the window
 * @param {string} o.noun          'hunts' / 'casts' / 'expeditions'
 * @param {object} o.limits        the activity's LIMITS (caps, dim thresholds)
 * @param {?number} o.resetMs      until the window rolls; null if none started
 * @param {string} o.currency
 * @param {(ms: number) => string} o.formatMs
 * @param {number} [o.softRate]    payout share past the soft cap (default ½)
 */
function buildTodayField({ coins = 0, actions = 0, noun, limits, resetMs, currency, formatMs, softRate = 0.5 }) {
    const soft = limits.DAILY_SOFT_CAP;
    const hard = limits.DAILY_HARD_CAP;
    const lines = [];

    if (coins >= hard) {
        lines.push(`\`${textBar(1)}\` ${currency}${coins.toLocaleString()} — **daily cap reached**`);
    } else if (coins >= soft) {
        lines.push(`\`${textBar(1)}\` ${currency}${coins.toLocaleString()} — past the soft cap, payouts at `
            + `${Math.round(softRate * 100)}% until ${currency}${hard.toLocaleString()}`);
    } else {
        lines.push(`\`${textBar(coins / soft)}\` ${currency}${coins.toLocaleString()} / ${currency}${soft.toLocaleString()} at full rate`);
    }

    const dim = dimBand(actions, limits);
    let actionLine = `🎯 ${actions.toLocaleString()} ${noun}`;
    if (dim) {
        actionLine += ` · payout ×${dim.multiplier.toFixed(2)}`;
        if (dim.next) actionLine += ` · ×${dim.next.multiplier.toFixed(2)} from ${dim.next.at} ${noun}`;
    }
    lines.push(actionLine);
    lines.push(resetMs == null ? '🕛 Window starts on your next one' : `🕛 Resets in ${formatMs(resetMs)}`);

    return { name: '📅 Today', value: lines.join('\n'), inline: false };
}

/**
 * Join items until the next one would push past `limit` (a Discord field is
 * 1024), then say how many were left out.
 */
function joinWithin(items, sep, limit = 1024) {
    const out = [];
    let used = 0;
    for (let i = 0; i < items.length; i++) {
        const tail = i === items.length - 1 ? '' : `${sep}+${items.length - i - 1} more`;
        const add = (out.length ? sep.length : 0) + items[i].length;
        if (used + add + tail.length > limit) return `${out.join(sep)}${sep}+${items.length - i} more`;
        out.push(items[i]);
        used += add;
    }
    return out.join(sep);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Run a card render, and hand back an attachment — or null if it failed, so
 * the embed goes out without its picture rather than not at all.
 */
async function renderAttachment(render, name, description) {
    try {
        const buffer = await render();
        return new AttachmentBuilder(buffer, { name, description: String(description).slice(0, 1024) });
    } catch (err) {
        console.error(`[grindProfile] ${name} render failed:`, err);
        return null;
    }
}

/**
 * A page's reply payload from its embed and optional card. The embed gets the
 * card as its image when there is one.
 */
function pagePayload(embed, attachment) {
    if (attachment) {
        embed.setImage(`attachment://${attachment.name}`);
        return { embeds: [embed], files: [attachment] };
    }
    return { embeds: [embed], files: [] };
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function tabRow(tabs, activeId, interactionId, disabled = false) {
    return new ActionRowBuilder().addComponents(tabs.map(t =>
        new ButtonBuilder()
            .setCustomId(`gptab_${t.id}_${interactionId}`)
            .setLabel(t.label)
            .setEmoji(t.emoji)
            .setStyle(t.id === activeId ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(disabled || t.id === activeId)));
}

/**
 * Reply with the first tab and a button row to switch between them. Each
 * tab's `build()` runs once, on first view, and is kept — a profile opened and
 * never paged costs one render, not three.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{id: string, label: string, emoji: string,
 *          build: () => Promise<{embeds: object[], files: object[]}>}[]} tabs
 */
async function sendProfileTabs(interaction, tabs) {
    const built = new Map();
    const view = async id => {
        if (!built.has(id)) built.set(id, await tabs.find(t => t.id === id).build());
        return built.get(id);
    };

    let active = tabs[0].id;
    const first = await view(active);
    if (tabs.length === 1) return interaction.reply(first);

    const message = await interaction.reply({
        ...first,
        components: [tabRow(tabs, active, interaction.id)],
        fetchReply: true,
    });

    const ids = new Set(tabs.map(t => `gptab_${t.id}_${interaction.id}`));
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: ownedBy(
            interaction.user.id,
            btn => ids.has(btn.customId),
            "This isn't your profile view — run the command yourself to flip through the tabs.",
        ),
        time: TAB_WINDOW_MS,
    });

    collector.on('collect', async btn => {
        active = btn.customId.slice('gptab_'.length, -(`_${interaction.id}`.length));
        const page = await view(active);
        // `attachments: []` drops the previous tab's card; `files` adds this one's.
        await btn.update({ ...page, attachments: [], components: [tabRow(tabs, active, interaction.id)] })
            .catch(() => {});
    });

    collector.on('end', () => {
        interaction.editReply({ components: [tabRow(tabs, active, interaction.id, true)] }).catch(() => {});
    });

    return message;
}

module.exports = {
    TAB_WINDOW_MS,
    buildTodayField,
    dimBand,
    joinWithin,
    levelProgress,
    pagePayload,
    renderAttachment,
    sendProfileTabs,
    staminaLine,
    textBar,
    xpLine,
};
