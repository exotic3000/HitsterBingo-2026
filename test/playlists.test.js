/* Playlists are global config, manageable from the moderator UI instead of
   editing server.js. Reading the list stays public (the select dropdowns
   need it before login-gated pages even apply); adding/removing requires auth. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, uniqueSnapshotPath, removeIfExists } = require('./helpers');
const path = require('path');
const fs = require('fs');

const PORT = 3206;
const snapshotFile = uniqueSnapshotPath('playlists');
const playlistsFile = path.join(__dirname, '..', '.test-playlists-' + process.pid + '.json');

let server, cookie;

before(async () => {
  removeIfExists(snapshotFile);
  removeIfExists(playlistsFile);
  server = await startServer({ port: PORT, snapshotFile, env: { PLAYLISTS_FILE: playlistsFile } });
  cookie = await login(server.base);
});

after(async () => {
  await stopServer(server);
  removeIfExists(snapshotFile);
  removeIfExists(playlistsFile);
});

async function getPlaylists() {
  const resp = await fetch(server.base + '/api/spotify/playlists');
  return (await resp.json()).playlists;
}

test('GET /api/spotify/playlists is public and starts with the seeded defaults', async () => {
  const resp = await fetch(server.base + '/api/spotify/playlists');
  assert.equal(resp.status, 200);
  const playlists = (await resp.json()).playlists;
  assert.equal(playlists.length, 2);
  assert.ok(playlists.every((p) => p.id && p.name));
});

test('POST /api/spotify/playlists requires auth', async () => {
  const resp = await fetch(server.base + '/api/spotify/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Should Fail', url: 'https://open.spotify.com/playlist/abc123XYZ' }),
  });
  assert.equal(resp.status, 401);
});

test('POST rejects an invalid Spotify URL', async () => {
  const resp = await fetch(server.base + '/api/spotify/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Bad Link', url: 'not a valid url!!' }),
  });
  assert.equal(resp.status, 400);
  assert.equal((await getPlaylists()).length, 2, 'nothing should have been added');
});

test('POST with a valid link adds a playlist, persisted for the running process', async () => {
  const resp = await fetch(server.base + '/api/spotify/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Camp Mix 2026', url: 'https://open.spotify.com/playlist/abc123XYZ' }),
  });
  assert.equal(resp.status, 200);
  const playlists = await getPlaylists();
  assert.equal(playlists.length, 3);
  assert.ok(playlists.some((p) => p.name === 'Camp Mix 2026'));

  const onDisk = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
  assert.equal(onDisk.length, 3);
});

test('DELETE /api/spotify/playlists/:id requires auth', async () => {
  const [{ id }] = await getPlaylists();
  const resp = await fetch(server.base + '/api/spotify/playlists/' + id, { method: 'DELETE' });
  assert.equal(resp.status, 401);
});

test('DELETE removes a playlist by id', async () => {
  const before2 = await getPlaylists();
  const target = before2.find((p) => p.name === 'Camp Mix 2026');
  const resp = await fetch(server.base + '/api/spotify/playlists/' + target.id, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(resp.status, 200);
  const after2 = await getPlaylists();
  assert.equal(after2.length, before2.length - 1);
  assert.ok(!after2.some((p) => p.id === target.id));
});

test('the last remaining playlist cannot be deleted', async () => {
  let playlists = await getPlaylists();
  // Delete down to exactly one.
  while (playlists.length > 1) {
    const resp = await fetch(server.base + '/api/spotify/playlists/' + playlists[0].id, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    assert.equal(resp.status, 200);
    playlists = await getPlaylists();
  }
  assert.equal(playlists.length, 1);

  const resp = await fetch(server.base + '/api/spotify/playlists/' + playlists[0].id, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(resp.status, 400);
  assert.equal((await getPlaylists()).length, 1, 'the last playlist must survive');
});
