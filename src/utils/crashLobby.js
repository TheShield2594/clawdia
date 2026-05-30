// In-memory lobby state for multiplayer crash. One active lobby per channel.
// Keyed by channelId.

const lobbies = new Map();

const LOBBY_JOIN_WINDOW_MS = 30_000;
const MAX_PLAYERS          = 10;

/**
 * Creates a new lobby. Returns the lobby object or null if one already exists.
 */
function createLobby(channelId, hostId, bet) {
    if (lobbies.has(channelId)) return null;
    const lobby = {
        channelId,
        hostId,
        bet,
        players: new Map(), // userId -> { cashedOutAt: number|null }
        locked:  false,
        started: false,
        joinDeadline: Date.now() + LOBBY_JOIN_WINDOW_MS,
        interval: null,
    };
    lobbies.set(channelId, lobby);
    return lobby;
}

function getLobby(channelId) {
    return lobbies.get(channelId) ?? null;
}

function deleteLobby(channelId) {
    const lobby = lobbies.get(channelId);
    if (lobby?.interval) clearInterval(lobby.interval);
    lobbies.delete(channelId);
}

function addPlayer(channelId, userId, autoCashout = null) {
    const lobby = lobbies.get(channelId);
    if (!lobby || lobby.locked || lobby.players.size >= MAX_PLAYERS) return false;
    if (lobby.players.has(userId)) return false;
    lobby.players.set(userId, { cashedOutAt: null, autoCashout });
    return true;
}

function setPlayerAutoCashout(channelId, userId, target) {
    const lobby = lobbies.get(channelId);
    if (!lobby) return false;
    const state = lobby.players.get(userId);
    if (!state) return false;
    state.autoCashout = target;
    return true;
}

module.exports = {
    LOBBY_JOIN_WINDOW_MS,
    MAX_PLAYERS,
    createLobby,
    getLobby,
    deleteLobby,
    addPlayer,
    setPlayerAutoCashout,
};
