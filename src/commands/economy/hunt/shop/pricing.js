'use strict';

// What the shop charges, and the one judgement it makes about a price: a
// weapon that costs more than a month of hunting is priced against the whole
// economy rather than against hunting alone, and the shop says so.

const { LIMITS } = require('../../../../data/huntData');
const CROSS_ECONOMY_DAYS = 30;

function huntingDaysFor(cost) {
    return cost / LIMITS.DAILY_SOFT_CAP;
}

function fullRepairCost(weapon) {
    return Math.ceil(weapon.baseDurability / 20) * weapon.repairCostPer20;
}

function isCrossEconomyWeapon(weapon) {
    return huntingDaysFor(weapon.cost) > CROSS_ECONOMY_DAYS;
}

function huntingDaysLabel(cost) {
    const days = huntingDaysFor(cost);
    return days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
}

module.exports = { CROSS_ECONOMY_DAYS, fullRepairCost, huntingDaysFor, huntingDaysLabel, isCrossEconomyWeapon };
