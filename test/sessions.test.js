/* Every login gets its own signed, expiring session. A device can sign itself
   out, and "sign out all other devices" kills every older session — e.g. for a
   lost phone. Both survive a server restart. The old shared cookie (the same
   value for every device, valid forever) is no longer accepted. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  startServer, stopServer, login, createRoom, sleep, uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3215;
const EXPIRY_PORT = 3216;
const SESSION_SECRET = 'a'.repeat(64);
const snapshotFile = uniqueSnapshotPath('sessions');
const sessionsFile = snapshotFile.replace(/\.json$/, '.sessions.json');
const env = { SESSION_SECRET };

let server;

before(async () => {
  removeIfExists(snapshotFile);
  removeIfExists(sessionsFile);
  server = await startServer({ port: PORT, snapshotFile, env });
});

after(async () => {
  await stopServer(server);
  removeIfExists(snapshotFile);
  removeIfExists(sessionsFile);
});

async function isValid(cookie) {
  return (await createRoom(server.base, cookie)).status === 200;
}

function post(path, cookie) {
  return fetch(server.base + path, { method: 'POST', headers: { Cookie: cookie } });
}

test('each login gets its own session cookie', async () => {
  const a = await login(server.base);
  const b = await login(server.base);
  assert.notEqual(a, b);
  assert.equal(await isValid(a), true);
  assert.equal(await isValid(b), true);
});

test('the old shared cookie value is no longer accepted', async () => {
  const legacy = crypto.createHmac('sha256', SESSION_SECRET).update('authenticated').digest('hex');
  assert.equal(await isValid('hb_auth=' + legacy), false);
});

test('a tampered session cookie is rejected', async () => {
  const cookie = await login(server.base);
  const [name, value] = cookie.split('=');
  const parts = decodeURIComponent(value).split('.');
  parts[2] = String(Number(parts[2]) + 10 ** 9); // push the expiry far out
  assert.equal(await isValid(name + '=' + encodeURIComponent(parts.join('.'))), false);
});

test('logging out ends only this device\'s session', async () => {
  const phone = await login(server.base);
  const laptop = await login(server.base);
  assert.equal((await post('/logout', phone)).status, 200);
  assert.equal(await isValid(phone), false);
  assert.equal(await isValid(laptop), true);
});

test('"sign out all other devices" ends older sessions but keeps this one', async () => {
  const lost = await login(server.base);
  const mine = await login(server.base);
  assert.equal((await post('/api/sessions/logout-others', 'hb_auth=invalid')).status, 401);

  const res = await post('/api/sessions/logout-others', mine);
  assert.equal(res.status, 200);
  const fresh = res.headers.get('set-cookie').split(';')[0];
  await sleep(1100); // sessions are compared by issue time in whole seconds
  assert.equal(await isValid(lost), false);
  assert.equal(await isValid(fresh), true);
});

test('sign-outs survive a server restart', async () => {
  const kept = await login(server.base);
  const ended = await login(server.base);
  await post('/logout', ended);

  await stopServer(server);
  server = await startServer({ port: PORT, snapshotFile, env });

  assert.equal(await isValid(kept), true);
  assert.equal(await isValid(ended), false);
});

test('a session expires after its lifetime', async () => {
  const snap = uniqueSnapshotPath('sessions-expiry');
  const short = await startServer({
    port: EXPIRY_PORT, snapshotFile: snap, env: { ...env, SESSION_TTL_SECONDS: '1' },
  });
  try {
    const cookie = await login(short.base);
    assert.equal((await createRoom(short.base, cookie)).status, 200);
    await sleep(2100);
    assert.equal((await createRoom(short.base, cookie)).status, 401);
  } finally {
    await stopServer(short);
    removeIfExists(snap);
  }
});
