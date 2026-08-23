'use strict';

// The heist's fixed cast and its targets. Static data, kept out of the service
// so `views/heistView.js` can lay out a lobby without importing a service —
// a view sits below one (#614). `services/heistService` re-exports both, so
// every existing caller is unaffected.

const ROLES = {
    hacker:  { emoji: '💻', label: 'Hacker',  desc: 'Bypasses security systems — answer a logic question.' },
    lookout: { emoji: '👀', label: 'Lookout', desc: 'Monitors guard patterns — identify the duplicate number.' },
    muscle:  { emoji: '💪', label: 'Muscle',  desc: 'Handles confrontations — play higher-lower.' },
    driver:  { emoji: '🚗', label: 'Driver',  desc: 'Plans the escape route — pick the safe route.' },
};

const TARGETS = {
    bank:    { label: 'Server Bank',    baseReward: 1.0 },
    vault:   { label: 'Faction Vault',  baseReward: 1.5 },
    casino:  { label: 'Casino Safe',    baseReward: 1.25 },
};

module.exports = { ROLES, TARGETS };
