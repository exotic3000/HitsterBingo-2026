/* A room's Spotify connection should drop once nobody has any tab of that
   room open — with a short grace period so a reload doesn't force a fresh
   login mid-show. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, createRoom, connectSocket, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3203;
const snapshotFile = uniqueSnapshotPath('spotify');
const GRACE_MS = 800; // real default is 20000ms — shortened just for this test run

let server, cookie, roomCode;

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({
    port: PORT,
    snapshotFile,
    env: { ENABLE_TEST_HOOKS: '1', SPOTIFY_DISCONNECT_GRACE_MS: String(GRACE_MS) },
  });
  cookie = await login(server.base);
  roomCode = (await createRoom(server.base, cookie, 'Spotify Test Room')).body.roomCode;

  const seedResp = await fetch(server.base + '/api/test/seed-spotify-token/' + roomCode, { method: 'POST' });
  assert.equal(seedResp.status, 200, 'test seam must be active (ENABLE_TEST_HOOKS)');
});

after(async () => {
  await stopServer(server);
  removeIfExists(snapshotFile);
});

async function getSpotifyReady() {
  const s = connectSocket(server.base, roomCode);
  const state = await waitForEvent(s, 'game_state');
  s.disconnect();
  return state.spotifyReady;
}

test('a lone open tab does not lose the Spotify connection', async () => {
  const a = connectSocket(server.base, roomCode);
  await waitForEvent(a, 'connect');
  assert.equal(await getSpotifyReady(), true);
  a.disconnect();
});

test('reconnecting within the grace period cancels the pending disconnect', async () => {
  const a = connectSocket(server.base, roomCode);
  await waitForEvent(a, 'connect');
  a.disconnect(); // last tab closes — grace timer starts

  await sleep(GRACE_MS / 2);
  const b = connectSocket(server.base, roomCode); // someone reconnects in time
  await waitForEvent(b, 'connect');

  await sleep(GRACE_MS); // long enough for the original timer to have fired, if it hadn't been cancelled
  assert.equal(await getSpotifyReady(), true, 'reconnecting in time must cancel the disconnect');
  b.disconnect();
});

test('Spotify disconnects once the grace period elapses with nobody connected', async () => {
  const a = connectSocket(server.base, roomCode);
  await waitForEvent(a, 'connect');
  assert.equal(await getSpotifyReady(), true, 'sanity check: still connected before this test tears it down');
  a.disconnect();

  await sleep(GRACE_MS + 500);
  assert.equal(await getSpotifyReady(), false);
});
