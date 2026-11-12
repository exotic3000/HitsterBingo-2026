/* Decides whether a team phone applies an incoming game_state.
   States carry a per-session id (stateEpoch) and a rising sequence number
   (stateVersion). Within one session an older or equal version is a late
   packet (e.g. after a reconnect) and is dropped; a different epoch is a new
   session (room recreated, server restarted without snapshot) whose counter
   starts again at 1, so it always applies.
   Shared by the browser (window.shouldApplyState) and the tests (require). */
(function (root) {
  function shouldApplyState(seen, state) {
    if (!seen || !state || !state.stateVersion) return true;
    if (state.stateEpoch !== seen.epoch) return true;
    return state.stateVersion > seen.version;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { shouldApplyState };
  else root.shouldApplyState = shouldApplyState;
})(this);
