#!/usr/bin/env node
/* Lasttest & Robustheitsmessung für die Gameshow — Szenarien, Messgrößen
   und Grenzwerte sind in loadtest/MESSSZENARIO.md beschrieben.

   Aufruf:  node loadtest/run.js <szenario> [--option=wert ...]
   Beispiel: node loadtest/run.js scale --steps=1,10,25 --lurkers=5

   Startet für jeden Schritt einen eigenen, frischen `node server.js` auf
   einem Testport (nie den laufenden Produktivserver), spielt mit simulierten
   Geräten echte Runden durch und gibt Perzentile + PASS/FAIL aus. */

const fs = require('fs');
const path = require('path');
const h = require('../test/helpers');
const { TEAM_EMOJIS } = require('../lib/teamInput');
const { SimClient } = require('./client');
const { createNetProxy } = require('./netproxy');
const { createRecorder, createProcessSampler } = require('./metrics');

const SERVER_PORT = 3400;
const PROXY_PORT = 3401;
const HALFOPEN_PROXY_BASE_PORT = 3410;
const SNAPSHOT_FILE = path.join(__dirname, '..', '.loadtest-snapshot.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const SESSION_SECRET = 'loadtest-session-secret';
// socket.io server defaults: pingInterval 25 s + pingTimeout 20 s
const SERVER_DEAD_SOCKET_DETECTION_MS = 45000;

const DEFAULTS = {
  rooms: 1, teams: 10, lurkers: 0, rounds: 3,
  latency: 0, jitter: 0, kbps: 0, resetsPerMin: 0, transport: 'websocket',
  answerWindow: 4000, spinMs: 1500, playMs: 5000, timeoutMs: 15000,
  halfOpenTeams: 0, grace: 0, crash: false, crashDelay: 0,
};

const PRESETS = {
  baseline: { rooms: 1 },
  scale: { steps: '1,5,10,25,50', lurkers: 5, rounds: 2 },
  badnet: { rooms: 5, lurkers: 3, latency: 300, jitter: 400, kbps: 64, resetsPerMin: 30 },
  polling: { rooms: 5, lurkers: 3, rounds: 2, transport: 'polling', latency: 150, jitter: 100 },
  burst: { rooms: 20, lurkers: 5, answerWindow: 50 },
  halfopen: { rooms: 1, rounds: 1, halfOpenTeams: 5, grace: 5000 },
  crash: { rooms: 5, lurkers: 2, rounds: 1, crash: true },
};

// Grenzwerte: "clean" = lokales, ungestörtes Netz; "degraded" = mit
// künstlicher Latenz/Bandbreite/Abbrüchen. Harte Kriterien gelten immer.
const BUDGETS = {
  clean: { fanout_ms: 250, answer_ms: 250, mark_ms: 250, join_ack_ms: 500 },
  degraded: { fanout_ms: 2500, answer_ms: 2500, mark_ms: 2500, join_ack_ms: 4000 },
  always: { tick_jitter_ms_p99: 100, server_cpu_pct_p95: 70, client_loop_lag_ms_p95: 50 },
  zero: ['join_failed', 'connect_timeouts', 'fanout_timeouts', 'answer_lost', 'mark_lost',
    'teams_lost', 'reconnect_failed', 'state_divergence', 'crash_teams_lost'],
};

const sleep = h.sleep;

function parseArgs(argv) {
  const [scenario = 'baseline', ...rest] = argv;
  if (!PRESETS[scenario]) {
    console.error('Unbekanntes Szenario "' + scenario + '". Verfügbar: ' + Object.keys(PRESETS).join(', '));
    process.exit(2);
  }
  const overrides = {};
  for (const arg of rest) {
    const m = arg.match(/^--(\w+)(?:=(.*))?$/);
    if (!m) continue;
    const raw = m[2] === undefined ? 'true' : m[2];
    overrides[m[1]] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return { scenario, opts: { ...DEFAULTS, ...PRESETS[scenario], ...overrides } };
}

function isDegraded(opts) {
  return opts.latency > 0 || opts.jitter > 0 || opts.kbps > 0 || opts.resetsPerMin > 0 || opts.transport === 'polling';
}

// Measures how late this (client) process's own event loop runs — if the
// load generator itself is overloaded, every latency it reports is inflated.
function startClientLagMonitor(rec) {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    rec.add('client_loop_lag_ms', Math.max(0, now - last - 100));
    last = now;
  }, 100);
  return () => clearInterval(timer);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => null)]);
}

