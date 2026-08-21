// In-memory lobby state for multiplayer crash. One active lobby per channel.
// Keyed by channelId.
//
// Deliberately not in Mongo, unlike the per-user action lock in
// src/utils/activeGameLock.js. A lobby holds a live `setInterval` handle and is
// driven by a component collector on a specific message — neither survives
// serialisation, so this is a storage problem only in the sense that the whole
// multiplayer round is process-bound.
//
// What that costs, precisely: a restart mid-round drops the lobby, and a second
// process would let one channel run two. Neither can double-pay. Money never
// moves through this object — each player's stake is taken with a guarded
// `balance: { $gte: bet }` debit and each cash-out credited with an `$inc`
// against their own document (see src/games/casino/crash.js), so a duplicated
// lobby is two independent games, not one game paid twice. Bets are refunded
// from the `pendingCrashRefund` field the debit writes, which is in Mongo
// precisely so a lost lobby cannot strand a stake.

const { assertGuildAffinity } = require('./sharding');

const lobbies = new Map();

const LOBBY_JOIN_WINDOW_MS = 30_000;
const MAX_PLAYERS          = 10;

/**
 * Creates a new lobby. Returns the lobby object or null if one already exists.
 *
 * `guildId` is only used to check shard affinity — a channel belongs to exactly
 * one guild, and Discord routes that guild's events to exactly one shard, which
 * is what makes one lobby per channel a safe thing to hold in a Map. The check
 * makes that assumption loud if it ever stops holding (#732).
 */
function createLobby(channelId, hostId, bet, guildId = null) {
    if (lobbies.has(channelId)) return null;
    if (guildId) assertGuildAffinity(guildId, 'crash lobby');
    const lobby = {
        channelId,
        guildId,
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

function addPlayer(channelId, userId, autoCashout = null, username = null) {
    const lobby = lobbies.get(channelId);
    if (!lobby || lobby.locked || lobby.players.size >= MAX_PLAYERS) return false;
    if (lobby.players.has(userId)) return false;
    lobby.players.set(userId, { cashedOutAt: null, autoCashout, username });
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
