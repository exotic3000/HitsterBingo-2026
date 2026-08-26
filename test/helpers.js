/* Shared helpers for integration tests: each test file spawns its own real
   server process on a dedicated port (kept far from the dev default 3000
   and from each other) so test files can run concurrently without
   colliding — including their snapshot file, via SNAPSHOT_FILE. */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const SITE_PASSWORD = 'OutOfOrbit26'; // matches server.js's default

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

// Starts a real `node server.js` child process. `port` and `snapshotFile`
// should be unique per test file. Resolves once the HTTP server actually
// answers requests (polls, since a fixed startup delay is either flaky on a
// slow machine or wastefully slow on a fast one).
async function startServer({ port, snapshotFile, env = {} }) {
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SNAPSHOT_FILE: snapshotFile,
      SITE_PASSWORD,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { output += d.toString(); });

  const base = 'http://localhost:' + port;

  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(base + '/api/rooms');
      if (resp.ok) {
        return { proc, base, getOutput: () => output };
      }
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server on port ' + port + ' never came up. Output so far:\n' + output);
}

// Graceful shutdown (SIGTERM) — deliberately, not SIGKILL, since it's what
// exercises the crash-recovery snapshot-on-shutdown path.
async function stopServer(handle) {
  if (!handle || handle.proc.exitCode !== null) return;
  const exited = waitForEvent(handle.proc, 'exit');
  handle.proc.kill('SIGTERM');
  await exited;
}

async function login(base) {
  const resp = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: SITE_PASSWORD }),
  });
  const cookie = resp.headers.get('set-cookie');
  if (!cookie) throw new Error('login did not return a cookie');
  return cookie;
}

async function createRoom(base, cookie, name) {
  const resp = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ name: name || '' }),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

async function deleteRoom(base, cookie, roomCode) {
  const resp = await fetch(base + '/api/rooms/' + encodeURIComponent(roomCode), {
    method: 'DELETE',
    headers: cookie ? { Cookie: cookie } : {},
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

async function listRooms(base) {
  const resp = await fetch(base + '/api/rooms');
  return (await resp.json()).rooms;
}

// Connects a socket.io-client bound to a room via the same handshake query
// param the real frontend (shared.js's connectSocket()) uses.
// reconnection: false is deliberate — if a test throws before reaching its
// own socket.disconnect() call, an un-cleaned-up socket must die quietly
// once its server goes away, not retry forever and keep the test process's
// event loop alive (which otherwise hangs the whole file, not just that test).
function connectSocket(base, roomCode) {
  return io(base, { transports: ['websocket'], reconnection: false, query: { room: roomCode || '' } });
}

async function joinTeam(socket, { teamId, name, emoji } = {}) {
  return new Promise((resolve) => {
    socket.emit('join', { role: 'team', teamId, name, emoji: emoji || '🚀' }, resolve);
  });
}

function uniqueSnapshotPath(label) {
  return path.join(ROOT, '.test-snapshot-' + label + '-' + process.pid + '.json');
}

function removeIfExists(filePath) {
  try { fs.unlinkSync(filePath); } catch (e) { /* already gone */ }
}

module.exports = {
  sleep,
  waitForEvent,
  startServer,
  stopServer,
  login,
  createRoom,
  deleteRoom,
  listRooms,
  connectSocket,
  joinTeam,
  uniqueSnapshotPath,
  removeIfExists,
};
