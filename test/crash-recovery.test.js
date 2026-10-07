/* Everything lives in memory, so a crash/restart must not wipe a running
   round: teams, scores, round state and the in-progress timer all need to
   survive via the periodic/on-shutdown snapshot. Spotify tokens must NOT
   survive — that's deliberate, verified here too. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3204;
const snapshotFile = uniqueSnapshotPath('crash-recovery');

let liveServer = null;
after(async () => {
  if (liveServer) await stopServer(liveServer);
  removeIfExists(snapshotFile);
});

test('a round survives a restart: teams, score, current song and the running timer', async () => {
  removeIfExists(snapshotFile);

  let server = await startServer({ port: PORT, snapshotFile, env: { ENABLE_TEST_HOOKS: '1' } });
  liveServer = server;
  const cookie = await login(server.base);
  const { roomCode } = (await createRoom(server.base, cookie, 'Gruppe Falken')).body;

  const seedResp = await fetch(server.base + '/api/test/seed-spotify-token/' + roomCode, { method: 'POST' });
  assert.equal(seedResp.status, 200);

  const mod = connectSocket(server.base, roomCode, cookie);
  const team = connectSocket(server.base, roomCode);
  await Promise.all([waitForEvent(mod, 'connect'), waitForEvent(team, 'connect')]);

  let lastState = null;
  team.on('game_state', (s) => { lastState = s; });

  const ack = await joinTeam(team, { name: 'Alpha' });
  assert.equal(ack.ok, true);
  const teamId = ack.teamId;

  mod.emit('start_spin');
  await sleep(200);
  mod.emit('set_song', { title: 'Test Song', artist: 'Test Artist', year: '1999', spotifyUri: null });
  await sleep(300);
  assert.equal(lastState.gameState, 'playing');

  team.emit('mark_correct', { teamId, row: 0, col: 0 });
  await sleep(200);
  const scoreBeforeRestart = lastState.teams[teamId].score;
  assert.equal(scoreBeforeRestart, 1);

  mod.disconnect();
  team.disconnect();

  // Graceful shutdown snapshots immediately — exercises the same save path
  // the periodic 30s timer would use during a real crash, without waiting for it.
  await stopServer(server);
  liveServer = null;

  server = await startServer({ port: PORT, snapshotFile, env: { ENABLE_TEST_HOOKS: '1' } });
  liveServer = server;

  assert.match(server.getOutput(), /Runde\(n\) aus Snapshot wiederhergestellt/);

  const rooms = await (await fetch(server.base + '/api/rooms')).json();
  const restored = rooms.rooms.find((r) => r.roomCode === roomCode);
  assert.ok(restored, 'room must still exist after restart');
  assert.equal(restored.roomName, 'Gruppe Falken');
  assert.equal(restored.teamCount, 1);
  assert.equal(restored.gameState, 'playing');

  // Joined as the overview — it's the view that shows every team's score.
  // Fresh login: without a fixed SESSION_SECRET a restart invalidates cookies.
  const team2 = connectSocket(server.base, roomCode, await login(server.base));
  await waitForEvent(team2, 'game_state');
  const joinedState = waitForEvent(team2, 'game_state');
  team2.emit('join', { role: 'overview' });
  const state = await joinedState;

  assert.equal(state.teams[teamId].name, 'Alpha');
  assert.equal(state.teams[teamId].score, scoreBeforeRestart);
  assert.equal(state.currentSong.title, 'Test Song');
  assert.equal(state.spotifyReady, false, 'Spotify tokens must never survive a restart');

  const tick1 = await waitForEvent(team2, 'timer_tick');
  await sleep(1100);
  const tick2 = await waitForEvent(team2, 'timer_tick');
  assert.ok(tick2 < tick1, 'the timer must resume counting down, not sit frozen');

  team2.disconnect();
});
