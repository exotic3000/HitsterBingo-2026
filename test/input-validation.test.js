/* Team names and emojis end up on every screen (Beamer, moderator,
   overview). The server must only accept harmless values, so a team can't
   smuggle markup or scripts onto the staff devices. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  startServer, stopServer, login, createRoom, connectSocket, joinTeam, waitForEvent,
  uniqueSnapshotPath, removeIfExists,
} = require('./helpers');
const { TEAM_EMOJIS } = require('../lib/teamInput');

const PORT = 3213;
const snapshotFile = uniqueSnapshotPath('input-validation');

let server, roomCode, cookie;
const sockets = [];

async function freshTeamSocket() {
  const s = connectSocket(server.base, roomCode);
  sockets.push(s);
  await waitForEvent(s, 'connect');
  return s;
}

before(async () => {
  removeIfExists(snapshotFile);
  server = await startServer({ port: PORT, snapshotFile });
  cookie = await login(server.base);
  roomCode = (await createRoom(server.base, cookie)).body.roomCode;
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await stopServer(server);
  removeIfExists(snapshotFile);
});

test('a normal team name with umlauts and & is accepted', async () => {
  const ack = await joinTeam(await freshTeamSocket(), { name: '  Tom & Jörg  ', emoji: '🛸' });
  assert.equal(ack.ok, true);
});

test('a name with HTML markup is refused', async () => {
  const ack = await joinTeam(await freshTeamSocket(), {
    name: '<img src=x onerror=alert(1)>', emoji: '🌙',
  });
  assert.equal(ack.ok, false);
  assert.equal(ack.field, 'name');
});

test('a name longer than 20 characters is refused', async () => {
  const ack = await joinTeam(await freshTeamSocket(), { name: 'A'.repeat(21), emoji: '🌙' });
  assert.equal(ack.ok, false);
  assert.equal(ack.field, 'name');
});

test('a name with control characters is refused', async () => {
  const ack = await joinTeam(await freshTeamSocket(), { name: 'Team\u0000X', emoji: '🌙' });
  assert.equal(ack.ok, false);
  assert.equal(ack.field, 'name');
});

test('an emoji that is not offered in the picker is refused', async () => {
  for (const emoji of ['<b>x</b>', '🍕', 'abc']) {
    const ack = await joinTeam(await freshTeamSocket(), { name: 'Emoji ' + emoji.length, emoji });
    assert.equal(ack.ok, false, 'refused: ' + emoji);
    assert.equal(ack.field, 'emoji');
  }
});

test('the Spotify callback echoes an error parameter as plain text, not HTML', async () => {
  const payload = '<script>alert(1)</script>';
  const res = await fetch(server.base + '/auth/spotify/callback?error=' + encodeURIComponent(payload), {
    headers: { Cookie: cookie },
  });
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.ok((await res.text()).includes(payload));
});

test('the server allows exactly the emojis the picker shows', () => {
  const shared = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared.js'), 'utf8');
  const match = shared.match(/const TEAM_EMOJIS = (\[[^\]]*\]);/);
  assert.ok(match, 'TEAM_EMOJIS found in shared.js');
  assert.deepEqual(JSON.parse(match[1].replace(/'/g, '"')), TEAM_EMOJIS);
});