async function setupRoom(ctx, roomCode, roomIdx) {
  const { opts, rec } = ctx;
  const mk = (role, extra = {}) => new SimClient({
    url: ctx.clientUrl, room: roomCode, role, cookie: ctx.cookie, recorder: rec, transport: opts.transport, ...extra,
  });
  const staff = ['moderator', 'display', 'overview'].map((r) => mk(r));
  const teams = Array.from({ length: opts.teams }, (_, i) => mk('team', {
    teamName: `R${roomIdx}-Team${i}`,
    emoji: TEAM_EMOJIS[i % TEAM_EMOJIS.length],
    // Half-open candidates (only in room 0) get a dedicated proxy each.
    ...(roomIdx === 0 && i < opts.halfOpenTeams ? { url: `http://127.0.0.1:${HALFOPEN_PROXY_BASE_PORT + i}`, transport: 'websocket' } : {}),
  }));
  const lurkers = Array.from({ length: opts.lurkers }, () => mk('lurker'));
  const all = [...staff, ...teams, ...lurkers];

  // Everyone scans the QR code at once: connect storm, then join storm.
  const connected = await Promise.all(all.map((c) => withTimeout(c.connect().then(() => true), opts.timeoutMs * 2)));
  rec.inc('connect_timeouts', connected.filter((ok) => !ok).length);
  await Promise.all(staff.map((c) => c.join()));
  await Promise.all(teams.map(async (c) => {
    const sentAt = Date.now();
    const res = await c.join();
    if (res && res.ok) rec.add('join_ack_ms', Date.now() - sentAt);
    else { rec.inc('join_failed'); console.warn('  Beitritt fehlgeschlagen:', c.teamName, res && res.message); }
  }));
  return { code: roomCode, mod: staff[0], staff, teams, lurkers, all };
}

// Fires a moderator action and records how long each device in the room
// takes to show the resulting state (= what players perceive as lag).
async function fanOut(ctx, room, label, action, predicate) {
  const { rec, opts } = ctx;
  const waits = room.all.map((c) => c.waitFor(predicate, opts.timeoutMs));
  action();
  const results = await Promise.all(waits);
  let slowest = 0;
  for (const ms of results) {
    if (ms === null) { rec.inc('fanout_timeouts'); rec.inc(`fanout_timeouts_${label}`); continue; }
    rec.add('fanout_ms', ms);
    rec.add(`fanout_${label}_ms`, ms);
    slowest = Math.max(slowest, ms);
  }
  rec.add('fanout_complete_ms', slowest);
}

async function submitAnswers(ctx, room) {
  const { rec, opts } = ctx;
  await Promise.all(room.teams.map(async (t) => {
    await sleep(Math.random() * opts.answerWindow);
    if (!t.teamId) return;
    t.socket.emit('submit_answer', { answer: 'Antwort von ' + t.teamName });
    const ms = await room.mod.waitFor((s) => s.answers && s.answers[t.teamId], opts.timeoutMs);
    if (ms === null) rec.inc('answer_lost'); else rec.add('answer_ms', ms);
  }));
}

async function markCells(ctx, room) {
  const { rec, opts } = ctx;
  await Promise.all(room.teams.map(async (t) => {
    const team = t.ownTeam();
    const category = t.state && t.state.currentCategory;
    if (!team || !team.bingoCard || !category) return;
    // Teams may tick one still-open cell of this round's category per round.
    const open = [];
    team.bingoCard.forEach((cells, row) => cells.forEach((cell, col) => {
      if (!cell.checked && cell.categoryId === category.id) open.push({ row, col });
    }));
    if (!open.length) { rec.inc('mark_no_open_cell'); return; }
    const { row, col } = open[Math.floor(Math.random() * open.length)];
    t.socket.emit('mark_correct', { teamId: t.teamId, row, col });
    const ms = await t.waitFor((s) => {
      const own = s.teams[t.teamId];
      return own && own.bingoCard && own.bingoCard[row][col].checked;
    }, opts.timeoutMs);
    if (ms === null) rec.inc('mark_lost'); else rec.add('mark_ms', ms);
  }));
}

