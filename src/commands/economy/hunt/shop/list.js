'use strict';

// `/hunt shop list` — the five browse pages.

const {
    WEAPON_TIERS,
    WEAPON_UPGRADES,
    AMMO_PACKS,
    CONSUMABLES,
    ZONE_LIST,
} = require('../../../../data/huntData');
const { runShopBrowse } = require('../../../../utils/shopBrowse');
const { isCrossEconomyWeapon, huntingDaysLabel } = require('./pricing');

async function showShopList(interaction, user, currency) {
    const h = user.hunt;

    const weaponItems = WEAPON_TIERS.map(w => ({
        imageId: `hunt:${w.slug}`,
        name:    w.name,
        price:   w.cost,
        emoji:   w.emoji,
        badge:   `T${w.tier}`,
        subline: `${Math.round(w.successRate * 100)}% • +${Math.round(w.rarityBoost * 100)}% rare`
            + (isCrossEconomyWeapon(w) ? ` • 🌐 ~${huntingDaysLabel(w.cost)}d of hunting` : '')
    }));
    const weaponLines = WEAPON_TIERS.map(w =>
        `${w.emoji} **${w.name}** — ${currency}${w.cost.toLocaleString()}`
        + (isCrossEconomyWeapon(w) ? ` 🌐` : '')
        + ` · \`/hunt shop weapon type:${w.slug}\``
    );
    // The legend goes in the embed description rather than the banner subtitle:
    // the banner is drawn with fillText on a canvas, which has no line breaks.
    if (WEAPON_TIERS.some(isCrossEconomyWeapon)) {
        weaponLines.push('', '🌐 *Costs more than hunting alone can fund — casino, work, crime and the rest all pay into the same wallet.*');
    }
    const weaponList = weaponLines.join('\n');

    const upgradeItems = Object.values(WEAPON_UPGRADES).map(u => ({
        imageId: `hunt:${u.id}`,
        name:    u.name,
        emoji:   u.emoji,
        subline: `~${Math.round(u.costMultiplier * 100)}% of weapon`
    }));
    const upgradeList = Object.values(WEAPON_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — *${u.description}* · \`/hunt shop upgrade module:${u.id}\``
    ).join('\n');

    const ammoItems = AMMO_PACKS.map(a => ({
        imageId: `hunt:${a.id}`,
        name:    a.name,
        price:   a.cost,
        emoji:   a.emoji
    }));
    const ammoList = AMMO_PACKS.map(a =>
        `${a.emoji} **${a.name}** — ${currency}${a.cost} · \`/hunt shop buy item:${a.id}\``
    ).join('\n');

    const consumableItems = Object.values(CONSUMABLES).map(c => ({
        imageId: `hunt:${c.id}`,
        name:    c.name,
        price:   c.cost,
        emoji:   c.emoji
    }));
    const consumableList = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/hunt shop buy item:${c.id}\``
    ).join('\n');

    const zoneItems = ZONE_LIST.map(z => {
        const unlocked = h.unlockedZones.includes(z.id);
        const isActive = h.activeZone === z.id;
        return {
            imageId: `hunt:${z.id}`,
            name:    z.name,
            emoji:   z.emoji,
            badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${z.unlockLevel}`),
            subline: unlocked ? (isActive ? 'Currently hunting' : 'Unlocked') : (z.unlockCost > 0 ? `${currency}${z.unlockCost.toLocaleString()}` : 'Free')
        };
    });
    const zoneList = ZONE_LIST.map(z => {
        const unlocked = h.unlockedZones.includes(z.id);
        const isActive = h.activeZone === z.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${z.unlockLevel}${z.unlockCost > 0 ? ` / ${currency}${z.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${z.emoji} **${z.name}** — ${status}`;
    }).join('\n');

    return runShopBrowse(interaction, {
        activity: 'hunt',
        title:    'Hunt Shop',
        currency,
        // Activity images are per guild since #561; without this the browse view
        // only ever finds the shared pre-#561 rows.
        guildId:  interaction.guild.id,
        footer:   'weapon • upgrade • buy • use • repair • unlock',
        pages: [
            { id: 'weapons',     label: 'Weapons',     emoji: '🔫',  subtitle: 'Pick your tier — better gear, better trophies.', items: weaponItems,     listText: weaponList     },
            { id: 'upgrades',    label: 'Upgrades',    emoji: '🔧',  subtitle: 'One module per weapon, permanent.',                items: upgradeItems,    listText: upgradeList    },
            { id: 'ammo',        label: 'Ammunition',  emoji: '🔶',  subtitle: 'Keep your rifle fed.',                              items: ammoItems,       listText: ammoList       },
            { id: 'consumables', label: 'Consumables', emoji: '🧪',  subtitle: 'Bait, charms, repairs and more.',                   items: consumableItems, listText: consumableList },
            { id: 'zones',       label: 'Zones',       emoji: '🗺️', subtitle: 'New regions, new prey.',                            items: zoneItems,       listText: zoneList       }
        ]
    });
}

module.exports = { showShopList };
