/* Version-stamped CSS/JS (and the Socket.IO client) are cacheable for good —
   at Cloudflare's edge and on the phones — while HTML and anything without
   the current stamp is revalidated on every load, so a deploy still goes
   live immediately. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer, stopServer, login, uniqueSnapshotPath, removeIfExists,
} = require('./helpers');

const PORT = 3210;
const snapshotFile = uniqueSnapshotPath('assets');

let server, cookie, html;

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
  cookie = await login(server.base);
  const resp = await fetch(server.base + '/display.html', { headers: { Cookie: cookie } });
  html = await resp.text();
});

after(async () => {
  await stopServer(server);
  removeIfExists(snapshotFile);
});

function stampedUrl(file) {
  const match = html.match(new RegExp('"(' + file.replace(/[.\/]/g, '\\$&') + '\\?v=\\d+)"'));
  assert.ok(match, file + ' must be referenced with a version stamp');
  return match[1];
}

test('HTML is always revalidated', async () => {
  const resp = await fetch(server.base + '/display.html', { headers: { Cookie: cookie } });
  assert.equal(resp.headers.get('cache-control'), 'no-cache');
});

test('stamped CSS and JS are immutable', async () => {
  for (const file of ['/css/style.css', '/js/display.js', '/js/shared.js']) {
    const resp = await fetch(server.base + stampedUrl(file));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('cache-control'), 'public, max-age=31536000, immutable', file);
  }
});

test('the Socket.IO client is served minified, stamped and immutable', async () => {
  assert.equal(html.includes('/socket.io/socket.io.js'), false);
  const resp = await fetch(server.base + stampedUrl('/vendor/socket.io.min.js'));
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type'), /javascript/);
  assert.equal(resp.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const body = await resp.text();
  assert.ok(body.length < 60000, 'minified build expected, got ' + body.length + ' bytes');
});

test('unstamped or outdated asset URLs are revalidated', async () => {
  for (const url of ['/js/display.js', '/js/display.js?v=123', '/vendor/socket.io.min.js']) {
    const resp = await fetch(server.base + url);
    assert.equal(resp.headers.get('cache-control'), 'no-cache', url);
  }
});
