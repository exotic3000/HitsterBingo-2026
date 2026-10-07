/* Rooms stay fully independent games sharing one server — this is the core
   correctness property the whole "Rundenverwaltung" feature exists for. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, deleteRoom, listRooms,
  connectSocket, joinTeam, sleep, waitForEvent, uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3201;
const snapshotFile = uniqueSnapshotPath('rooms');

let server, cookie;

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
  cookie = await login(server.base);
});

after(async () => {
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('teams, spin state and kicks stay isolated between two concurrent rooms', async () => {
  const roomA = (await createRoom(server.base, cookie)).body.roomCode;
  const roomB = (await createRoom(server.base, cookie)).body.roomCode;

  const modA = connectSocket(server.base, roomA, cookie);
  const modB = connectSocket(server.base, roomB, cookie);

  let stateA = null, stateB = null;
  modA.on('game_state', (s) => { stateA = s; });
  modB.on('game_state', (s) => { stateB = s; });
  await Promise.all([waitForEvent(modA, 'connect'), waitForEvent(modB, 'connect')]);

  const teamA = connectSocket(server.base, roomA);
  const teamB = connectSocket(server.base, roomB);
  await Promise.all([waitForEvent(teamA, 'connect'), waitForEvent(teamB, 'connect')]);

  const ackA = await joinTeam(teamA, { name: 'Alpha' });
  const ackB = await joinTeam(teamB, { name: 'Beta' });
  assert.equal(ackA.ok, true);
  assert.equal(ackB.ok, true);
  await sleep(200);

  assert.deepEqual(Object.values(stateA.teams).map((t) => t.name), ['Alpha']);
  assert.deepEqual(Object.values(stateB.teams).map((t) => t.name), ['Beta']);

  // The same name is fine across different rooms — uniqueness is per-room.
  const teamA2 = connectSocket(server.base, roomA);
  await waitForEvent(teamA2, 'connect');
  const ackDupe = await joinTeam(teamA2, { name: 'Beta', emoji: '🌟' });
  assert.equal(ackDupe.ok, true);
  teamA2.disconnect();

  modA.emit('start_spin');
  await sleep(300);
  assert.equal(stateA.gameState, 'spinning');
  assert.equal(stateB.gameState, 'lobby', 'spinning room A must not leak into room B');

  const alphaId = Object.entries(stateA.teams).find(([, t]) => t.name === 'Alpha')[0];
  modA.emit('kick_team', { teamId: alphaId });
  await sleep(300);
  assert.equal(alphaId in stateA.teams, false);
  assert.equal(Object.keys(stateA.teams).length, 1, 'the other room-A team must survive the kick');
  assert.equal(Object.keys(stateB.teams).length, 1, 'room B must be unaffected by a kick in room A');

  modA.disconnect(); modB.disconnect(); teamA.disconnect(); teamB.disconnect();
});

test('an unknown room code is rejected with invalid_room, never a silent global fallback', async () => {
  const bad = connectSocket(server.base, 'DOESNOTEXIST');
  const event = await Promise.race([
    waitForEvent(bad, 'invalid_room').then(() => 'invalid_room'),
    sleep(1500).then(() => 'timeout'),
  ]);
  assert.equal(event, 'invalid_room');
  bad.disconnect();
});

test('DELETE /api/rooms removes a room from the listing', async () => {
  const roomCode = (await createRoom(server.base, cookie)).body.roomCode;
  assert.ok((await listRooms(server.base)).some((r) => r.roomCode === roomCode));

  const del = await deleteRoom(server.base, cookie, roomCode);
  assert.equal(del.status, 200);
  assert.ok(!(await listRooms(server.base)).some((r) => r.roomCode === roomCode));
});
