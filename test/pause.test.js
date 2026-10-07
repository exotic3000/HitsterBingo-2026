/* Pause must freeze the countdown exactly where it is (not reset it),
   block answer submission while frozen, and resume ticking from the same
   value — the whole point being a lossless interruption, unlike Reset. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3205;
const snapshotFile = uniqueSnapshotPath('pause');

let server, cookie, roomCode, mod, team, teamId;
let lastState = null;

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
  cookie = await login(server.base);
  roomCode = (await createRoom(server.base, cookie)).body.roomCode;

  mod = connectSocket(server.base, roomCode, cookie);
  team = connectSocket(server.base, roomCode);
  await Promise.all([waitForEvent(mod, 'connect'), waitForEvent(team, 'connect')]);
  team.on('game_state', (s) => { lastState = s; });

  const ack = await joinTeam(team, { name: 'Alpha' });
  teamId = ack.teamId;
});

after(async () => {
  mod.disconnect();
  team.disconnect();
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('pause_game outside "playing" has no effect', async () => {
  mod.emit('pause_game');
  await sleep(200);
  assert.equal(lastState.paused, false);
});

test('pausing freezes the timer and blocks answer submission', async () => {
  mod.emit('start_spin');
  await sleep(200);
  mod.emit('set_song', { title: 'Song', artist: 'Artist', year: '2000', spotifyUri: null });
  await sleep(300);
  assert.equal(lastState.gameState, 'playing');

  await sleep(1100); // let the timer tick down at least once
  mod.emit('pause_game');
  await sleep(200);
  assert.equal(lastState.paused, true);
  const frozenValue = lastState.timerValue;

  await sleep(1500); // long enough for 1+ ticks if it were still running
  assert.equal(lastState.timerValue, frozenValue, 'timer must not advance while paused');

  team.emit('submit_answer', { teamId, answer: 'should be ignored' });
  await sleep(200);
  assert.equal(lastState.answers[teamId], undefined, 'answers must be rejected while paused');
});

test('resuming continues the countdown from the frozen value and answers work again', async () => {
  const frozenValue = lastState.timerValue;
  assert.equal(lastState.paused, true, 'sanity check: previous test left the round paused');

  mod.emit('resume_game');
  await sleep(200);
  assert.equal(lastState.paused, false);
  assert.equal(lastState.timerValue, frozenValue, 'resuming must not skip or reset time');

  // Wait for the actual tick event rather than a fixed sleep — a tick lands
  // ~1000ms after startTimer() fires, and padding that with just enough
  // slop to "probably" cover one tick makes this brittle on a loaded machine.
  const tick = await waitForEvent(team, 'timer_tick');
  assert.ok(tick < frozenValue, 'timer must resume counting down');

  team.emit('submit_answer', { teamId, answer: 'now it counts' });
  await sleep(200);
  assert.equal(lastState.answers[teamId], 'now it counts');
});

test('reset_game clears a paused state', async () => {
  mod.emit('start_spin');
  await sleep(200);
  mod.emit('set_song', { title: 'Song 2', artist: 'Artist', year: '2001', spotifyUri: null });
  await sleep(300);
  mod.emit('pause_game');
  await sleep(200);
  assert.equal(lastState.paused, true);

  mod.emit('reset_game');
  await sleep(300);
  assert.equal(lastState.paused, false);
  assert.equal(lastState.gameState, 'lobby');
});
