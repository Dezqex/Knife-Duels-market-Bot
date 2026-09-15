// Simple in-memory store for active duel games (Coinflip, Mines, ...).
// Keyed by a unique game id (we reuse the interaction id, which is unique per command call).
const games = new Map();

// Tracks which user IDs are currently occupied in a game, so the same user
// can't be dragged into two duels at once. Value = gameId.
const activePlayers = new Map();

function createGame(id, state) {
  games.set(id, state);
  activePlayers.set(state.challenger.id, id);
  activePlayers.set(state.opponent.id, id);
  return state;
}

function getGame(id) {
  return games.get(id);
}

function deleteGame(id) {
  const state = games.get(id);
  if (state) {
    if (activePlayers.get(state.challenger.id) === id) activePlayers.delete(state.challenger.id);
    if (activePlayers.get(state.opponent.id) === id) activePlayers.delete(state.opponent.id);
  }
  games.delete(id);
}

// Returns true if the given user is currently part of an ongoing game.
function isUserBusy(userId) {
  return activePlayers.has(userId);
}

module.exports = { createGame, getGame, deleteGame, isUserBusy };
