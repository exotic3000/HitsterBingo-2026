/* Creating/closing a round changes shared state and must require the site
   password; listing rounds must stay open, since join.html's unauthenticated
   round picker depends on it. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, deleteRoom, listRooms, uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3202;
const snapshotFile = uniqueSnapshotPath('auth');

let server;

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
});

after(async () => {
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('POST /api/rooms requires auth', async () => {
  const anon = await createRoom(server.base, null, 'Should Fail');
  assert.equal(anon.status, 401);

  const cookie = await login(server.base);
  const authed = await createRoom(server.base, cookie, 'Should Work');
  assert.equal(authed.status, 200);
  assert.ok(authed.body.roomCode);
});

test('DELETE /api/rooms/:code requires auth', async () => {
  const cookie = await login(server.base);
  const { roomCode } = (await createRoom(server.base, cookie)).body;

  const anon = await deleteRoom(server.base, null, roomCode);
  assert.equal(anon.status, 401);
  assert.ok((await listRooms(server.base)).some((r) => r.roomCode === roomCode), 'unauthenticated delete must not remove the room');

  const authed = await deleteRoom(server.base, cookie, roomCode);
  assert.equal(authed.status, 200);
  assert.ok(!(await listRooms(server.base)).some((r) => r.roomCode === roomCode));
});

test('GET /api/rooms stays public (join.html needs it without a login)', async () => {
  const resp = await fetch(server.base + '/api/rooms');
  assert.equal(resp.status, 200);
  assert.ok(Array.isArray((await resp.json()).rooms));
});