async function playRound(ctx, room) {
  const { opts } = ctx;
  const mod = room.mod;
  if (!mod.state) return;
  const token = mod.state.spinToken + 1;
  const round = mod.state.currentRound;
  const title = `Lasttest ${room.code} #${token}`;

  await fanOut(ctx, room, 'spin', () => mod.socket.emit('start_spin'),
    (s) => s.spinToken >= token);
  await sleep(opts.spinMs);
  await fanOut(ctx, room, 'song', () => mod.socket.emit('set_song', { title, artist: 'Lasttest', year: '2026' }),
    // Only the moderator knows the song before the reveal; everyone else
    // just sees the round start.
    (s) => s.gameState === 'playing' && s.spinToken === token);
  await Promise.all([submitAnswers(ctx, room), sleep(opts.playMs)]);
  await fanOut(ctx, room, 'reveal', () => mod.socket.emit('reveal_solution'),
    (s) => s.gameState === 'revealing' && s.spinToken === token && s.currentSong && s.currentSong.title === title);
  await markCells(ctx, room);
  await fanOut(ctx, room, 'next', () => mod.socket.emit('next_round'),
    (s) => s.currentRound > round);
}

// After the run: every team must still exist, and every device must agree
// with the moderator about the game state and its own score.
async function checkConsistency(ctx, rooms) {
  const { rec } = ctx;
  await sleep(1500);
  for (const room of rooms) {
    const ref = room.mod.state;
    if (!ref) { rec.inc('state_divergence'); continue; }
    for (const t of room.teams) {
      if (!t.teamId) continue;
      if (!ref.teams[t.teamId]) { rec.inc('teams_lost'); continue; }
      const own = t.ownTeam();
      if (!own || own.score !== ref.teams[t.teamId].score) rec.inc('state_divergence');
    }
    for (const c of room.all) {
      if (!c.state || c.state.gameState !== ref.gameState || c.state.currentRound !== ref.currentRound) rec.inc('state_divergence');
    }
  }
}

function startRandomResets(ctx) {
  const { opts, proxy } = ctx;
  if (!opts.resetsPerMin || !proxy) return () => {};
  const timer = setInterval(() => {
    const conns = proxy.connections();
    if (conns.length) proxy.reset(conns[Math.floor(Math.random() * conns.length)]);
  }, 60000 / opts.resetsPerMin);
  return () => clearInterval(timer);
}

// A phone hops from venue Wi-Fi to mobile data: it reconnects right away on
// a new socket, while the server only notices the old one is dead after its
// ping timeout. The team must survive that.
async function runHalfOpen(ctx) {
  console.log(`  ${ctx.halfOpenProxies.length} Team-Handys wechseln das Netz (halboffene Verbindung) …`);
  for (const p of ctx.halfOpenProxies) p.connections().forEach((c) => p.halfOpen(c));
  const waitMs = SERVER_DEAD_SOCKET_DETECTION_MS + ctx.opts.grace + 10000;
  console.log(`  warte ${Math.round(waitMs / 1000)} s (Ping-Timeout des Servers + Karenzzeit) …`);
  await sleep(waitMs);
}

