/* The game is reached through the Cloudflare tunnel on localhost only; it
   must not listen on every interface unless HOST says so. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, uniqueSnapshotPath, removeIfExists } = require('./helpers');

const PORT = 3231;
const snapshotFile = uniqueSnapshotPath('listen-host');
let live = null;

after(async () => {
  if (live) await stopServer(live);
  removeIfExists(snapshotFile);
});

test('listens on 127.0.0.1 by default and is reachable via localhost', async () => {
  live = await startServer({ port: PORT, snapshotFile });
  assert.match(live.getOutput(), /lauscht auf 127\.0\.0\.1/);
  const res = await fetch(live.base + '/');
  assert.ok(res.status < 500);
  await stopServer(live);
  live = null;
});

test('HOST overrides the bind address', async () => {
  live = await startServer({ port: PORT, snapshotFile, env: { HOST: '0.0.0.0' } });
  assert.match(live.getOutput(), /lauscht auf 0\.0\.0\.0/);
});
