'use strict';

// The staged reveal a rare-or-better drop gets before its result embed: fog,
// then a partial reveal at epic and above, then a fanfare at legendary.
//
// /hunt start, /fish cast and /mine dig each carried their own copy of this
// (#917). The three were the same forty lines three times over — the same tier
// thresholds, the same 1500 ms beats, the same embed shapes — differing only in
// the flavour text, so a change to the pacing or the tier ladder was a change
// in three places and drift between them was invisible. The copy is a table
// here, which is also the only way to see the three sets of lines side by side.

const { EmbedBuilder } = require('discord.js');
const { delay } = require('./delay');
const { TIER_NUM } = require('../data/materialRarity');

// Below this the drop is not worth staging: the caller's embed goes straight up.
const REVEAL_FROM_TIER = 3;   // rare
const STAGE_MS = 1500;

const FOG_COLOR = '#4a4a4a';
const EPIC_COLOR = '#9c27b0';
const LEGENDARY_COLOR = '#ff9800';
const EVENT_COLOR = '#e74c3c';

// One entry per grind. `mid` is keyed by tier number — 4 epic, 5 legendary,
// 6 event — and `fanfare` splits on whether the drop is an event-tier one.
const REVEAL_COPY = {
    hunt: {
        fogTitle: '🌫️ Something stirs in the shadows...',
        fogText:  '*The shadows shift. Something is here.*',
        mid: {
            4: '🔮 Something exceptional emerges...',
            5: '⚡ The air crackles with power...',
            6: '☄️ Every animal in the forest has gone silent...',
        },
        fanfare: {
            legendary: { title: '⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡', text: '*The air crackles. This is once in a lifetime.*' },
            event:     { title: '☄️ ⚡ 𝗠 𝗬 𝗧 𝗛 𝗜 𝗖 𝗔 𝗟 ⚡ ☄️', text: '*Nothing like this has been seen in living memory.*' },
        },
    },
    fish: {
        fogTitle: '🌫️ Something stirs beneath the surface...',
        fogText:  '*The water shimmers. Something extraordinary is here.*',
        mid: {
            4: '🔮 Something exceptional breaks the surface...',
            5: '⚡ The line pulls taut with impossible force...',
            6: '☄️ The water goes utterly still...',
        },
        fanfare: {
            legendary: { title: '⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡', text: '*The ocean holds its breath. This catch defies all odds.*' },
            event:     { title: '☄️ 🌊 𝗠 𝗬 𝗧 𝗛 𝗜 𝗖 𝗔 𝗟 🌊 ☄️', text: '*Sailors tell stories about this one. Now you are the story.*' },
        },
    },
    mine: {
        fogTitle: '🌫️ Your pickaxe strikes something unusual...',
        fogText:  '*The rock face glints in your lantern light.*',
        mid: {
            4: '🔮 A rare vein reveals itself...',
            5: '⚡ The tunnel fills with an impossible glow...',
            6: '☄️ The rock itself begins to hum...',
        },
        fanfare: {
            legendary: { title: '⚡ ✨ 𝗟 𝗘 𝗚 𝗘 𝗡 𝗗 𝗔 𝗥 𝗬 ✨ ⚡', text: '*Miners dream of this their whole careers.*' },
            event:     { title: '☄️ 🌋 𝗣 𝗥 𝗜 𝗠 𝗢 𝗥 𝗗 𝗜 𝗔 𝗟 🌋 ☄️', text: '*This ore has no business existing. Nobody will believe you.*' },
        },
    },
};

const RULE = '━━━━━━━━━━━━━━━';
const framed = text => `${RULE}\n${text}\n${RULE}`;

const MID_COLOR = { 4: EPIC_COLOR, 5: LEGENDARY_COLOR, 6: EVENT_COLOR };
const MID_LABEL = { 4: 'EPIC', 5: 'LEGENDARY', 6: 'EVENT' };

/**
 * Reveal a drop, then show the caller's embed.
 *
 * Every path ends by editing `finalEmbed` in, including the one that stages
 * nothing — so the caller hands over its result embed and does not render it
 * itself.
 *
 * @param {object} interaction already deferred or replied; this only edits.
 * @param {string|null} tier the drop's rarity name, or null for a miss.
 * @param {object} finalEmbed the result embed to land on.
 * @param {string} activity which grind's copy to use — a key of REVEAL_COPY.
 */
async function stagedLootReveal(interaction, tier, finalEmbed, activity) {
    const copy = REVEAL_COPY[activity];
    if (!copy) throw new Error(`stagedLootReveal: no reveal copy for "${activity}"`);

    const tierNum = TIER_NUM[tier] ?? 0;
    if (tierNum < REVEAL_FROM_TIER) {
        await interaction.editReply({ embeds: [finalEmbed] });
        return;
    }

    const fogEmbed = new EmbedBuilder()
        .setColor(FOG_COLOR)
        .setTitle(copy.fogTitle)
        .setDescription(framed(copy.fogText));

    await interaction.editReply({ embeds: [fogEmbed] });
    await delay(STAGE_MS);

    // Rare stops at the fog. Epic and above get the partial reveal, and
    // legendary and above the fanfare on top of it.
    if (tierNum > REVEAL_FROM_TIER) {
        const midEmbed = new EmbedBuilder()
            .setColor(MID_COLOR[tierNum])
            .setTitle(copy.mid[tierNum])
            .setDescription(framed(`❓❓❓  **${MID_LABEL[tierNum]}**  ❓❓❓`));
        await interaction.editReply({ embeds: [midEmbed] });
        await delay(STAGE_MS);

        if (tierNum >= 5) {
            const isEvent = tierNum === 6;
            const { title, text } = isEvent ? copy.fanfare.event : copy.fanfare.legendary;
            const fanfareEmbed = new EmbedBuilder()
                .setColor(isEvent ? EVENT_COLOR : LEGENDARY_COLOR)
                .setTitle(title)
                .setDescription(framed(text));
            await interaction.editReply({ embeds: [fanfareEmbed] });
            await delay(STAGE_MS);
        }
    }

    await interaction.editReply({ embeds: [finalEmbed] });
}

module.exports = { stagedLootReveal, REVEAL_COPY, REVEAL_FROM_TIER, STAGE_MS };
