/* The site password is reachable from the internet, so guessing it must be
   throttled per client. Behind the Cloudflare tunnel every request comes from
   cloudflared on localhost; the real client is in CF-Connecting-IP, which is
   only trusted from localhost — otherwise one attacker could lock everyone
   out, or dodge the limit by changing the header. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, SITE_PASSWORD, uniqueSnapshotPath, removeIfExists } = require('./helpers');

const PORT = 3214;
const snapshotFile = uniqueSnapshotPath('login-throttle');
const MAX_FAILURES = 10;

let server;

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
});

after(async () => {
  await stopServer(server);
  removeIfExists(snapshotFile);
});

function tryLogin(password, clientIp) {
  return fetch(server.base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': clientIp },
    body: JSON.stringify({ password }),
  });
}

test(`after ${MAX_FAILURES} wrong passwords a client is blocked, even with the right one`, async () => {
  const ip = '198.51.100.1';
  for (let i = 0; i < MAX_FAILURES; i++) {
    assert.equal((await tryLogin('wrong-' + i, ip)).status, 401);
  }
  const blocked = await tryLogin(SITE_PASSWORD, ip);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After is set');
});

test('a blocked client does not lock out other clients', async () => {
  const attacker = '198.51.100.2';
  for (let i = 0; i < MAX_FAILURES; i++) await tryLogin('wrong-' + i, attacker);
  assert.equal((await tryLogin(SITE_PASSWORD, attacker)).status, 429);
  assert.equal((await tryLogin(SITE_PASSWORD, '198.51.100.3')).status, 200);
});

test('a successful login resets the counter', async () => {
  const ip = '198.51.100.4';
  for (let i = 0; i < MAX_FAILURES - 1; i++) await tryLogin('wrong-' + i, ip);
  assert.equal((await tryLogin(SITE_PASSWORD, ip)).status, 200);
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    assert.equal((await tryLogin('wrong-again-' + i, ip)).status, 401);
  }
});

test('the login page tells a blocked user to wait', async () => {
  const html = await (await fetch(server.base + '/login.html')).text();
  assert.match(html, /429/);
});
