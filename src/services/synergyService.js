'use strict';

const { SYNERGIES, SYNERGY_LIST } = require('../data/crossSystemData');

function getActiveSynergies(user) {
    const huntLevel    = user.hunt?.level        ?? 0;
    const fishLevel    = user.fishing?.level     ?? 0;
    const mineLevel    = user.mining?.level      ?? 0;
    const exploreLevel = user.exploration?.level ?? 0;

    return SYNERGY_LIST.filter(syn => {
        const req = syn.requirements;
        if (req.hunt        && huntLevel    < req.hunt)        return false;
        if (req.fishing     && fishLevel    < req.fishing)     return false;
        if (req.mining      && mineLevel    < req.mining)      return false;
        if (req.exploration && exploreLevel < req.exploration) return false;
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

function getFishDeepProspectorStaminaBonus(user) {
    return hasSynergy(user, 'deep_prospector')
        ? (SYNERGIES.deep_prospector?.bonuses?.fishingStamina ?? 0)
        : 0;
}

function getMineDeepProspectorStaminaBonus(user) {
    return hasSynergy(user, 'deep_prospector')
        ? (SYNERGIES.deep_prospector?.bonuses?.miningStamina ?? 0)
        : 0;
}

function getArtificerMineYieldBonus(user) {
    return hasSynergy(user, 'artificer')
        ? (SYNERGIES.artificer?.bonuses?.mineYieldPct ?? 0)
        : 0;
}

function getArtificerMineStaminaBonus(user) {
    return hasSynergy(user, 'artificer')
        ? (SYNERGIES.artificer?.bonuses?.miningStamina ?? 0)
        : 0;
}

function getExploreWayfinderStaminaBonus(user) {
    return hasSynergy(user, 'wayfinder')
        ? (SYNERGIES.wayfinder?.bonuses?.explorationStamina ?? 0)
        : 0;
}

function getHuntWayfinderStaminaBonus(user) {
    return hasSynergy(user, 'wayfinder')
        ? (SYNERGIES.wayfinder?.bonuses?.huntStamina ?? 0)
        : 0;
}

function getMerchantCoinBonus(user) {
    if (!hasSynergy(user, 'merchant')) return 0;
    const hasItems = (user.inventory ?? []).some(e => e.quantity > 0);
    return hasItems ? (SYNERGIES.merchant?.bonuses?.workCrimeCoinPct ?? 0) : 0;
}

module.exports = {
    getActiveSynergies,
    hasSynergy,
    getHuntSynergyStaminaBonus,
    getFishSynergyStaminaBonus,
    hasIronWill,
    getFishDeepProspectorStaminaBonus,
    getMineDeepProspectorStaminaBonus,
    getArtificerMineYieldBonus,
    getArtificerMineStaminaBonus,
    getExploreWayfinderStaminaBonus,
    getHuntWayfinderStaminaBonus,
    getMerchantCoinBonus,
};
