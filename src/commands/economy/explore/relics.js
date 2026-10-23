'use strict';

// /explore relics — the relic case: everything the wilds let the player keep,
// grouped by rarity, and what the collection earns them.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const {
    LIMITS, REGIONS, RELIC_LIST, RELIC_RARITY_ORDER, TOTAL_CORE_RELICS, relicSlug,
} = require('../../../data/exploreData');
const {
    getRelicCollection, getRelicBonus, getRelicBonusCap, getRelicCapacity,
} = require('../../../services/exploreService');
const { relicItemId } = require('../../../data/activityItems');
const { attachItemThumbnail } = require('../../../utils/itemImageHelper');
const { fitDescription, EMBED_LIMITS } = require('../../../utils/embedFields');
const { loadReadContext, EXPLORE_COLORS } = require('./shared');

async function handleRelics(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const ctx = await loadReadContext(interaction, target);
    if (!ctx) return;
    const { user: userData, currency } = ctx;

    const collection = userData ? getRelicCollection(userData) : [];
    if (!collection.length) {
        return interaction.reply({
            content: isSelf
                ? 'Your relic case is a shelf and a hopeful expression. Rare treasure carries relics out of the wilds — `/explore go` is the only supplier.'
                : `${target.username} hasn't brought anything home worth a shelf yet.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // Grouped by rarity, rarest first — the case should read like a case. Any
    // rarity not in the ladder still gets a group rather than silently vanishing
    // from a case whose totals already count it.
    const knownRarities = [...RELIC_RARITY_ORDER].reverse();
    const extraRarities = [...new Set(collection.map(r => r.rarity))].filter(r => !knownRarities.includes(r));

    const renderGroups = withLore => [...knownRarities, ...extraRarities].map(rarity => {
        const held = collection.filter(r => r.rarity === rarity);
        if (!held.length) return null;
        const rows = held.map(r => {
            const head = `${r.emoji} **${r.itemId}**${r.quantity > 1 ? ` ×${r.quantity}` : ''} — *${r.regionName}* · ${currency}${r.value.toLocaleString()}`;
            return withLore ? `${head}\n> *${r.lore}*` : head;
        });
        return `**${rarity.charAt(0).toUpperCase() + rarity.slice(1)}**\n${rows.join('\n')}`;
    }).filter(Boolean);

    // A full 25-relic case with lore runs past the 4096-char description limit,
    // and discord.js throws rather than truncating. Drop the lore before dropping
    // relics — the case is a list first and a story second.
    const budget = EMBED_LIMITS.DESCRIPTION - 120; // headroom for the omission note
    let groups = renderGroups(true);
    let loreDropped = false;
    if (groups.join('\n\n').length > budget) {
        groups = renderGroups(false);
        loreDropped = true;
    }
    const { text: caseText, omitted } = fitDescription(groups, { limit: budget, separator: '\n\n' });
    const caseNote = [
        loreDropped ? '*The case has outgrown its little plaques — names only from here.*' : '',
        omitted > 0 ? `*…and ${omitted} more group${omitted === 1 ? '' : 's'} that wouldn't fit.*` : '',
    ].filter(Boolean).join('\n');

    const distinct = collection.length;
    const missingField = buildMissingRelicsField(collection, isSelf, target.username);
    const bonus    = getRelicBonus(userData);
    const bonusCap = getRelicBonusCap(userData);
    const capacity = getRelicCapacity(userData);
    const atCap    = bonus >= bonusCap;
    const caseValue = collection.reduce((sum, r) => sum + r.value * r.quantity, 0);

    const embed = new EmbedBuilder()
        .setColor(EXPLORE_COLORS.RELIC)
        .setTitle(`🏺 The Relic Case — ${target.username}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setDescription(caseNote ? `${caseText}\n\n${caseNote}` : caseText)
        .addFields(
            {
                name: '📚 The Collection',
                value: `**${distinct}** distinct of **${RELIC_LIST.length}** known *(${TOTAL_CORE_RELICS} from the core regions, the rest only turn up in season)*\n`
                     + `Trade value: **${currency}${caseValue.toLocaleString()}** *(what the set tends to fetch on the \`/market\`)*`,
                inline: false,
            },
            ...(missingField ? [missingField] : []),
            {
                name: '📈 What It Earns You',
                value: `**+${Math.round(bonus * 100)}%** on every coin exploration pays you`
                     + (atCap
                         ? (capacity >= RELIC_LIST.length
                             ? ' — *every relic there is, and the case counts all of them.*'
                             : `\n*The case holds **${capacity}** of ${RELIC_LIST.length} at this rank — \`/explore prestige\` widens it.*`)
                         : `\n*+${Math.round(LIMITS.RELIC_BONUS_PER * 100)}% per distinct relic, up to +${Math.round(bonusCap * 100)}% (**${capacity}** relics at your rank). Duplicates are for trading, not for stacking.*`),
                inline: false,
            },
        )
        .setFooter({ text: 'No shop buys relics — nothing out there is qualified. Their worth is what another player will pay on the /market.' })
        .setTimestamp();

    // The case wears its crown jewel — the rarest relic held — with the avatar
    // above as the pre-bake fallback: attachItemThumbnail overrides the thumbnail
    // only when the art exists, so nothing changes until the icons are baked.
    const rarestFirst = [...RELIC_RARITY_ORDER].reverse();
    const spotlight = [...collection].sort(
        (a, b) => rarestFirst.indexOf(a.rarity) - rarestFirst.indexOf(b.rarity)
    )[0];
    const files = spotlight
        ? await attachItemThumbnail(embed, relicItemId(relicSlug(spotlight.itemId)), interaction.guild.id, spotlight.itemId)
        : [];

    return interaction.reply({ embeds: [embed], files });
}

/**
 * What the case is still missing. Rare treasure deliberately prefers relics the
 * player doesn't own yet, so "12 of 25" without naming the other 13 hides the
 * one number the drop table is actually built around. Returns null once there is
 * nothing left to want.
 *
 * Seasonal relics are listed apart from core ones: they only drop while their
 * event runs, so a checklist that mixed them in would read as thirteen things
 * you could go get today, and some of them are months away.
 */
function buildMissingRelicsField(collection, isSelf, username) {
    const owned = new Set(collection.map(r => r.itemId));
    const missing = RELIC_LIST.filter(r => !owned.has(r.itemId));
    if (!missing.length) {
        return {
            name: '🔍 Still Out There',
            value: isSelf
                ? '**Nothing.** Every relic the wilds have ever let go of is on that shelf. Including the ones that were statues when you picked them up.'
                : `**Nothing.** ${username} has the complete set.`,
            inline: false,
        };
    }

    const core     = missing.filter(r => !REGIONS[r.regionId].seasonalEventId);
    const seasonal = missing.filter(r =>  REGIONS[r.regionId].seasonalEventId);

    // A field value caps at 1024 characters and discord.js throws rather than
    // truncating, so the list gets trimmed to fit with a count of what it dropped.
    const BUDGET = 900;
    const render = list => list.map(r => `${REGIONS[r.regionId].emoji} ${r.itemId}`);
    const { text, omitted } = fitDescription(render(core), { limit: BUDGET, separator: ' · ' });

    const lines = [];
    if (core.length) {
        lines.push(text);
        if (omitted > 0) lines.push(`*…and ${omitted} more out in the core regions.*`);
    }
    if (seasonal.length) {
        lines.push(`*Plus ${seasonal.length} that only turn up while their season is running.*`);
    }

    return { name: `🔍 Still Out There — ${missing.length}`, value: lines.join('\n'), inline: false };
}

module.exports = {
    buildMissingRelicsField,
    handleRelics,
};
