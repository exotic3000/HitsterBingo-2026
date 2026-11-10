/* A phone that hops networks (venue Wi-Fi → mobile data) reconnects on a
   new socket right away, while the server only notices its old socket is
   dead after the ping timeout. That late disconnect must not remove a team
   that is connected again — only a team with no connection left. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3218;
const GRACE_MS = 800;
const snapshotFile = uniqueSnapshotPath('team-reconnect');

let server, roomCode, mod, modState;
const sockets = [];

async function openTeamSocket() {
  const socket = connectSocket(server.base, roomCode);
  sockets.push(socket);
  await waitForEvent(socket, 'connect');
  return socket;
}

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile, env: { TEAM_DISCONNECT_GRACE_MS: String(GRACE_MS) } });
  const cookie = await login(server.base);
  roomCode = (await createRoom(server.base, cookie)).body.roomCode;
  mod = connectSocket(server.base, roomCode, cookie);
  sockets.push(mod);
  mod.on('game_state', (s) => { modState = s; });
  await waitForEvent(mod, 'connect');
  mod.emit('join', { role: 'moderator' });
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('a team that reconnected before its old socket dropped stays in the game', async () => {
  const oldSocket = await openTeamSocket();
  const ack = await joinTeam(oldSocket, { name: 'Funkloch', emoji: '🚀' });
  assert.equal(ack.ok, true);

  const newSocket = await openTeamSocket();
  const resumed = await joinTeam(newSocket, { teamId: ack.teamId, teamSecret: ack.teamSecret });
  assert.equal(resumed.ok, true);

  oldSocket.disconnect(); // the server only now notices the old connection is gone
  await sleep(GRACE_MS + 700);

  assert.ok(modState.teams[ack.teamId], 'the team must survive while its new connection is up');
  assert.equal(newSocket.connected, true);
});

test('a team whose last connection is gone is still removed after the grace period', async () => {
  const socket = await openTeamSocket();
  const ack = await joinTeam(socket, { name: 'Weg', emoji: '🌟' });
  assert.equal(ack.ok, true);

  socket.disconnect();
  await sleep(GRACE_MS + 700);

  assert.equal(modState.teams[ack.teamId], undefined);
});

test('a team that reconnects within the grace period keeps its seat', async () => {
  const socket = await openTeamSocket();
  const ack = await joinTeam(socket, { name: 'Neuladen', emoji: '🪐' });
  socket.disconnect();
  await sleep(GRACE_MS / 4);

  const again = await openTeamSocket();
  const resumed = await joinTeam(again, { teamId: ack.teamId, teamSecret: ack.teamSecret });
  assert.equal(resumed.ok, true);
  await sleep(GRACE_MS + 700);

  assert.ok(modState.teams[ack.teamId]);
});
