'use strict';

// `/mine shop list` — the five browse pages.

const {
    PICKAXE_TIERS,
    PICKAXE_UPGRADES,
    BLAST_PACKS,
    CONSUMABLES,
    DEPTH_LIST,
} = require('../../../../data/mineData');
const { runShopBrowse } = require('../../../../utils/shopBrowse');

async function showShopList(interaction, user, currency) {
    const m = user.mining;

    const pickaxeItems = PICKAXE_TIERS.map(p => ({
        imageId: `mine:${p.slug}`,
        name:    p.name,
        price:   p.cost,
        emoji:   p.emoji,
        badge:   `T${p.tier}`,
        subline: `${Math.round(p.successRate * 100)}% • +${Math.round(p.rarityBoost * 100)}% rare`
    }));
    const pickaxeList = PICKAXE_TIERS.map(p =>
        `${p.emoji} **${p.name}** — ${currency}${p.cost.toLocaleString()} · \`/mine shop pickaxe type:${p.slug}\``
    ).join('\n');

    const upgradeItems = Object.values(PICKAXE_UPGRADES).map(u => ({
        imageId: `mine:${u.id}`,
        name:    u.name,
        emoji:   u.emoji,
        subline: `${Math.round(u.costMultiplier * 100)}% of pickaxe`
    }));
    const upgradeList = Object.values(PICKAXE_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — *${u.description}* · \`/mine shop upgrade module:${u.id}\``
    ).join('\n');

    const blastItems = BLAST_PACKS.map(b => ({
        imageId: `mine:${b.id}`,
        name:    b.name,
        price:   b.cost,
        emoji:   b.emoji
    }));
    const blastList = BLAST_PACKS.map(b =>
        `${b.emoji} **${b.name}** — ${currency}${b.cost} · \`/mine shop buy item:${b.id}\``
    ).join('\n');

    const consumableItems = Object.values(CONSUMABLES).map(c => ({
        imageId: `mine:${c.id}`,
        name:    c.name,
        price:   c.cost,
        emoji:   c.emoji
    }));
    const consumableList = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/mine shop buy item:${c.id}\``
    ).join('\n');

    const depthItems = DEPTH_LIST.map(d => {
        const unlocked = m.unlockedDepths?.includes(d.id) ?? d.defaultUnlocked;
        const isActive = m.activeDepth === d.id;
        return {
            imageId: `mine:${d.id}`,
            name:    d.name,
            emoji:   d.emoji,
            badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${d.unlockLevel}`),
            subline: unlocked ? (isActive ? 'Currently mining' : 'Unlocked') : `${currency}${d.unlockCost.toLocaleString()}`
        };
    });
    const depthList = DEPTH_LIST.map(d => {
        const unlocked = m.unlockedDepths?.includes(d.id) ?? d.defaultUnlocked;
        const isActive = m.activeDepth === d.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${d.unlockLevel} / ${currency}${d.unlockCost.toLocaleString()}`;
        return `${d.emoji} **${d.name}** — ${status}`;
    }).join('\n');

    return runShopBrowse(interaction, {
        activity: 'mine',
        title:    'Mining Shop',
        currency,
        // Activity images are per guild since #561; without this the browse
        // view only ever finds the shared pre-#561 rows.
        guildId:  interaction.guild.id,
        footer:   'pickaxe • upgrade • buy • use • repair • unlock',
        pages: [
            { id: 'pickaxes',    label: 'Pickaxes',    emoji: '🪓',  subtitle: 'Stronger picks bite deeper veins.',     items: pickaxeItems,    listText: pickaxeList    },
            { id: 'upgrades',    label: 'Upgrades',    emoji: '🔩',  subtitle: 'One module per pickaxe, permanent.',     items: upgradeItems,    listText: upgradeList    },
            { id: 'blasts',      label: 'Blast Charges', emoji: '💥', subtitle: 'Crack through stubborn rock.',          items: blastItems,      listText: blastList      },
            { id: 'consumables', label: 'Consumables', emoji: '🎒',  subtitle: 'Repairs, charms and quick boosts.',      items: consumableItems, listText: consumableList },
            { id: 'depths',      label: 'Depths',      emoji: '🗺️', subtitle: 'New depths, new ores.',                  items: depthItems,      listText: depthList      }
        ]
    });
}

module.exports = { showShopList };
