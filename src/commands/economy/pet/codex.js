'use strict';

// /pet codex (#1187) — every species the game has, in colour once the player
// has owned one and as a grey ghost until then, with the rare companions'
// hints beside them. /pet list only shows the shop, so the four pets nobody
// can buy were one footer line; a rare pet is only worth chasing if players
// can see it exists.

const { EmbedBuilder } = require('discord.js');
const {
    PET_DEFINITIONS,
    codexSpecies,
    rarePetHint,
    formatPetBonus,
} = require('../../../services/petService');
const { petItemId } = require('../../../data/activityItems');
const { createGrindCollectionCard } = require('../../../utils/grindProfileCard');
const { renderAttachment, pagePayload } = require('../../../utils/grindProfileView');
const COLORS = require('../../../utils/embedColors');
const { resolveUser } = require('./shared');

const SHOP_COLOR = '#5dade2';
const RARE_COLOR = '#f5b041';

/** The codex as data: `{ shop, rare, owned, total }`, each species with `owned`. Pure. */
function codexEntries(user) {
    const seen = codexSpecies(user);
    const all  = Object.values(PET_DEFINITIONS).map(def => ({ def, owned: seen.has(def.petId) }));
    return {
        shop:  all.filter(e => e.def.purchasable),
        rare:  all.filter(e => !e.def.purchasable),
        owned: all.filter(e => e.owned).length,
        total: all.length,
    };
}

/** One embed line for a species: owned ones in full, the rest as "???" for rare pets. */
function codexLine({ def, owned }) {
    const bonus = formatPetBonus(def.bonusType, def.bonusPct);
    if (def.purchasable) {
        return `${owned ? def.emoji : '▫️'} **${def.name}** — ${bonus} · ${def.cost.toLocaleString()} coins${owned ? '' : ' · *not yet owned*'}`;
    }
    return owned
        ? `${def.emoji} **${def.name}** — ${bonus} · ${rarePetHint(def)}`
        : `❔ **${def.name}** — *${rarePetHint(def)}*`;
}

async function executeCodex(interaction) {
    const user = await resolveUser(interaction);
    const { shop, rare, owned, total } = codexEntries(user);
    const name = interaction.member?.displayName ?? interaction.user.username;

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(`📖 ${name}'s Pet Codex`)
        .setDescription(`**${owned} of ${total}** species owned.`)
        .addFields(
            { name: '🛒 From the shop (/pet adopt)', value: shop.map(codexLine).join('\n'), inline: false },
            { name: '✨ Rare companions', value: rare.map(codexLine).join('\n'), inline: false },
        )
        .setFooter({ text: 'Rare companions are never sold — they only turn up alongside a legendary find, and never while you already have one.' });

    const entry = color => ({ def, owned: got }) => ({ iconId: petItemId(def.petId), name: def.name, owned: got, color });
    const card = await renderAttachment(() => createGrindCollectionCard({
        activity: 'pets',
        title:    `${name}'s Pet Codex`,
        subtitle: `${owned} of ${total} species`,
        sections: [
            { label: 'Shop',  color: SHOP_COLOR, entries: shop.map(entry(SHOP_COLOR)) },
            { label: 'Rare',  color: RARE_COLOR, entries: rare.map(entry(RARE_COLOR)) },
        ],
    }), 'pet-codex.png',
        `Pet codex for ${name}: ${owned} of ${total} species owned. `
        + `Owned: ${[...shop, ...rare].filter(e => e.owned).map(e => e.def.name).join(', ') || 'none'}.`);

    return interaction.reply(pagePayload(embed, card));
}

module.exports = { executeCodex, codexEntries, codexLine };
