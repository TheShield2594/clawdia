'use strict';

const { SYNERGIES, SYNERGY_LIST } = require('../data/crossSystemData');

function getActiveSynergies(user) {
    const huntLevel  = user.hunt?.level    ?? 0;
    const fishLevel  = user.fishing?.level ?? 0;
    const mineLevel  = user.mining?.level  ?? 0;

    return SYNERGY_LIST.filter(syn => {
        const req = syn.requirements;
        if (req.hunt    && huntLevel  < req.hunt)    return false;
        if (req.fishing && fishLevel  < req.fishing) return false;
        if (req.mining  && mineLevel  < req.mining)  return false;
        return true;
    });
}

function hasSynergy(user, synergyId) {
    return getActiveSynergies(user).some(s => s.id === synergyId);
}

function getHuntSynergyStaminaBonus(user) {
    return hasSynergy(user, 'outdoorsman')
        ? (SYNERGIES.outdoorsman?.bonuses?.huntStamina ?? 0)
        : 0;
}

function getFishSynergyStaminaBonus(user) {
    return hasSynergy(user, 'outdoorsman')
        ? (SYNERGIES.outdoorsman?.bonuses?.fishingStamina ?? 0)
        : 0;
}

function hasIronWill(user) {
    return hasSynergy(user, 'iron_will');
}

module.exports = {
    getActiveSynergies,
    hasSynergy,
    getHuntSynergyStaminaBonus,
    getFishSynergyStaminaBonus,
    hasIronWill
};
