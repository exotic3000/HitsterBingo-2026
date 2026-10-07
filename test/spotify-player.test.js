/* The server drives playback on the one registered Beamer player directly
   (no round-trip through the Beamer's browser), starts the countdown only
   once the song is actually audible, and surfaces failures to the
   moderator instead of failing silently. Spotify itself is replaced by a
   local fake API that records every request. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  startServer, stopServer, login, createRoom, connectSocket, sleep, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3207;
const FAKE_SPOTIFY_PORT = 3297;
const CONFIRM_TIMEOUT_MS = 1500;
const snapshotFile = uniqueSnapshotPath('spotify-player');
const SONG = { title: 'Song', artist: 'Artist', year: '1999', spotifyUri: 'spotify:track:abc' };

let server, fakeSpotify, cookie;
let requests = [];
const sockets = [];

before(async () => {
  removeIfExists(snapshotFile);

  // Device "broken" simulates Spotify not knowing the device; everything else succeeds.
  fakeSpotify = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url.includes('device_id=broken')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 404, message: 'Device not found' } }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => fakeSpotify.listen(FAKE_SPOTIFY_PORT, resolve));

  server = await startServer({
    port: PORT,
    snapshotFile,
    env: {
      ENABLE_TEST_HOOKS: '1',
      SPOTIFY_API_BASE: 'http://localhost:' + FAKE_SPOTIFY_PORT,
      PLAYBACK_CONFIRM_TIMEOUT_MS: String(CONFIRM_TIMEOUT_MS),
    },
  });
  cookie = await login(server.base);
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await stopServer(server);
  await new Promise((resolve) => fakeSpotify.close(resolve));
  removeIfExists(snapshotFile);
});

async function waitFor(check, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('condition not met within ' + timeoutMs + 'ms');
}

// A fresh room with Spotify "connected", a moderator socket and (optionally)
// a Beamer socket that registered its player device.
async function setupRoom({ deviceId } = {}) {
  requests = [];
  const roomCode = (await createRoom(server.base, cookie)).body.roomCode;
  await fetch(server.base + '/api/test/seed-spotify-token/' + roomCode, { method: 'POST' });

  const mod = connectSocket(server.base, roomCode, cookie);
  sockets.push(mod);
  const room = { roomCode, mod, state: null, ticks: [] };
  mod.on('game_state', (s) => { room.state = s; });
  mod.on('timer_tick', (v) => room.ticks.push(v));
  await waitForEvent(mod, 'connect');

  if (deviceId) room.display = await connectDisplay(room, deviceId);
  return room;
}

async function connectDisplay(room, deviceId) {
  const display = connectSocket(server.base, room.roomCode, cookie);
  sockets.push(display);
  await waitForEvent(display, 'connect');
  display.emit('spotify_player_ready', { deviceId });
  await waitFor(() => room.state && room.state.spotifyPlayerReady);
  return display;
}

function playRequests(deviceId) {
  return requests.filter((r) => r.url.startsWith('/me/player/play') && r.url.includes('device_id=' + deviceId));
}

test('a song is played on the registered Beamer device and the countdown waits until it is audible', async () => {
  const room = await setupRoom({ deviceId: 'dev-1' });
  room.mod.emit('start_spin');
  room.mod.emit('set_song', SONG);

  const [play] = await waitFor(() => playRequests('dev-1').length && playRequests('dev-1'));
  assert.equal(play.method, 'PUT');
  assert.deepEqual(play.body, { uris: [SONG.spotifyUri] });

  await sleep(1100);
  assert.equal(room.ticks.length, 0, 'countdown must not run before the Beamer confirms playback');
  assert.equal(room.state.awaitingPlayback, true);

  room.display.emit('spotify_playback_started', { uris: [SONG.spotifyUri] });
  await waitFor(() => room.ticks.length);
  assert.equal(room.state.awaitingPlayback, false);
});

test('without a confirmation the countdown still starts after the fallback timeout', async () => {
  const room = await setupRoom({ deviceId: 'dev-2' });
  room.mod.emit('start_spin');
  room.mod.emit('set_song', SONG);

  await waitFor(() => room.ticks.length, CONFIRM_TIMEOUT_MS + 2000);
});

test('a confirmation for a different track does not start the countdown', async () => {
  const room = await setupRoom({ deviceId: 'dev-3' });
  room.mod.emit('start_spin');
  room.mod.emit('set_song', SONG);
  await waitFor(() => playRequests('dev-3').length);

  room.display.emit('spotify_playback_started', { uris: ['spotify:track:previous-song'] });
  await sleep(1100);
  assert.equal(room.ticks.length, 0);
});

test('revealing the solution pauses the Beamer device after the play command', async () => {
  const room = await setupRoom({ deviceId: 'dev-4' });
  room.mod.emit('start_spin');
  room.mod.emit('set_song', SONG);
  room.mod.emit('reveal_solution'); // straight away — the pause must still land after the play

  await waitFor(() => requests.some((r) => r.url.startsWith('/me/player/pause')));
  const order = requests.map((r) => r.url.split('?')[0]);
  assert.deepEqual(order, ['/me/player/play', '/me/player/pause']);
  assert.ok(requests[1].url.includes('device_id=dev-4'));
});

test('a newer Beamer tab takes over playback and the old one is told to let go', async () => {
  const room = await setupRoom({ deviceId: 'old-beamer' });
  const replaced = waitForEvent(room.display, 'spotify_player_replaced');
  await connectDisplay(room, 'new-beamer');
  await replaced;

  room.mod.emit('start_spin');
  room.mod.emit('set_song', SONG);
  await waitFor(() => playRequests('new-beamer').length);
  assert.equal(playRequests('old-beamer').length, 0);
});

test('without a Beamer player the countdown starts right away and the moderator is told why there is no sound', async () => {
  const room = await setupRoom();
  room.mod.emit('start_spin');
  room.mod.emit('set_song', SONG);

  await waitFor(() => room.ticks.length, 1500);
  assert.match(room.state.spotifyPlayerIssue, /Kein Beamer-Player/);
  assert.equal(requests.length, 0);
});

test('a failing play command is retried, then reported, and the round goes on', async () => {
  const room = await setupRoom({ deviceId: 'broken' });
  room.mod.emit('start_spin');
  room.mod.emit('set_song', SONG);

  await waitFor(() => room.state.spotifyPlayerIssue, 5000);
  assert.match(room.state.spotifyPlayerIssue, /404/);
  assert.equal(playRequests('broken').length, 3);
  await waitFor(() => room.ticks.length, 1500);
});

test('the Beamer disconnecting unregisters its player', async () => {
  const room = await setupRoom({ deviceId: 'dev-5' });
  room.display.disconnect();
  await waitFor(() => room.state.spotifyPlayerReady === false);
});
