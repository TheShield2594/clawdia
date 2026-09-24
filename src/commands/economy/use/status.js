'use strict';

// What `/use` would do with an item, answered without touching anything: the
// dropdown and `execute` both ask here, so the picker never offers something
// the command then refuses for a reason it could have shown.

const {
    EFFECT_CONFIGS,
    resolveEffectType,
    timeRemaining,
    isActiveEffect,
} = require('../../../services/effectsService');
const { DEFAULT_SHOP_ITEMS } = require('../../../data/defaultShopItems');
const { getRelicMeta } = require('../../../data/exploreData');
const { findShopRow, findDefaultRow } = require('../../../utils/itemDisplay');
const { SEASONAL_EVENTS } = require('../../../data/seasonalEvents');
const { PET_DEFINITIONS, MAX_SLOT_EXPANSIONS, hasFreePetSlot } = require('../../../services/petService');
const { MAX_STAMINA_UPGRADES } = require('../../../data/crossSystemData');
const { getWorkFind, CAREER_BADGE_SHIFTS } = require('../../../data/workFinds');
const { resolveTiers } = require('../../../utils/jobTiers');

// itemId of a seasonal loot box -> the event definition that owns it
const LOOT_BOX_EVENTS = new Map(
    Object.values(SEASONAL_EVENTS)
        .filter(ev => ev.lootBox)
        .map(ev => [ev.lootBox.itemId.toLowerCase(), ev])
);

// itemId of anything a seasonal loot box can roll -> the event it came from.
// These are keepsakes: they sit in the bag, count toward /showcase and trade on
// /market. The one exception is an item that is *also* an effect item (a loot
// box can roll a booster), which the effect lookup reaches first.
const EVENT_COLLECTIBLES = new Map(
    Object.values(SEASONAL_EVENTS)
        .flatMap(ev => (ev.lootBox?.items ?? []).map(item => [item.itemId.toLowerCase(), ev]))
);

const DEFAULT_ITEM_IDS = new Set(DEFAULT_SHOP_ITEMS.map(s => s.itemId.toLowerCase()));

const MAX_FREEZES         = 2;
const MAX_CONTRACT_STACKS = 3;

// Built-in items that are spent by another command. /use used to fall through
// to the generic branch for these and quietly delete them.
const USED_ELSEWHERE = {
    pet_food:        'Feed it to a pet with `/pet feed`.',
    tier_skip_token: 'Spend it on the season pass with `/season tier-skip`.',
};

/** `7_200_000` → `2h`, `1_800_000` → `30m`. */
function formatDuration(ms) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

/** Discord's relative timestamp — renders as "in 2 hours" and keeps ticking. */
const relativeTime = date => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

/**
 * The running effect of `type`, if any. Unlike `hasEffect` this never prunes
 * (and so never mutates) the user — autocomplete reads a lean document — but it
 * asks effectsService what "active" means, so the two cannot disagree.
 */
function runningEffect(user, type) {
    const now = Date.now();
    return (user?.activeEffects ?? []).find(e => e.type === type && isActiveEffect(e, now));
}

/** How a running effect reads in a one-line status. */
function runningLabel(effect) {
    if (effect.expiresAt) return `active · ${timeRemaining(effect.expiresAt)} left`;
    if (effect.charges > 1) return `armed · ${effect.charges} charges left`;
    return 'armed';
}

/** The catalogue description with its leading emoji stripped, for an embed body. */
function describeEffect(itemId, shopItems) {
    const row = findShopRow(itemId, shopItems) ?? findDefaultRow(itemId) ?? getWorkFind(itemId);
    return (row?.description ?? '')
        .replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, '')
        .trim();
}

/**
 * What `/use` would do with one inventory item, right now.
 *
 * One answer shared by the autocomplete and `execute`, so the dropdown never
 * offers something the command then refuses for a reason it could have shown:
 *
 *   usable   false  → /use has nothing to do with it; `redirect` says what does.
 *                     These are left out of the dropdown and refused on submit
 *                     without consuming anything.
 *   ready    false  → it is a /use item but is blocked for now (the effect is
 *                     already running, a cap is reached, nobody to revive).
 *                     Still offered, with `status` saying why, sorted last.
 *   status          → the short tag the dropdown shows after the quantity.
 *
 * Only the guild's own shop items fall through to the generic "redeem" path.
 * Anything else nothing recognises — a /work find, a drop from a system that
 * never got a handler — is refused rather than consumed for nothing.
 *
 * `hasRole(roleId)` answers whether the member already holds a role, when the
 * caller can tell; a role item they already have is blocked, not spent.
 * `tiers` is the guild's job ladder (`resolveTiers`), for the Career Badge.
 */