async function runCrash(ctx, rooms) {
  const { rec } = ctx;
  const before = rooms.map((r) => JSON.parse(JSON.stringify(r.mod.state)));
  let snapshotAgeMs = null;
  try { snapshotAgeMs = Date.now() - fs.statSync(SNAPSHOT_FILE).mtimeMs; } catch (e) { /* none written yet */ }
  console.log('  kill -9 auf den Server (letzter Snapshot: ' + (snapshotAgeMs === null ? 'keiner' : 'vor ' + Math.round(snapshotAgeMs / 1000) + ' s') + ') …');
  rec.inc('crash_snapshot_missing', snapshotAgeMs === null ? 1 : 0);
  if (snapshotAgeMs !== null) rec.add('crash_snapshot_age_ms', snapshotAgeMs);

  const killedAt = Date.now();
  ctx.server.proc.kill('SIGKILL');
  await h.waitForEvent(ctx.server.proc, 'exit');
  ctx.server = await startServerFor(ctx.opts);
  rec.add('crash_restart_ms', Date.now() - killedAt);

  const everyone = rooms.flatMap((r) => r.all);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && everyone.some((c) => !c.socket.connected || c.disconnectedAt !== null)) await sleep(100);
  rec.add('crash_recovery_all_ms', Date.now() - killedAt);
  await sleep(1000);

  rooms.forEach((room, i) => {
    const pre = before[i];
    const post = room.mod.state;
    if (!post || post.roomCode !== pre.roomCode) { rec.inc('crash_rooms_lost'); return; }
    for (const [id, team] of Object.entries(pre.teams)) {
      if (!post.teams[id]) { rec.inc('crash_teams_lost'); continue; }
      rec.inc('crash_score_points_lost', Math.max(0, team.score - post.teams[id].score));
    }
    if (post.currentRound !== pre.currentRound || post.gameState !== pre.gameState) rec.inc('crash_rooms_regressed');
  });
}

function startServerFor(opts) {
  return h.startServer({
    port: SERVER_PORT,
    snapshotFile: SNAPSHOT_FILE,
    env: {
      SESSION_SECRET,
      ...(opts.grace ? { TEAM_DISCONNECT_GRACE_MS: String(opts.grace) } : {}),
    },
  });
}

async function startProxies(ctx) {
  const { opts } = ctx;
  const cleanups = [];
  ctx.clientUrl = ctx.server.base;
  if (isDegraded(opts)) {
    ctx.proxy = createNetProxy({ listenPort: PROXY_PORT, targetPort: SERVER_PORT, latencyMs: opts.latency, jitterMs: opts.jitter, kbps: opts.kbps });
    await ctx.proxy.listen();
    cleanups.push(() => ctx.proxy.close());
    ctx.clientUrl = `http://127.0.0.1:${PROXY_PORT}`;
  }
  for (let i = 0; i < opts.halfOpenTeams; i++) {
    const p = createNetProxy({ listenPort: HALFOPEN_PROXY_BASE_PORT + i, targetPort: SERVER_PORT });
    await p.listen();
    ctx.halfOpenProxies.push(p);
    cleanups.push(() => p.close());
  }
  return cleanups;
}

async function runGame(ctx, rooms) {
  const { opts } = ctx;
  const stopResets = startRandomResets(ctx);
  try {
    for (let r = 0; r < opts.rounds; r++) {
      await Promise.all(rooms.map((room) => playRound(ctx, room)));
    }
    if (opts.crash) {
      // 0 = crash right after the round (worst case: newest state not yet
      // snapshotted); >30000 = crash after at least one periodic snapshot.
      if (opts.crashDelay) await sleep(opts.crashDelay);
      await runCrash(ctx, rooms);
      await Promise.all(rooms.map((room) => playRound(ctx, room)));
    }
    if (opts.halfOpenTeams) {
      await runHalfOpen(ctx);
      await Promise.all(rooms.map((room) => playRound(ctx, room)));
    }
  } finally {
    stopResets();
  }
}

