/* Random songs come from a playlist that's loaded once and cached: no
   Spotify request per song any more, no recent repeats, no unplayable
   entries — against a local fake Spotify API that counts every request. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  startServer, stopServer, login, createRoom, uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3209;
const FAKE_SPOTIFY_PORT = 3299;
const FAKE_BASE = 'http://localhost:' + FAKE_SPOTIFY_PORT;
const snapshotFile = uniqueSnapshotPath('playlist-cache');
const playlistsFile = path.join(__dirname, '..', '.test-playlists-cache-' + process.pid + '.json');

function fakeTrack(i, extra = {}) {
  return {
    is_local: false,
    item: {
      type: 'track', id: 'id' + i, uri: 'spotify:track:id' + i, name: 'Song ' + i,
      artists: [{ name: 'Artist ' + i }],
      album: { name: 'Album', release_date: '1999-01-01', images: [{ url: 'http://img/' + i }] },
      preview_url: null, duration_ms: 1000,
      ...extra,
    },
  };
}

const PLAYLISTS = {
  BIGLIST: [
    ...Array.from({ length: 70 }, (_, i) => fakeTrack(i)),
    { is_local: true, item: { type: 'track', id: 'local', uri: 'spotify:local:x', name: 'Local', artists: [], album: {} } },
    fakeTrack('ep', { type: 'episode', uri: 'spotify:episode:ep' }),
  ],
  SMALLLIST: [fakeTrack('a'), fakeTrack('b')],
};

let server, fakeSpotify, cookie;
let requests = [];

before(async () => {
  removeIfExists(snapshotFile);
  fs.writeFileSync(playlistsFile, JSON.stringify([
    { id: 'pl-big', name: 'Big', url: 'https://open.spotify.com/playlist/BIGLIST' },
    { id: 'pl-small', name: 'Small', url: 'https://open.spotify.com/playlist/SMALLLIST' },
  ]));

  // Pages of 50 with a `next` link, like the real API.
  fakeSpotify = http.createServer((req, res) => {
    const url = new URL(req.url, FAKE_BASE);
    requests.push(url.pathname + url.search);
    const match = url.pathname.match(/^\/playlists\/(\w+)\/items$/);
    if (!match || !PLAYLISTS[match[1]]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { status: 404, message: 'Resource not found' } }));
      return;
    }
    const all = PLAYLISTS[match[1]];
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 50);
    const nextOffset = offset + limit;
    const next = nextOffset < all.length
      ? FAKE_BASE + url.pathname + '?offset=' + nextOffset + '&limit=' + limit
      : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: all.slice(offset, nextOffset), next }));
  });
  await new Promise((resolve) => fakeSpotify.listen(FAKE_SPOTIFY_PORT, resolve));

  server = await startServer({
    port: PORT,
    snapshotFile,
    env: { ENABLE_TEST_HOOKS: '1', SPOTIFY_API_BASE: FAKE_BASE, PLAYLISTS_FILE: playlistsFile },
  });
  cookie = await login(server.base);
});

after(async () => {
  await stopServer(server);
  await new Promise((resolve) => fakeSpotify.close(resolve));
  removeIfExists(snapshotFile);
  removeIfExists(playlistsFile);
});

async function newConnectedRoom() {
  const roomCode = (await createRoom(server.base, cookie)).body.roomCode;
  await fetch(server.base + '/api/test/seed-spotify-token/' + roomCode, { method: 'POST' });
  return roomCode;
}

async function randomSong(roomCode, playlist) {
  const resp = await fetch(server.base + '/api/spotify/playlist-random?room=' + roomCode + '&playlist=' + playlist, { headers: { Cookie: cookie } });
  return { status: resp.status, body: await resp.json() };
}

test('a playlist is loaded once, then every further random song needs no Spotify request', async () => {
  const room = await newConnectedRoom();
  requests = [];

  const first = await randomSong(room, 'pl-big');
  assert.equal(first.status, 200);
  assert.equal(requests.length, 2, '72 entries = two pages of 50');

  for (let i = 0; i < 9; i++) assert.equal((await randomSong(room, 'pl-big')).status, 200);
  assert.equal(requests.length, 2, 'later songs must come from the cache');
});

test('recent songs do not repeat and unplayable entries are never picked', async () => {
  const room = await newConnectedRoom();
  const picked = [];
  for (let i = 0; i < 16; i++) picked.push((await randomSong(room, 'pl-big')).body.track.spotifyUri);

  assert.equal(new Set(picked).size, 16, 'the last 15 songs must not come up again');
  assert.ok(picked.every((uri) => uri.startsWith('spotify:track:id')), 'no local files or podcast episodes');
});

test('a two-song playlist alternates instead of blocking itself', async () => {
  const room = await newConnectedRoom();
  const picked = [];
  for (let i = 0; i < 6; i++) picked.push((await randomSong(room, 'pl-small')).body.track.spotifyId);
  for (let i = 1; i < picked.length; i++) assert.notEqual(picked[i], picked[i - 1]);
});

test('the cache is shared between rooms', async () => {
  requests = [];
  const roomA = await newConnectedRoom();
  const roomB = await newConnectedRoom();
  await Promise.all([randomSong(roomA, 'pl-big'), randomSong(roomB, 'pl-big')]);
  assert.equal(requests.length, 0, 'both rooms reuse the playlist loaded earlier');
});

test('a Spotify error is reported to the moderator with its reason', async () => {
  const roomCode = (await createRoom(server.base, cookie)).body.roomCode;
  await fetch(server.base + '/api/test/seed-spotify-token/' + roomCode, { method: 'POST' });
  // A playlist id the fake API doesn't know, added through the moderator API.
  const add = await fetch(server.base + '/api/spotify/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Missing', url: 'https://open.spotify.com/playlist/MISSINGLIST' }),
  });
  const missing = (await add.json()).playlists.find((p) => p.name === 'Missing');

  const res = await randomSong(roomCode, missing.id);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Resource not found/);
});