function useStatus(itemId, user, { shopItems = [], hasRole = () => false, tiers = resolveTiers(null) } = {}) {
    const lower = itemId.toLowerCase();

    const effectType = resolveEffectType(itemId);
    if (effectType) {
        const cfg = EFFECT_CONFIGS[effectType];
        const running = runningEffect(user, effectType);
        if (running) return { usable: true, ready: false, status: runningLabel(running) };
        if (cfg.durationMs) return { usable: true, ready: true, status: `lasts ${formatDuration(cfg.durationMs)}` };
        return {
            usable: true, ready: true,
            status: cfg.charges > 1 ? `arms ${cfg.charges} charges` : 'arms for the next trigger',
        };
    }

    const capped = (have, max, noun) => ({ usable: true, ready: have < max, status: have < max ? `${have}/${max} ${noun}` : `maxed · ${max}/${max} ${noun}` });
    switch (lower) {
        case 'streak_freeze':         return capped(user?.streak?.freezes ?? 0, MAX_FREEZES, 'banked');
        case 'black_market_contract': return capped(user?.crimeContractStacks ?? 0, MAX_CONTRACT_STACKS, 'stacks');
        case 'permanent_stamina':     return capped(user?.staminaUpgrades ?? 0, MAX_STAMINA_UPGRADES, 'upgrades');
        case 'pet_slot_expansion':    return capped(user?.petSlots ?? 0, MAX_SLOT_EXPANSIONS, 'expansions');
        case 'master_key': return { usable: true, ready: true, status: 'opens the supply closet' };
        case 'career_badge': {
            const top = topTierShifts(tiers);
            const shifts = user?.shiftsWorked ?? 0;
            return shifts < top
                ? { usable: true, ready: true, status: `+${CAREER_BADGE_SHIFTS} shifts toward promotion` }
                : { usable: true, ready: false, status: 'already at the top job tier' };
        }
        case 'revive_scroll': {
            const fallen = user?.deceasedPets?.[0];
            if (!fallen) return { usable: true, ready: false, status: 'no fallen pet to revive' };
            const def = PET_DEFINITIONS[fallen.petId];
            const name = fallen.name || def?.name || fallen.petId;
            // The two refusals revive.js makes past "nobody to revive".
            if ((user?.pets ?? []).some(p => p.petId === fallen.petId)) {
                return { usable: true, ready: false, status: `you already have another ${def?.name ?? fallen.petId}` };
            }
            if (def?.purchasable && !hasFreePetSlot(user)) {
                return { usable: true, ready: false, status: `no free pet slot for ${name}` };
            }
            return { usable: true, ready: true, status: `revives ${name}` };
        }
    }

    if (LOOT_BOX_EVENTS.has(lower)) return { usable: true, ready: true, status: 'open it' };

    if (USED_ELSEWHERE[lower]) return { usable: false, redirect: USED_ELSEWHERE[lower] };

    if (getRelicMeta(itemId)) {
        return { usable: false, redirect: "It's a relic from `/explore` — a collectible, not a consumable. Admire it in `/explore relics`, or sell it to another player with `/market list`." };
    }
    if (lower.startsWith('ai_')) {
        return { usable: false, redirect: "It's a forged collectible — there's nothing to activate, but it counts toward your `/showcase`, and you can sell it to another player with `/market list` or hand it over with `/gift`." };
    }
    const event = EVENT_COLLECTIBLES.get(lower);
    if (event) {
        return { usable: false, redirect: `It's a ${event.emoji} ${event.name} keepsake — a collectible for your \`/showcase\` or the \`/market\`, not a consumable.` };
    }

    const shopItem = findShopRow(itemId, shopItems);
    if (shopItem?.roleId) {
        return hasRole(shopItem.roleId)
            ? { usable: true, ready: false, status: 'you already have the role' }
            : { usable: true, ready: true, status: 'grants a role' };
    }

    // A built-in item with no handler above (badges, frames, titles…) does its
    // job by being owned. Spending it would only throw it away.
    if (DEFAULT_ITEM_IDS.has(lower)) {
        return { usable: false, redirect: 'It works just by being in your bag — there is nothing to activate, and using it would only throw it away.' };
    }

    // A custom item the server's admins sell: theirs to define, so /use redeems it.
    if (shopItem) return { usable: true, ready: true, status: 'redeem' };

    // Either nothing in the game ever activated it (a /work find), or it was a
    // server shop item whose row has since been removed. Both are refused rather
    // than consumed; the wording covers both without claiming to know which.
    return {
        usable: false, unknown: true,
        redirect: "Nothing in the game or this server's shop uses it (any more), so there's nothing to activate. "
            + 'Keep it, hand it over with `/gift`, or sell it with `/market list`. '
            + "If it was a server shop item that's since been removed, ask an admin.",
    };
}

/** Shifts needed for the guild's top job tier; a Career Badge does nothing past it. */
const topTierShifts = tiers => Math.max(0, ...tiers.map(t => t.minShifts ?? 0));

/** How many of an item are left after a use, from the post-update document. */
const leftInBag = (user, itemId) => Math.max(0, user.inventory.find(e => e.itemId === itemId)?.quantity ?? 0);
const leftField = (user, itemId) => ({ name: '🎒 Left in bag', value: `${leftInBag(user, itemId)}x`, inline: true });

module.exports = {
    LOOT_BOX_EVENTS,
    MAX_CONTRACT_STACKS,
    MAX_FREEZES,
    describeEffect,
    leftField,
    leftInBag,
    relativeTime,
    topTierShifts,
    useStatus,
};
