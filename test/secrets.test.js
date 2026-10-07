/* No password or Spotify secret ships with the code any more (the
   repository is public): they come from the environment or a git-ignored
   .env file, and without them the server stays safe instead of falling
   back to a value anyone could read on GitHub. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  startServer, stopServer, createRoom, uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3211;
const snapshotFile = uniqueSnapshotPath('secrets');
const envFile = path.join(__dirname, '..', '.test-env-' + process.pid);

async function tryLogin(base, password) {
  const resp = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { status: resp.status, cookie: resp.headers.get('set-cookie') };
}

test('without a configured password the old public default no longer works', async () => {
  removeIfExists(snapshotFile);
  const server = await startServer({ port: PORT, snapshotFile, env: { SITE_PASSWORD: undefined } });
  try {
    assert.equal((await tryLogin(server.base, 'OutOfOrbit26')).status, 401);

    const printed = server.getOutput().match(/Passwort für diesen Start: (\S+)/);
    assert.ok(printed, 'the generated password must be shown in the console');
    assert.equal((await tryLogin(server.base, printed[1])).status, 200);
  } finally {
    await stopServer(server);
    removeIfExists(snapshotFile);
  }
});

test('the .env file provides the password and Spotify app, real environment variables win', async () => {
  removeIfExists(snapshotFile);
  fs.writeFileSync(envFile, [
    '# comment lines are ignored',
    'SITE_PASSWORD="from-the-file"',
    'SPOTIFY_CLIENT_ID=file-client-id',
    'SPOTIFY_CLIENT_SECRET=file-client-secret',
    'SPOTIFY_REDIRECT_URI=https://from-the-file.example/cb',
  ].join('\n'));

  const server = await startServer({
    port: PORT,
    snapshotFile,
    env: { ENV_FILE: envFile, SITE_PASSWORD: undefined, SPOTIFY_REDIRECT_URI: 'https://from-the-env.example/cb' },
  });
  try {
    const login = await tryLogin(server.base, 'from-the-file');
    assert.equal(login.status, 200, 'quotes around the value are stripped');

    const roomCode = (await createRoom(server.base, login.cookie)).body.roomCode;
    const auth = await fetch(server.base + '/auth/spotify?room=' + roomCode, { redirect: 'manual', headers: { Cookie: login.cookie } });
    assert.equal(auth.status, 302);
    assert.match(auth.headers.get('location'), /client_id=file-client-id/);
    assert.match(auth.headers.get('location'), /redirect_uri=https%3A%2F%2Ffrom-the-env\.example/, 'the real environment variable wins over the file');

    assert.match(server.getOutput(), /Spotify Auth \(pro Runde\)/);
    assert.doesNotMatch(server.getOutput(), /Passwort für diesen Start/);
  } finally {
    await stopServer(server);
    removeIfExists(snapshotFile);
    removeIfExists(envFile);
  }
});

test('without Spotify credentials the login link explains what is missing', async () => {
  removeIfExists(snapshotFile);
  const server = await startServer({
    port: PORT, snapshotFile, env: { SPOTIFY_CLIENT_ID: undefined, SPOTIFY_CLIENT_SECRET: undefined },
  });
  try {
    const login = await tryLogin(server.base, 'test-password');
    const roomCode = (await createRoom(server.base, login.cookie)).body.roomCode;
    const resp = await fetch(server.base + '/auth/spotify?room=' + roomCode, { redirect: 'manual', headers: { Cookie: login.cookie } });
    assert.equal(resp.status, 500);
    assert.match(await resp.text(), /\.env/);
  } finally {
    await stopServer(server);
    removeIfExists(snapshotFile);
  }
});

test('no secret is hard-coded in the server source', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /OutOfOrbit26/);
  assert.doesNotMatch(source, /b31d81165bba4bc1ab5e947a9889154b/);
  assert.doesNotMatch(source, /f019a8aaafee49a99be7d0d50cfb3db4/);
});
