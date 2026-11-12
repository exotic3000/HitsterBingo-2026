/* Every game_state carries a sequence number (stateVersion) and a session id
   (stateEpoch). Team phones drop a state that is older than the one they
   already show — e.g. a late packet after a reconnect — but must accept a new
   session (room recreated, server restarted without snapshot) even though its
   counter starts again at 1. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');
const { shouldApplyState } = require('../public/js/state-order');

const PORT = 3230;
const snapshotFile = uniqueSnapshotPath('state-version');
let liveServer = null;

after(async () => {
  if (liveServer) await stopServer(liveServer);
  removeIfExists(snapshotFile);
});

test('shouldApplyState: newer applies, older or equal is dropped', () => {
  const seen = { epoch: 'a', version: 5 };
  assert.equal(shouldApplyState(seen, { stateEpoch: 'a', stateVersion: 6 }), true);
  assert.equal(shouldApplyState(seen, { stateEpoch: 'a', stateVersion: 5 }), false);
  assert.equal(shouldApplyState(seen, { stateEpoch: 'a', stateVersion: 4 }), false);
});

test('shouldApplyState: a new session applies even with a lower counter', () => {
  assert.equal(shouldApplyState({ epoch: 'a', version: 40 }, { stateEpoch: 'b', stateVersion: 1 }), true);
});

test('shouldApplyState: first state and states without version always apply', () => {
  assert.equal(shouldApplyState(null, { stateEpoch: 'a', stateVersion: 1 }), true);
  assert.equal(shouldApplyState({ epoch: 'a', version: 9 }, {}), true);
});

test('versions rise per broadcast, epoch stays, and both survive a restart', async () => {
  removeIfExists(snapshotFile);
  let server = await startServer({ port: PORT, snapshotFile });
  liveServer = server;
  const cookie = await login(server.base);
  const { roomCode } = (await createRoom(server.base, cookie)).body;

  const mod = connectSocket(server.base, roomCode, cookie);
  const team = connectSocket(server.base, roomCode);
  const states = [];
  team.on('game_state', (s) => states.push(s));
  await Promise.all([waitForEvent(mod, 'connect'), waitForEvent(team, 'connect')]);
  mod.emit('join', { role: 'moderator' });
  await joinTeam(team, { name: 'Alpha' });
  mod.emit('start_spin');
  await sleep(200);
  mod.emit('set_song', { title: 'Song', artist: 'Artist', year: '1999', spotifyUri: null });
  await sleep(300);

  assert.ok(states.length >= 2, 'team should have received several states');
  const versions = states.map((s) => s.stateVersion);
  for (let i = 1; i < versions.length; i++) assert.ok(versions[i] > versions[i - 1], `versions must rise: ${versions}`);
  const epoch = states[0].stateEpoch;
  assert.equal(typeof epoch, 'string');
  assert.ok(epoch.length >= 8);
  assert.ok(states.every((s) => s.stateEpoch === epoch));
  const lastBefore = versions[versions.length - 1];

  mod.disconnect();
  team.disconnect();
  await stopServer(server);
  liveServer = null;

  server = await startServer({ port: PORT, snapshotFile });
  liveServer = server;
  const again = connectSocket(server.base, roomCode, await login(server.base));
  const restored = waitForEvent(again, 'game_state');
  again.emit('join', { role: 'moderator' });
  const state = await restored;
  again.disconnect();

  assert.equal(state.stateEpoch, epoch, 'restored session keeps its epoch');
  assert.ok(state.stateVersion >= lastBefore, `restored version ${state.stateVersion} must not go back below ${lastBefore}`);
});
