/* Knowing the room code — every team does — must not be enough to run the
   show: moderator, Beamer and overview need the site login, a team can only
   act for itself, and a team's seat can't be taken over by its id alone. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3212;
const snapshotFile = uniqueSnapshotPath('access');

let server, cookie, roomCode, mod, alpha, beta, alphaAck, betaAck;
let modState = null;
const sockets = [];

function open(withCookie) {
  const s = connectSocket(server.base, roomCode, withCookie ? cookie : undefined);
  sockets.push(s);
  return s;
}

function emitWithAck(socket, event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile, env: { ENABLE_TEST_HOOKS: '1' } });
  cookie = await login(server.base);
  roomCode = (await createRoom(server.base, cookie)).body.roomCode;

  mod = open(true);
  mod.on('game_state', (s) => { modState = s; });
  await waitForEvent(mod, 'connect');
  assert.equal((await emitWithAck(mod, 'join', { role: 'moderator' })).ok, true);

  alpha = open(false);
  beta = open(false);
  await Promise.all([waitForEvent(alpha, 'connect'), waitForEvent(beta, 'connect')]);
  alphaAck = await joinTeam(alpha, { name: 'Alpha', emoji: '🚀' });
  betaAck = await joinTeam(beta, { name: 'Beta', emoji: '🌟' });
  assert.ok(alphaAck.teamSecret, 'a new team gets its secret');

  mod.emit('start_spin');
  mod.emit('set_song', { title: 'Song', artist: 'Artist', year: '1999', spotifyUri: null });
  await sleep(300);
  assert.equal(modState.gameState, 'playing');
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('without the login, joining as moderator, Beamer or overview is refused', async () => {
  const intruder = open(false);
  await waitForEvent(intruder, 'connect');
  for (const role of ['moderator', 'display', 'overview']) {
    const res = await emitWithAck(intruder, 'join', { role });
    assert.equal(res.ok, false, role);
    assert.equal(res.auth, true, role);
  }
});

test('without the login, control commands are ignored', async () => {
  const intruder = open(false);
  await waitForEvent(intruder, 'connect');
  for (const event of ['reset_game', 'reveal_solution', 'next_round', 'start_spin', 'pause_game']) intruder.emit(event);
  intruder.emit('kick_team', { teamId: betaAck.teamId });
  intruder.emit('set_song', { title: 'Hijack', artist: 'X' });
  const auto = await emitWithAck(intruder, 'set_auto_moderator', { enabled: true });
  await sleep(300);

  assert.equal(auto.ok, false);
  assert.equal(modState.gameState, 'playing');
  assert.equal(modState.paused, false);
  assert.equal(modState.currentSong.title, 'Song');
  assert.ok(modState.teams[betaAck.teamId], 'the team must not have been kicked');
});

test('a team answers and ticks only for itself', async () => {
  alpha.emit('submit_answer', { teamId: betaAck.teamId, answer: 'written by Alpha' });
  alpha.emit('mark_correct', { teamId: betaAck.teamId, row: 0, col: 0 });
  await sleep(300);

  assert.equal(modState.answers[alphaAck.teamId], 'written by Alpha', 'lands on the sender\'s own team');
  assert.equal(modState.answers[betaAck.teamId], undefined);
  assert.equal(modState.teams[betaAck.teamId].score, 0);
});

test('the moderator can still tick any team\'s card', async () => {
  mod.emit('mark_correct', { teamId: betaAck.teamId, row: 1, col: 1 });
  await sleep(300);
  assert.equal(modState.teams[betaAck.teamId].score, 1);
});

test('a team seat cannot be taken over with the team id alone', async () => {
  const thief = open(false);
  await waitForEvent(thief, 'connect');
  const stolen = await joinTeam(thief, { teamId: alphaAck.teamId, name: 'Alpha' });
  assert.equal(stolen.ok, false);

  const ownPhone = open(false);
  await waitForEvent(ownPhone, 'connect');
  const resumed = await joinTeam(ownPhone, { teamId: alphaAck.teamId, teamSecret: alphaAck.teamSecret });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.teamId, alphaAck.teamId);
});

test('malformed commands cannot crash the server', async () => {
  alpha.emit('mark_correct', { teamId: alphaAck.teamId, row: 99, col: -1 });
  alpha.emit('mark_correct', null);
  alpha.emit('submit_answer', null);
  mod.emit('mark_correct', { teamId: 'no-such-team', row: 0, col: 0 });
  mod.emit('set_song', null);
  await sleep(300);
  const resp = await fetch(server.base + '/api/rooms');
  assert.equal(resp.status, 200, 'server must still be up');
});

test('the room\'s Spotify access token and search need the login', async () => {
  await fetch(server.base + '/api/test/seed-spotify-token/' + roomCode, { method: 'POST' });

  const open1 = await fetch(server.base + '/api/spotify/token?room=' + roomCode);
  assert.equal(open1.status, 401);
  const open2 = await fetch(server.base + '/api/spotify/playlist-random?room=' + roomCode);
  assert.equal(open2.status, 401);
  const page = await fetch(server.base + '/auth/spotify?room=' + roomCode, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/login\.html/);

  const authed = await fetch(server.base + '/api/spotify/token?room=' + roomCode, { headers: { Cookie: cookie } });
  assert.equal(authed.status, 200);
});
