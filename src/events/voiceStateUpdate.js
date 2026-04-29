const { handleVoiceStateUpdate } = require('../services/tempVoiceService');

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        await handleVoiceStateUpdate(oldState, newState, client);
    }
};
