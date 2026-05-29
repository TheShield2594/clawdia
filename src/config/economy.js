const MAX_COMBINED_MULTIPLIER = 10.0;

// Clamp the product of all active multipliers to prevent economy inflation
function clampMultiplier(combined) {
    return Math.min(combined, MAX_COMBINED_MULTIPLIER);
}

module.exports = { MAX_COMBINED_MULTIPLIER, clampMultiplier };