async function runStep(opts) {
  const rec = createRecorder();
  h.removeIfExists(SNAPSHOT_FILE);
  const ctx = { opts, rec, halfOpenProxies: [] };
  ctx.server = await startServerFor(opts);
  const sampler = createProcessSampler(() => ctx.server.proc.pid, rec);
  const cleanups = [() => sampler.stop(), startClientLagMonitor(rec)];
  const rooms = [];
  let probe = null;

  try {
    ctx.cookie = await h.login(ctx.server.base);
    cleanups.push(...await startProxies(ctx));

    const codes = [];
    for (let i = 0; i < opts.rooms; i++) codes.push((await h.createRoom(ctx.server.base, ctx.cookie, 'Lasttest ' + i)).body.roomCode);
    const setupStart = Date.now();
    rooms.push(...await Promise.all(codes.map((code, i) => setupRoom(ctx, code, i))));
    rec.add('setup_all_rooms_ms', Date.now() - setupStart);

    // Probe: one Übersicht tab directly on the server (no proxy) that only
    // measures timer-tick regularity, i.e. server-side event-loop lag.
    probe = new SimClient({ url: ctx.server.base, room: codes[0], role: 'overview', cookie: ctx.cookie, recorder: rec, transport: 'websocket' });
    await probe.connect();
    await probe.join();
    probe.measureTicks = true;

    await runGame(ctx, rooms);
    await checkConsistency(ctx, rooms);
  } finally {
    if (probe) probe.close();
    rooms.flatMap((r) => r.all).forEach((c) => c.close());
    for (const fn of cleanups) await fn();
    await h.stopServer(ctx.server);
    h.removeIfExists(SNAPSHOT_FILE);
  }
  if (ctx.proxy) Object.entries(ctx.proxy.stats).forEach(([k, v]) => rec.inc('proxy_' + k, v));
  const devices = opts.rooms * (3 + opts.teams + opts.lurkers);
  return { opts, devices, ...rec.summary() };
}

function evaluate(result) {
  const budget = isDegraded(result.opts) ? BUDGETS.degraded : BUDGETS.clean;
  const checks = [];
  const s = result.series;
  const c = result.counters;
  for (const [name, limit] of Object.entries(budget)) {
    if (s[name]) checks.push({ name: `${name} p95`, value: s[name].p95, limit, ok: s[name].p95 <= limit });
  }
  for (const [key, limit] of Object.entries(BUDGETS.always)) {
    const [, name, p] = key.match(/^(.*)_(p\d+)$/);
    if (s[name]) checks.push({ name: `${name} ${p}`, value: s[name][p], limit, ok: s[name][p] <= limit, warnOnly: name === 'client_loop_lag_ms' });
  }
  for (const name of BUDGETS.zero) {
    const value = c[name] || 0;
    checks.push({ name, value, limit: 0, ok: value === 0 });
  }
  return checks;
}

function printResult(label, result, checks) {
  console.log(`\n── ${label}: ${result.devices} Geräte ──`);
  console.table(Object.entries(result.series).map(([name, v]) => ({ messgroesse: name, ...v })));
  const counters = Object.entries(result.counters).filter(([k]) => k !== 'state_bytes');
  console.log('  Zähler:', Object.fromEntries(counters), `| game_state gesamt: ${((result.counters.state_bytes || 0) / 1024 / 1024).toFixed(1)} MB`);
  for (const ch of checks) {
    const tag = ch.ok ? 'PASS' : ch.warnOnly ? 'WARN' : 'FAIL';
    console.log(`  [${tag}] ${ch.name} = ${ch.value} (Grenze ${ch.limit})`);
  }
  if (checks.some((ch) => ch.warnOnly && !ch.ok)) {
    console.log('  ⚠ Der Lastgenerator selbst war überlastet — Latenzen sind zu hoch gemessen. Clients auf einem zweiten Rechner laufen lassen.');
  }
}

async function main() {
  const { scenario, opts } = parseArgs(process.argv.slice(2));
  const steps = opts.steps ? String(opts.steps).split(',').map(Number) : [opts.rooms];
  console.log(`Szenario "${scenario}"`, JSON.stringify(opts));
  const results = [];
  let failed = false;
  for (const rooms of steps) {
    const result = await runStep({ ...opts, rooms });
    const checks = evaluate(result);
    printResult(`${scenario} / ${rooms} Spielrunde(n)`, result, checks);
    results.push({ ...result, checks });
    if (checks.some((ch) => !ch.ok && !ch.warnOnly)) failed = true;
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ scenario, at: new Date().toISOString(), results }, null, 2));
  console.log(`\nErgebnis gespeichert: ${path.relative(process.cwd(), file)}`);
  console.log(failed ? 'GESAMT: FAIL' : 'GESAMT: PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
