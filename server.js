const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');
const QRCode = require('qrcode');

// ── Secrets from .env ────────────────────────────────────────────
// Passwords and API secrets never live in this file (the repository is
// public). They come from real environment variables, or from a `.env`
// file next to this script that is git-ignored — see `.env.example`.
// Real environment variables win over the file.
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return; // no .env — fine, e.g. when systemd sets the variables itself
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '.env'));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Site password ───────────────────────────────────────────────
// Gates every view except team.html (players need to join without a
// password) and the assets/sockets/APIs every page depends on. Session
// token is derived from a secret that's regenerated on each server start,
// so a restart simply logs everyone out again — no persistence needed.
// Without a configured password the server makes up a random one per start
// and prints it, rather than falling back to a value anyone could read on GitHub.
const SITE_PASSWORD_GENERATED = !process.env.SITE_PASSWORD;
const SITE_PASSWORD = process.env.SITE_PASSWORD || crypto.randomBytes(6).toString('base64url');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_COOKIE = 'hb_auth';
const AUTH_TOKEN = crypto.createHmac('sha256', SESSION_SECRET).update('authenticated').digest('hex');

const PROTECTED_PAGES = new Set([
  '/', '/index.html', '/display.html', '/moderator.html',
  '/overview.html', '/qr.html', '/join-qr.html',
]);
// join.html is deliberately NOT protected — same reasoning as team.html:
// players reach it straight from a scanned QR code, without the site password.

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function isAuthenticated(req) {
  return parseCookies(req)[AUTH_COOKIE] === AUTH_TOKEN;
}

// Guards API routes that change/destroy shared state (creating or closing a
// round) — unlike the page gate above, most of /api/* stays intentionally
// open (e.g. GET /api/rooms, used by the unauthenticated join.html picker).
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Nicht angemeldet' });
}

// Same for routes opened as a page in the browser: back to the login,
// returning to the original URL afterwards.
function requireAuthPage(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
}

app.use((req, res, next) => {
  if (!PROTECTED_PAGES.has(req.path) || isAuthenticated(req)) return next();
  // originalUrl (not path) so a `?room=` on the requested page survives the
  // login round-trip instead of dropping the moderator back into a room-less page.
  res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
});

// Every HTML page gets its /css and /js references (and the Socket.IO
// client) stamped with a version query string that changes on every server
// start. A stamped URL therefore never changes content, so it's served as
// immutable: Cloudflare keeps it at the edge and phones keep it locally,
// instead of every page load going through the tunnel to this server to
// revalidate each file — which hurt most when a whole room scanned the QR
// code at once. Each deploy is a brand-new URL, so fixes still go live
// immediately. Unstamped or outdated URLs stay no-cache.
const ASSET_VERSION = String(Date.now());
const IMMUTABLE = 'public, max-age=31536000, immutable';

function assetCacheControl(req) {
  return req.query.v === ASSET_VERSION ? IMMUTABLE : 'no-cache';
}

// Served from our own path (minified, 47 KB instead of the 156 KB
// unminified build behind /socket.io/socket.io.js) so it gets the same
// versioned, edge-cached treatment as our own scripts.
const SOCKET_IO_CLIENT = path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist', 'socket.io.min.js');

app.get('/vendor/socket.io.min.js', (req, res) => {
  res.set('Cache-Control', assetCacheControl(req));
  res.sendFile(SOCKET_IO_CLIENT);
});

app.use((req, res, next) => {
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  if (!reqPath.endsWith('.html')) return next();
  const filePath = path.join(__dirname, 'public', reqPath);
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next();
    const versioned = html
      .replace('src="/socket.io/socket.io.js"', 'src="/vendor/socket.io.min.js"')
      .replace(
        /(href|src)="(\/(?:css|js|vendor)\/[^"?]+)"/g,
        (m, attr, url) => attr + '="' + url + '?v=' + ASSET_VERSION + '"'
      );
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(versioned);
  });
});

// HTML itself stays no-cache (revalidated via ETag on every load), so a new
// deploy's version stamps reach every device straight away.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', assetCacheControl(res.req)),
}));
app.use(express.json());
console.log('[3] Middleware OK, weiter zu Routes...');

// Constant-time comparison, so response timing reveals nothing about how
// much of a guess was right.
function passwordMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(SITE_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!passwordMatches(password)) return res.status(401).json({ ok: false });

  // No Max-Age: a session cookie, cleared when the browser fully closes —
  // reopening the browser asks for the password again, but a reload or new
  // tab within the same session doesn't log the moderator out mid-game.
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    AUTH_COOKIE + '=' + AUTH_TOKEN
    + '; HttpOnly; Path=/'
    + '; SameSite=Lax' + (isSecure ? '; Secure' : ''));
  res.json({ ok: true });
});

// ── Spotify Config ──────────────────────────────────────────────

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_CONFIGURED = !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
const PORT = process.env.PORT || 3000;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:' + PORT + '/auth/spotify/callback';
// Overridable so tests can point the server at a local fake Spotify API.
const SPOTIFY_API_BASE = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1';

// The countdown only starts once the Beamer's player reports the song is
// actually audible, so a slow venue network doesn't eat into the teams'
// listening time — but never waits longer than this, so a player that
// never reports back can't stall the round (or the auto-moderator) forever.
const PLAYBACK_CONFIRM_TIMEOUT_MS = Number(process.env.PLAYBACK_CONFIRM_TIMEOUT_MS) || 6000;
const SPOTIFY_PLAY_ATTEMPTS = 3;

// Public base URL used to build the join-QR link — same origin players scan
// from their phones, so it has to be the tunnel/public domain, not localhost.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://bingo.hitsterquizshow.de';

// Playlists — Name + Spotify-URL, wählbar in der Moderator-Ansicht. Reine
// Konfiguration, kein Geheimnis — bleibt bewusst global für alle Runden.
// These are just the seed defaults for a brand-new install; as soon as
// anyone adds/removes a playlist via the moderator UI, the persisted file
// (see loadPlaylists further down) takes over.
const SPOTIFY_PLAYLISTS = [
  { id: uuidv4(), name: 'Teenscamp HitsterGameshow 2026', url: 'https://open.spotify.com/playlist/5CF56knZKCMgpfOBz5r0S4?si=CKn55_V1SfGL6anks2hqVg&utm_source=whatsapp&pt=9764aed2b277e286ce2d298fa80145e1' },
  { id: uuidv4(), name: 'Teenscamp Disse 2026', url: 'https://open.spotify.com/playlist/4RTxuCmYBccS5M6rhAWfMd?si=478a56b62e174378' },
];

// ── Game Constants ──────────────────────────────────────────────

const CATEGORIES = [
  { id: 'artist', name: 'Interpret', color: '#ff4d6d', icon: '🎤' },
  { id: 'title', name: 'Titel', color: '#4cc9f0', icon: '🎵' },
  { id: 'decade', name: 'Jahrzehnt', color: '#7209b7', icon: '📅' },
  { id: 'year4', name: 'Jahr ±4', color: '#f72585', icon: '🎯' },
  { id: 'mystery', name: '?', color: '#4361ee', icon: '❓' },
];

const MYSTERY_SUBS = [
  { id: 'band_or_solo', name: 'Band oder Solo?', icon: '🎸', weight: 25 },
  { id: 'before_2000', name: 'Vor 2000?', icon: '📼', weight: 25 },
  { id: 'exact_year', name: 'Genaues Jahr', icon: '📌', weight: 12.5 },
  { id: 'year3', name: 'Jahr ±3', icon: '🔭', weight: 25 },
  { id: 'year2', name: 'Jahr ±2', icon: '🔍', weight: 12.5 },
];

// –– sehr wichtige Konstanten ––––––––––––––––––––––––––––––––––––
const MAX_TEAMS = 10;
const BINGO_SIZE = 5;
const TIMER_SECONDS = 60;
const TEAM_DISCONNECT_GRACE_MS = 450000;

// Vermeidet, dass kurz hintereinander derselbe Song aus derselben Playlist
// gezogen wird — wie Spotifys "kein Wiederholen"-Shuffle. In
// fetchRandomPlaylistTrack auf die tatsächliche Playlistgröße gedeckelt,
// damit kleine Playlists sich nicht selbst blockieren.
const RECENT_TRACK_HISTORY_LIMIT = 15;

// Also drop a room's Spotify connection once nobody has any tab of that
// room open at all. A short grace period tolerates a page reload or brief
// network hiccup (same pattern as team reconnects) without forcing a fresh
// Spotify login mid-show. Overridable so tests don't have to sit through
// the real 20s to verify the behavior.
const SPOTIFY_DISCONNECT_GRACE_MS = Number(process.env.SPOTIFY_DISCONNECT_GRACE_MS) || 20000;

// ── Helper Functions (stateless, shared by every room) ───────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickWeightedRandom(items) {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

// Every card gets exactly BINGO_SIZE cells of each category (same even split
// as the wheel's equal-sized segments), but unlike a Latin square the same
// category may repeat within one row/column/diagonal. To keep any single
// line from being trivially easy (e.g. 4x "Interpret" + 1x "?"), no line may
// contain the same category more than MAX_PER_LINE times. Random shuffling
// with rejection gives each team an independent, unpredictable layout.
const MAX_PER_LINE = 3;

function cardLinesRespectLimit(card) {
  const lines = [];
  for (let r = 0; r < BINGO_SIZE; r++) lines.push(card[r].map(cell => cell.categoryId));
  for (let c = 0; c < BINGO_SIZE; c++) lines.push(card.map(row => row[c].categoryId));
  lines.push(card.map((row, i) => row[i].categoryId));
  lines.push(card.map((row, i) => row[BINGO_SIZE - 1 - i].categoryId));

  return lines.every(line => {
    const counts = {};
    for (const id of line) counts[id] = (counts[id] || 0) + 1;
    return Object.values(counts).every(n => n <= MAX_PER_LINE);
  });
}

function generateBingoCard() {
  const cellsPerCategory = (BINGO_SIZE * BINGO_SIZE) / CATEGORIES.length;
  const pool = [];
  CATEGORIES.forEach(cat => {
    for (let i = 0; i < cellsPerCategory; i++) pool.push(cat.id);
  });

  for (let attempt = 0; attempt < 1000; attempt++) {
    const shuffled = shuffle(pool);
    const card = [];
    for (let r = 0; r < BINGO_SIZE; r++) {
      card.push(shuffled.slice(r * BINGO_SIZE, (r + 1) * BINGO_SIZE)
        .map(categoryId => ({ categoryId, checked: false })));
    }
    if (cardLinesRespectLimit(card)) return card;
  }
  throw new Error('Konnte keine gültige Bingo-Karte generieren');
}

function checkBingo(card) {
  for (let r = 0; r < BINGO_SIZE; r++) {
    if (card[r].every(c => c.checked)) return true;
  }
  for (let c = 0; c < BINGO_SIZE; c++) {
    if (card.every(row => row[c].checked)) return true;
  }
  if (card.every((row, i) => row[i].checked)) return true;
  if (card.every((row, i) => row[BINGO_SIZE - 1 - i].checked)) return true;
  return false;
}

function mapTrack(t) {
  return {
    spotifyUri: t.uri,
    spotifyId: t.id,
    title: t.name,
    artist: t.artists.map(a => a.name).join(', '),
    album: t.album.name,
    year: t.album.release_date?.substring(0, 4) || '',
    cover: t.album.images?.[0]?.url || '',
    previewUrl: t.preview_url,
    durationMs: t.duration_ms,
  };
}

function extractPlaylistId(input) {
  if (!input) return null;
  const match = input.match(/playlist[:/]([a-zA-Z0-9]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9]+$/.test(input.trim())) return input.trim();
  return null;
}

// ── Playlist cache (shared by every room) ───────────────────────────
// Each playlist is loaded once in full and kept for a while, so a random
// song costs no Spotify request at all instead of up to nine sequential
// ones (size lookup + random single-track probes) over the server's uplink.
// Shared across rooms: the playlist content is the same no matter whose
// Spotify login fetched it. Re-fetched after the TTL so edits made in
// Spotify still show up during a long event.
const PLAYLIST_CACHE_TTL_MS = Number(process.env.PLAYLIST_CACHE_TTL_MS) || 30 * 60 * 1000;
const playlistCache = new Map(); // Spotify playlist id -> { tracks, fetchedAt }
const playlistLoads = new Map(); // Spotify playlist id -> in-flight load, shared by concurrent callers

async function fetchAllPlaylistTracks(spotifyPlaylistId, token) {
  const tracks = [];
  let url = SPOTIFY_API_BASE + '/playlists/' + spotifyPlaylistId + '/items?' + querystring.stringify({
    limit: 50, offset: 0, market: 'DE',
    fields: 'next,items(is_local,item(type,name,uri,id,artists(name),album(name,release_date,images),preview_url,duration_ms))',
  });
  while (url) {
    const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw httpError(resp.status, data.error?.message || 'Playlist nicht gefunden');
    for (const entry of data.items || []) {
      const t = entry && entry.item;
      // Skips local files and podcast episodes — neither can be played or quizzed.
      if (!t || entry.is_local || !t.uri || !t.id || (t.type && t.type !== 'track')) continue;
      tracks.push(mapTrack(t));
    }
    url = data.next || null;
  }
  return tracks;
}

async function getPlaylistTracks(spotifyPlaylistId, token) {
  const cached = playlistCache.get(spotifyPlaylistId);
  if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL_MS) return cached.tracks;

  if (!playlistLoads.has(spotifyPlaylistId)) {
    const load = fetchAllPlaylistTracks(spotifyPlaylistId, token)
      .then((tracks) => {
        playlistCache.set(spotifyPlaylistId, { tracks, fetchedAt: Date.now() });
        return tracks;
      })
      .finally(() => playlistLoads.delete(spotifyPlaylistId));
    playlistLoads.set(spotifyPlaylistId, load);
  }
  try {
    return await playlistLoads.get(spotifyPlaylistId);
  } catch (e) {
    // A failed refresh shouldn't break the round while an older copy exists.
    if (cached) return cached.tracks;
    throw e;
  }
}

// Loads every configured playlist in the background right after a Spotify
// login, so even the first random song of the evening comes straight from
// the cache. Failures are ignored here — the next real pick retries.
function warmPlaylistCache(token) {
  for (const p of SPOTIFY_PLAYLISTS) {
    const id = extractPlaylistId(p.url);
    if (id) getPlaylistTracks(id, token).catch(() => {});
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ── Playlists persistence ───────────────────────────────────────────
// Lets organizers add/remove playlists from the moderator UI instead of
// editing server.js for every event. Overridable path so tests don't touch
// the real dev file. Mutated in place (length=0 + push, push, splice) so
// every closure that already captured the SPOTIFY_PLAYLISTS binding — every
// room's fetchRandomPlaylistTrack — sees changes immediately without needing
// to be threaded through separately.
const PLAYLISTS_FILE = process.env.PLAYLISTS_FILE || path.join(__dirname, '.playlists.json');

function savePlaylists() {
  try {
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(SPOTIFY_PLAYLISTS));
  } catch (e) {
    console.error('Playlists konnten nicht gespeichert werden:', e.message);
  }
}

function loadPlaylists() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
  } catch (e) {
    return; // no persisted playlists yet — the hardcoded defaults above stay in effect
  }
  if (Array.isArray(data) && data.length) {
    SPOTIFY_PLAYLISTS.length = 0;
    SPOTIFY_PLAYLISTS.push(...data);
  }
}

loadPlaylists();

// ── Rooms (one independent game each) ─────────────────────────────
// Every group playing at the same time gets its own room: own teams, own
// timer/round state, own auto-moderator loop, own Spotify login. A room is
// never created implicitly (guessing a code never conjures a game) — only
// via POST /api/rooms below.

const sessions = new Map(); // roomCode -> session

// Excludes visually-ambiguous characters (0/O, 1/I) since codes get read
// off a screen and typed/scanned under time pressure.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 5;
const ROOM_EMPTY_TTL_MS = 6 * 60 * 60 * 1000; // auto-remove a room 6h after its last tab closed

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: ROOM_CODE_LENGTH }, () =>
      ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)]
    ).join('');
  } while (sessions.has(code));
  return code;
}

// Encapsulates one room's entire game state as closures — a direct,
// mechanical move of what used to be this file's module-level game state
// and do*() functions, just scoped per room instead of shared globally.
// `restore` (from a disk snapshot after a crash/restart) carries over the
// previous game progress for the same room code — teams, scores, round
// state — everything except Spotify tokens (deliberately never persisted,
// see the Spotify section below) and live socket/timer bookkeeping, which
// gets rebuilt naturally as clients reconnect.
function createSession(roomCode, name, restore) {
  const createdAt = (restore && restore.createdAt) || Date.now();
  // Optional human-friendly label (e.g. "Gruppe Falken") so organizers can
  // tell rounds apart at a glance instead of comparing random codes — purely
  // cosmetic, the room code stays the actual identifier used in URLs/links.
  const roomName = restore ? (restore.roomName || '') : (typeof name === 'string' ? name.trim() : '').slice(0, 40);

  const teams = new Map(restore ? restore.teams : undefined);
  const answers = new Map(restore ? restore.answers : undefined);
  const pendingTeamRemoval = new Map(); // teamId -> Timeout, cancelled on reconnect
  // teamId -> secret only that team's phone knows. Team ids are visible to
  // every device (they key the team list), so resuming a team needs this
  // too — otherwise anyone could take over another team's seat and card.
  // Kept apart from the team objects so it never goes out in game state.
  const teamSecrets = new Map(restore && restore.teamSecrets ? restore.teamSecrets : undefined);
  let gameState = (restore && restore.gameState) || 'lobby';
  let currentRound = (restore && restore.currentRound) || 0;
  let spinToken = (restore && restore.spinToken) || 0;
  let currentCategory = (restore && restore.currentCategory) || null;
  let currentMysterySub = (restore && restore.currentMysterySub) || null;
  let currentSong = (restore && restore.currentSong) || null;
  // Verhindert, dass zwei Runden in Folge dieselbe Kategorie ziehen.
  let lastCategoryId = (restore && restore.lastCategoryId) || null;
  // playlistId -> zuletzt gespielte Spotify-Track-IDs dieser Playlist, damit
  // derselbe Song nicht sofort wieder gezogen wird.
  const recentTracksByPlaylist = new Map(restore && restore.recentTracksByPlaylist ? restore.recentTracksByPlaylist : undefined);
  let timerValue = restore && typeof restore.timerValue === 'number' ? restore.timerValue : TIMER_SECONDS;
  let timerInterval = null;
  // Freezes the countdown + Spotify playback for a "playing" round without
  // losing progress — for a bathroom break or a Spotify hiccup mid-timer,
  // where Reset (which wipes the round) would be way too blunt a tool.
  let paused = (restore && restore.paused) || false;

  // ── Automatischer Moderator ─────────────────────────────────────
  // Never auto-resumes after a restore — it needs a fresh Spotify
  // connection anyway (tokens aren't persisted), so the moderator has to
  // flip it back on manually. The playlist choice is kept as a convenience.
  let autoModeratorEnabled = false;
  let autoModeratorPlaylist = (restore && restore.autoModeratorPlaylist) || null;
  let autoModeratorTimer = null;
  let autoModeratorRetries = 0;
  const AUTO_SPIN_REVEAL_MS = 9000;
  const AUTO_REVEAL_HOLD_MS = 1500;
  const AUTO_REVEAL_DURATION_MS = 20000;
  const AUTO_BETWEEN_ROUNDS_MS = 5000;
  const AUTO_RETRY_MS = 4000;
  const AUTO_MAX_RETRIES = 5;

  // ── Spotify (per room — a Spotify account can only play on one device
  // at a time, so simultaneous rooms need independent logins) ─────
  let spotifyAccessToken = null;
  let spotifyRefreshToken = null;
  let spotifyTokenExpiry = 0;
  let connectedSocketCount = 0;
  let spotifyDisconnectTimer = null;
  let lastEmptyAt = null; // when connectedSocketCount last hit 0 — drives room cleanup

  // ── Beamer player (Web Playback SDK in display.html) ────────────
  // Exactly one Beamer tab per room owns playback: the server talks to
  // Spotify directly with that tab's device id, instead of bouncing every
  // play/pause through the Beamer's browser and back (two fewer trips over
  // the venue network, and no more tabs stealing playback from each other).
  let playerDeviceId = null;
  let playerSocketId = null;
  // Shown on the moderator view until the next song actually plays — lives
  // in game state (not a one-off event) so a reloaded moderator tab sees it too.
  let playerIssue = null;
  // Play/pause commands go out strictly in order — independent requests
  // over a flaky network could otherwise land at Spotify as pause-after-play
  // and silence the new song right away.
  let playerQueue = Promise.resolve();
  let playbackActive = false;
  let awaitingPlayback = false;
  let playbackWaitTimer = null;

  function clearAutoModeratorTimer() {
    if (autoModeratorTimer) {
      clearTimeout(autoModeratorTimer);
      autoModeratorTimer = null;
    }
  }

  // Schedules the next auto-moderator step. Re-checks the flag at fire time
  // (not just now) so toggling auto mode off mid-wait reliably cancels it.
  function scheduleAuto(fn, delayMs) {
    clearAutoModeratorTimer();
    autoModeratorTimer = setTimeout(() => {
      autoModeratorTimer = null;
      if (autoModeratorEnabled) fn();
    }, delayMs);
  }

  function stopAutoModerator(reason) {
    autoModeratorEnabled = false;
    clearAutoModeratorTimer();
    if (reason) io.to('room:' + roomCode).emit('auto_moderator_stopped', { reason });
    broadcast();
  }

  function clearSpotifyDisconnectTimer() {
    if (spotifyDisconnectTimer) {
      clearTimeout(spotifyDisconnectTimer);
      spotifyDisconnectTimer = null;
    }
  }

  function disconnectSpotify() {
    if (!spotifyAccessToken && !spotifyRefreshToken) return;
    spotifyAccessToken = null;
    spotifyRefreshToken = null;
    spotifyTokenExpiry = 0;
    console.log('  [' + roomCode + '] Spotify getrennt: keine offenen Tabs mehr');
    broadcast();
  }

  function registerConnection() {
    connectedSocketCount++;
    lastEmptyAt = null;
    clearSpotifyDisconnectTimer();
  }

  function unregisterConnection() {
    connectedSocketCount--;
    if (connectedSocketCount <= 0) {
      lastEmptyAt = Date.now();
      clearSpotifyDisconnectTimer();
      spotifyDisconnectTimer = setTimeout(() => {
        spotifyDisconnectTimer = null;
        if (connectedSocketCount <= 0) disconnectSpotify();
      }, SPOTIFY_DISCONNECT_GRACE_MS);
    }
  }

  function getFullState() {
    return {
      roomCode,
      roomName,
      gameState,
      teams: Object.fromEntries(teams),
      currentRound,
      spinToken,
      currentCategory,
      currentMysterySub,
      currentSong,
      answers: Object.fromEntries(answers),
      timerValue,
      paused,
      categories: CATEGORIES,
      spotifyReady: !!spotifyAccessToken,
      spotifyPlayerReady: !!playerDeviceId,
      spotifyPlayerIssue: playerIssue,
      awaitingPlayback,
      autoModeratorEnabled,
      autoModeratorPlaylist,
    };
  }

  // ── Per-view state delivery ───────────────────────────────────────
  // Every connected tab gets only what its view actually shows, and only
  // when that changed for it. Before, each tap (an answer, a ticked cell)
  // pushed the whole state — every team's card and every answer — to every
  // device in the room; on a weak venue network that's what made the game
  // feel sluggish, and it let any team read the others' answers.
  const viewers = new Map(); // socket.id -> { socket, role, teamId, lastSent }

  function teamName(t) {
    return { id: t.id, name: t.name, emoji: t.emoji };
  }

  function stateForView(full, role, teamId) {
    if (role === 'moderator') return full;
    const all = [...teams.values()];
    let viewTeams;
    let viewAnswers = {};

    if (role === 'overview') {
      viewTeams = full.teams;
    } else if (role === 'display') {
      // Bingo celebration + lobby list; dots only need whether a team answered.
      viewTeams = Object.fromEntries(all.map((t) => [t.id, { ...teamName(t), hasBingo: t.hasBingo }]));
      for (const id of answers.keys()) viewAnswers[id] = true;
    } else {
      // Team phones (and the team setup screen before joining): own card and
      // answer only; other teams just by name/emoji, so taken ones grey out.
      viewTeams = Object.fromEntries(all.map((t) => [t.id, t.id === teamId ? t : teamName(t)]));
      if (teamId && answers.has(teamId)) viewAnswers[teamId] = answers.get(teamId);
    }
    return { ...full, teams: viewTeams, answers: viewAnswers };
  }

  function sendState(viewer, full, force) {
    const view = stateForView(full, viewer.role, viewer.teamId);
    const json = JSON.stringify(view);
    if (!force && json === viewer.lastSent) return;
    viewer.lastSent = json;
    viewer.socket.emit('game_state', view);
  }

  function broadcast() {
    const full = getFullState();
    for (const viewer of viewers.values()) sendState(viewer, full, false);
  }

  function addViewer(socket) {
    const viewer = { socket, role: null, teamId: null, lastSent: null };
    viewers.set(socket.id, viewer);
    sendState(viewer, getFullState(), true);
  }

  function setViewerRole(socketId, role, teamId) {
    const viewer = viewers.get(socketId);
    if (!viewer) return;
    viewer.role = role;
    viewer.teamId = teamId || null;
    sendState(viewer, getFullState(), true);
  }

  function removeViewer(socketId) {
    viewers.delete(socketId);
  }

  function clearTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (playbackWaitTimer) {
      clearTimeout(playbackWaitTimer);
      playbackWaitTimer = null;
    }
    awaitingPlayback = false;
  }

  function startTimer() {
    clearTimer();
    timerInterval = setInterval(() => {
      timerValue--;
      io.to('room:' + roomCode).emit('timer_tick', timerValue);
      if (timerValue <= 0) {
        clearTimer();
        stopPlayback();
        broadcast();
        if (autoModeratorEnabled) scheduleAuto(doRevealSolution, AUTO_REVEAL_HOLD_MS);
      }
    }, 1000);
  }

  // Freezes the countdown + Spotify at the current timerValue instead of
  // resetting/advancing anything — for a technical interruption mid-round
  // (bathroom break, Spotify hiccup) where the moderator wants to pick up
  // exactly where the round left off. Only meaningful during 'playing';
  // every other gameState either has no running timer or is itself already
  // a natural pause point.
  function pauseGame() {
    if (gameState !== 'playing' || paused) return;
    paused = true;
    clearTimer();
    stopPlayback();
    broadcast();
  }

  function resumeGame() {
    if (!paused) return;
    paused = false;
    // Continues the song where it was paused instead of restarting it.
    if (gameState === 'playing') startRoundAudio({ resume: true });
    broadcast();
  }

  // ── Spotify OAuth (per room) ────────────────────────────────────

  async function refreshSpotifyToken() {
    if (!spotifyRefreshToken) return false;
    try {
      const resp = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'),
        },
        body: querystring.stringify({
          grant_type: 'refresh_token',
          refresh_token: spotifyRefreshToken,
        }),
      });
      const data = await resp.json();
      if (data.access_token) {
        spotifyAccessToken = data.access_token;
        spotifyTokenExpiry = Date.now() + data.expires_in * 1000;
        if (data.refresh_token) spotifyRefreshToken = data.refresh_token;
        return true;
      }
    } catch (e) {
      console.error('Spotify token refresh failed:', e.message);
    }
    return false;
  }

  async function getValidToken() {
    if (!spotifyAccessToken) return null;
    if (Date.now() > spotifyTokenExpiry - 60000) {
      await refreshSpotifyToken();
    }
    return spotifyAccessToken;
  }

  function setSpotifyTokens(accessToken, refreshToken, expiresIn) {
    spotifyAccessToken = accessToken;
    spotifyRefreshToken = refreshToken;
    spotifyTokenExpiry = Date.now() + expiresIn * 1000;
    broadcast();
  }

  // ── Beamer playback ─────────────────────────────────────────────

  function setPlayerIssue(message) {
    if (playerIssue === message) return;
    playerIssue = message;
    broadcast();
  }

  // The newest Beamer tab wins; an older one is told to release its player
  // so the two don't keep grabbing playback from each other.
  function registerPlayer(socketId, deviceId) {
    if (playerSocketId && playerSocketId !== socketId) {
      io.to(playerSocketId).emit('spotify_player_replaced');
    }
    playerSocketId = socketId;
    playerDeviceId = deviceId;
    playbackActive = false;
    playerIssue = null;
    broadcast();
  }

  function unregisterPlayer(socketId) {
    if (socketId !== playerSocketId) return;
    playerSocketId = null;
    playerDeviceId = null;
    playbackActive = false;
    broadcast();
  }

  function queuePlayerCommand(task) {
    const run = playerQueue.then(task, task);
    playerQueue = run.catch(() => {});
    return run;
  }

  // One PUT to Spotify's player API for the registered Beamer device, retried
  // on failure — right after the SDK connects, Spotify often answers 404
  // "Device not found" for a moment, and venue networks drop requests.
  async function sendPlayerCommand(action, body, attempts) {
    let lastError = 'Unbekannter Fehler';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const token = await getValidToken();
      if (!token) return { ok: false, message: 'Spotify ist nicht verbunden.' };
      if (!playerDeviceId) return { ok: false, message: 'Kein Beamer-Player bereit — Beamer-Seite öffnen bzw. neu laden.' };
      try {
        const resp = await fetch(SPOTIFY_API_BASE + '/me/player/' + action + '?device_id=' + encodeURIComponent(playerDeviceId), {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (resp.ok) return { ok: true };
        const data = await resp.json().catch(() => ({}));
        lastError = 'Spotify ' + resp.status + ': ' + (data.error?.message || resp.statusText);
        if (resp.status === 401) await refreshSpotifyToken();
        // 403 = Premium missing or a restriction (e.g. already paused) — retrying won't help.
        if (resp.status === 403) break;
      } catch (e) {
        lastError = 'Spotify nicht erreichbar: ' + e.message;
      }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
    return { ok: false, message: lastError };
  }

  function startPlayback(uri) {
    playbackActive = true;
    return queuePlayerCommand(() => sendPlayerCommand('play', uri ? { uris: [uri] } : null, SPOTIFY_PLAY_ATTEMPTS));
  }

  function stopPlayback() {
    if (!playbackActive || !playerDeviceId) return;
    playbackActive = false;
    queuePlayerCommand(() => sendPlayerCommand('pause', null, 2)).then((res) => {
      if (!res.ok) console.log('  [' + roomCode + '] Pause fehlgeschlagen: ' + res.message);
    });
  }

  function beginCountdown() {
    if (!awaitingPlayback) return;
    startTimer(); // also clears awaitingPlayback + the fallback timeout
    broadcast();
  }

  // Starts the current song on the Beamer and the countdown once it's
  // audible. Without a Spotify song (manual entry) or without a Beamer player
  // the countdown starts right away — the round must never hang on audio.
  function startRoundAudio({ resume = false } = {}) {
    clearTimer();
    const uri = currentSong && currentSong.spotifyUri;
    if (!uri) { startTimer(); return; }
    if (!playerDeviceId) {
      setPlayerIssue('Kein Beamer-Player bereit — der Song läuft nicht. Beamer-Seite öffnen bzw. neu laden.');
      startTimer();
      return;
    }

    awaitingPlayback = true;
    playbackWaitTimer = setTimeout(() => {
      playbackWaitTimer = null;
      beginCountdown();
    }, PLAYBACK_CONFIRM_TIMEOUT_MS);

    const expectedSong = currentSong;
    startPlayback(resume ? null : uri).then((res) => {
      if (res.ok || currentSong !== expectedSong) return;
      setPlayerIssue('Song konnte nicht abgespielt werden (' + res.message + ')');
      beginCountdown();
    });
  }

  // Reported by the Beamer's SDK once a track is audibly playing. Matches on
  // URI so a late report from the previous song can't start this round's clock.
  function confirmPlayback(socketId, uris) {
    if (socketId !== playerSocketId || !currentSong || !Array.isArray(uris)) return;
    if (!uris.includes(currentSong.spotifyUri)) return;
    const hadIssue = !!playerIssue;
    playerIssue = null;
    if (awaitingPlayback) beginCountdown();
    else if (hadIssue) broadcast();
  }

  function rememberPlayedTrack(playlistId, trackId, cap) {
    const history = recentTracksByPlaylist.get(playlistId) || [];
    history.push(trackId);
    while (history.length > cap) history.shift();
    recentTracksByPlaylist.set(playlistId, history);
  }

  // Shared by the moderator's "Zufälliger Song" button and the automatic
  // moderator loop, so both pick songs the exact same way.
  async function fetchRandomPlaylistTrack(wantedId) {
    const token = await getValidToken();
    if (!token) throw httpError(401, 'Nicht mit Spotify verbunden');

    const playlist = SPOTIFY_PLAYLISTS.find((p) => p.id === wantedId) || SPOTIFY_PLAYLISTS[0];
    const playlistId = extractPlaylistId(playlist?.url);
    if (!playlistId) throw httpError(400, 'Keine Playlist hinterlegt — bitte in der Moderation eine hinzufügen.');

    const tracks = await getPlaylistTracks(playlistId, token);
    if (!tracks.length) throw httpError(404, 'Playlist ist leer oder enthält keine abspielbaren Songs.');

    // Songs, die zuletzt aus derselben Playlist gezogen wurden, werden
    // übersprungen — gedeckelt auf die Playlistgröße, damit eine kleine
    // Playlist sich nicht selbst blockiert.
    const historyCap = Math.max(0, Math.min(RECENT_TRACK_HISTORY_LIMIT, tracks.length - 1));
    const recent = historyCap > 0 ? (recentTracksByPlaylist.get(playlist.id) || []).slice(-historyCap) : [];
    const fresh = tracks.filter((t) => !recent.includes(t.spotifyId));
    const pool = fresh.length ? fresh : tracks;

    const track = pool[Math.floor(Math.random() * pool.length)];
    rememberPlayedTrack(playlist.id, track.spotifyId, historyCap);
    return { ...track };
  }

  // ── Round actions ────────────────────────────────────────────────
  // Shared by the socket handlers (manual/moderator-triggered) and the
  // automatic moderator loop below, so both drive the exact same state
  // transitions instead of duplicating the logic.

  // Schließt die zuletzt gezogene Kategorie aus, damit z.B. "Mystery" nicht
  // zwei Runden in Folge (oder öfter) kommt.
  function pickCategory() {
    const pool = lastCategoryId ? CATEGORIES.filter((c) => c.id !== lastCategoryId) : CATEGORIES;
    const cat = pool[Math.floor(Math.random() * pool.length)];
    lastCategoryId = cat.id;
    return cat;
  }

  function doStartSpin() {
    paused = false;
    gameState = 'spinning';
    spinToken++;
    currentCategory = pickCategory();
    currentMysterySub = currentCategory.id === 'mystery' ? pickWeightedRandom(MYSTERY_SUBS) : null;
    answers.clear();
    broadcast();

    if (autoModeratorEnabled) {
      autoModeratorRetries = 0;
      scheduleAuto(doAutoPickSong, AUTO_SPIN_REVEAL_MS);
    }
  }

  function doSetSong(song) {
    paused = false;
    currentSong = song;
    gameState = 'playing';
    timerValue = TIMER_SECONDS;
    startRoundAudio();
    broadcast();
  }

  async function doAutoPickSong() {
    if (!autoModeratorEnabled) return;
    try {
      const track = await fetchRandomPlaylistTrack(autoModeratorPlaylist);
      autoModeratorRetries = 0;
      doSetSong({
        title: track.title,
        artist: track.artist,
        year: track.year,
        spotifyUri: track.spotifyUri,
        cover: track.cover,
      });
    } catch (e) {
      autoModeratorRetries++;
      if (autoModeratorRetries >= AUTO_MAX_RETRIES) {
        autoModeratorRetries = 0;
        stopAutoModerator('Konnte keinen Song laden: ' + e.message);
        return;
      }
      scheduleAuto(doAutoPickSong, AUTO_RETRY_MS);
    }
  }

  function doRevealSolution() {
    paused = false;
    clearTimer();
    gameState = 'revealing';
    stopPlayback();
    broadcast();

    if (autoModeratorEnabled) scheduleAuto(doNextRound, AUTO_REVEAL_DURATION_MS);
  }

  function doRedrawCategory() {
    paused = false;
    clearTimer();
    spinToken++;
    currentCategory = pickCategory();
    currentMysterySub = currentCategory.id === 'mystery' ? pickWeightedRandom(MYSTERY_SUBS) : null;
    currentSong = null;
    answers.clear();
    gameState = 'spinning';
    stopPlayback();
    broadcast();

    if (autoModeratorEnabled) {
      autoModeratorRetries = 0;
      scheduleAuto(doAutoPickSong, AUTO_SPIN_REVEAL_MS);
    }
  }

  function doNextRound() {
    paused = false;
    currentRound++;
    currentCategory = null;
    currentMysterySub = null;
    currentSong = null;
    answers.clear();
    gameState = 'between_rounds';
    broadcast();

    if (autoModeratorEnabled) scheduleAuto(doStartSpin, AUTO_BETWEEN_ROUNDS_MS);
  }

  function doResetGame() {
    paused = false;
    clearTimer();
    currentRound = 0;
    currentCategory = null;
    currentMysterySub = null;
    currentSong = null;
    lastCategoryId = null;
    answers.clear();
    gameState = 'lobby';
    for (const [, team] of teams) {
      team.bingoCard = generateBingoCard();
      team.score = 0;
      team.hasBingo = false;
    }
    stopPlayback();
    broadcast();

    if (autoModeratorEnabled) scheduleAuto(doStartSpin, AUTO_BETWEEN_ROUNDS_MS);
  }

  // ── Socket-facing operations ────────────────────────────────────

  // Validate before the team exists so a rejected name/emoji never leaves a
  // half-created team with a placeholder name behind. Resuming (reload/
  // network hiccup) needs no validation — just cancels the pending removal.
  function resolveTeamJoin(data) {
    let teamId = data.teamId;
    const resuming = teamId && teams.has(teamId);

    // Teams restored from an older snapshot have no secret yet — those may
    // still resume by id alone, once, and get one now.
    if (resuming && teamSecrets.has(teamId) && data.teamSecret !== teamSecrets.get(teamId)) {
      return { ok: false, message: 'Dieses Team ist auf einem anderen Gerät angemeldet.' };
    }

    if (resuming) {
      if (!teamSecrets.has(teamId)) teamSecrets.set(teamId, crypto.randomBytes(16).toString('hex'));
      const pending = pendingTeamRemoval.get(teamId);
      if (pending) {
        clearTimeout(pending);
        pendingTeamRemoval.delete(teamId);
      }
      return { ok: true, teamId };
    }

    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const emoji = data.emoji || '🚀';

    if (!name) return { ok: false, message: 'Teamname fehlt.' };
    if (teams.size >= MAX_TEAMS) return { ok: false, message: 'Maximale Teamanzahl erreicht' };

    const nameTaken = [...teams.values()].some(
      (t) => t.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (nameTaken) return { ok: false, field: 'name', message: 'Dieser Teamname ist bereits vergeben.' };

    const emojiTaken = [...teams.values()].some((t) => t.emoji === emoji);
    if (emojiTaken) return { ok: false, field: 'emoji', message: 'Dieses Emoji ist bereits vergeben.' };

    teamId = uuidv4();
    teamSecrets.set(teamId, crypto.randomBytes(16).toString('hex'));
    teams.set(teamId, {
      id: teamId,
      name,
      emoji,
      bingoCard: generateBingoCard(),
      score: 0,
      hasBingo: false,
    });
    return { ok: true, teamId };
  }

  // Don't remove immediately — a page reload or brief network drop also
  // fires 'disconnect' and would otherwise wipe a still-playing team. The
  // 'join' resume path (resolveTeamJoin above) cancels this if the same
  // team reconnects in time.
  function handleTeamDisconnect(teamId) {
    const timer = setTimeout(() => {
      pendingTeamRemoval.delete(teamId);
      if (!teams.has(teamId)) return;
      teams.delete(teamId);
      teamSecrets.delete(teamId);
      answers.delete(teamId);
      broadcast();
    }, TEAM_DISCONNECT_GRACE_MS);
    pendingTeamRemoval.set(teamId, timer);
  }

  function submitAnswer(teamId, answer) {
    if (gameState !== 'playing' || paused) return;
    answers.set(teamId, answer);
    broadcast();
  }

  function markCorrect(teamId, row, col) {
    const team = teams.get(teamId);
    if (!team) return;
    const cell = team.bingoCard[row][col];
    cell.checked = !cell.checked;
    team.score = team.bingoCard.flat().filter(c => c.checked).length;
    team.hasBingo = checkBingo(team.bingoCard);
    broadcast();
  }

  function kickTeam(teamId) {
    if (!teams.has(teamId)) return;
    const pending = pendingTeamRemoval.get(teamId);
    if (pending) {
      clearTimeout(pending);
      pendingTeamRemoval.delete(teamId);
    }
    teams.delete(teamId);
    teamSecrets.delete(teamId);
    answers.delete(teamId);
    io.to('team_' + teamId).emit('kicked');
    broadcast();
  }

  // Turns the automatic moderator loop on/off. While enabled, the server
  // itself drives start_spin → auto-picked song → timer → reveal_solution →
  // next_round in a loop, so the host can join as a team on their phone
  // instead of operating this screen.
  async function setAutoModerator(enabled, playlistId) {
    if (!enabled) {
      autoModeratorEnabled = false;
      clearAutoModeratorTimer();
      broadcast();
      return { ok: true };
    }

    const token = await getValidToken();
    if (!token) {
      return { ok: false, message: 'Spotify muss verbunden sein, damit der automatische Moderator Songs auswählen kann.' };
    }

    if (playlistId && SPOTIFY_PLAYLISTS.some((p) => p.id === playlistId)) {
      autoModeratorPlaylist = playlistId;
    }
    autoModeratorEnabled = true;
    autoModeratorRetries = 0;
    broadcast();

    // Resume the loop from wherever the game currently stands.
    clearAutoModeratorTimer();
    if (gameState === 'lobby' || gameState === 'between_rounds') {
      scheduleAuto(doStartSpin, 1500);
    } else if (gameState === 'spinning') {
      scheduleAuto(doAutoPickSong, AUTO_SPIN_REVEAL_MS);
    } else if (gameState === 'revealing') {
      scheduleAuto(doNextRound, AUTO_REVEAL_DURATION_MS);
    }
    // gameState === 'playing': the running timer's own zero-check already
    // schedules doRevealSolution once it hits 0, nothing to do here.
    return { ok: true };
  }

  function close() {
    clearTimer();
    clearAutoModeratorTimer();
    clearSpotifyDisconnectTimer();
    io.to('room:' + roomCode).emit('room_closed');
  }

  // Everything needed to reconstruct this room after a restart — no Spotify
  // tokens, no live socket/timer handles, just the game progress itself.
  function snapshot() {
    return {
      roomCode,
      roomName,
      createdAt,
      teams: [...teams.entries()],
      teamSecrets: [...teamSecrets.entries()],
      answers: [...answers.entries()],
      gameState,
      currentRound,
      spinToken,
      currentCategory,
      currentMysterySub,
      currentSong,
      timerValue,
      paused,
      autoModeratorPlaylist,
      lastCategoryId,
      recentTracksByPlaylist: [...recentTracksByPlaylist.entries()],
    };
  }

  // A round mid-song when the crash happened resumes ticking down from the
  // saved value once restored — the only piece of state that can't just sit
  // there inert, since its progress lived in a setInterval that died with
  // the process. Every other gameState is static and just gets served as-is
  // to whoever reconnects next. A paused round stays paused — the countdown
  // shouldn't silently resume behind the moderator's back after a restart.
  if (restore && gameState === 'playing' && !paused) {
    startTimer();
  }

  return {
    roomCode,
    roomName,
    createdAt,
    teams,
    get gameState() { return gameState; },
    get connectedSocketCount() { return connectedSocketCount; },
    get lastEmptyAt() { return lastEmptyAt; },
    getFullState,
    broadcast,
    snapshot,
    registerConnection,
    unregisterConnection,
    addViewer,
    setViewerRole,
    removeViewer,
    resolveTeamJoin,
    teamSecretFor: (teamId) => teamSecrets.get(teamId),
    handleTeamDisconnect,
    submitAnswer,
    markCorrect,
    kickTeam,
    setAutoModerator,
    clearAutoModeratorTimer,
    doStartSpin,
    doSetSong,
    doRevealSolution,
    doRedrawCategory,
    doNextRound,
    doResetGame,
    pauseGame,
    resumeGame,
    getValidToken,
    fetchRandomPlaylistTrack,
    setSpotifyTokens,
    registerPlayer,
    unregisterPlayer,
    confirmPlayback,
    setPlayerIssue,
    close,
  };
}

// ── Crash recovery ─────────────────────────────────────────────────
// Everything lives in memory, so a crash or redeploy would otherwise wipe
// every running round. A periodic snapshot to disk (teams, scores, round
// state — deliberately never Spotify tokens, see createSession) means the
// worst case is losing the last ~30s of progress instead of the whole event.

// Overridable so parallel test runs (each spawning their own server) don't
// clobber each other's or the real dev snapshot on disk.
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || path.join(__dirname, '.rooms-snapshot.json');
const SNAPSHOT_INTERVAL_MS = 30000;

function snapshotSessions() {
  try {
    const data = [...sessions.values()].map((s) => s.snapshot());
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('Snapshot fehlgeschlagen:', e.message);
  }
}

function loadSnapshot() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch (e) {
    return; // no snapshot yet — normal on first start
  }
  for (const roomData of data) {
    sessions.set(roomData.roomCode, createSession(roomData.roomCode, roomData.roomName, roomData));
  }
  if (data.length) console.log('  ' + data.length + ' Runde(n) aus Snapshot wiederhergestellt (Spotify muss pro Runde neu verbunden werden)');
}

loadSnapshot();
setInterval(snapshotSessions, SNAPSHOT_INTERVAL_MS);

// Catch a clean redeploy/restart too, not just crashes.
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    snapshotSessions();
    process.exit(0);
  });
});

// Removes rooms nobody has had open for a long time so a multi-day event
// doesn't slowly accumulate abandoned sessions in memory.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, session] of sessions) {
    if (session.connectedSocketCount === 0 && session.lastEmptyAt && now - session.lastEmptyAt > ROOM_EMPTY_TTL_MS) {
      session.close();
      sessions.delete(code);
      changed = true;
      console.log('  Runde ' + code + ' wegen Inaktivität entfernt');
    }
  }
  if (changed) snapshotSessions();
}, 10 * 60 * 1000);

// ── Room management API ───────────────────────────────────────────

app.post('/api/rooms', requireAuth, (req, res) => {
  const roomCode = generateRoomCode();
  const name = req.body && req.body.name;
  const session = createSession(roomCode, name);
  sessions.set(roomCode, session);
  snapshotSessions();
  res.json({ roomCode, roomName: session.roomName });
});

app.get('/api/rooms', (req, res) => {
  const rooms = [...sessions.values()].map((s) => ({
    roomCode: s.roomCode,
    roomName: s.roomName,
    createdAt: s.createdAt,
    teamCount: s.teams.size,
    gameState: s.gameState,
  })).sort((a, b) => a.createdAt - b.createdAt);
  res.json({ rooms });
});

app.delete('/api/rooms/:code', requireAuth, (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Runde nicht gefunden' });
  session.close();
  sessions.delete(req.params.code);
  snapshotSessions();
  res.json({ ok: true });
});

// ── Join QR code ────────────────────────────────────────────────

// Without `room`, generates a QR for the generic /join.html picker instead
// of a specific round — same code scanned all event long, the player picks
// their round on the page itself instead of the code being baked into the link.
app.get('/api/join-qr', async (req, res) => {
  const roomCode = req.query.room;
  if (roomCode && !sessions.has(roomCode)) {
    return res.status(404).json({ error: 'Unbekannte Runde' });
  }
  try {
    const joinUrl = roomCode
      ? PUBLIC_BASE_URL + '/team.html?room=' + encodeURIComponent(roomCode)
      : PUBLIC_BASE_URL + '/join.html';
    const png = await QRCode.toBuffer(joinUrl, { width: 400, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', roomCode ? 'no-store' : 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ── Spotify OAuth ───────────────────────────────────────────────

app.get('/auth/spotify/debug', requireAuthPage, (req, res) => {
  const scopes = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state playlist-read-private playlist-read-collaborative';
  const authUrl = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    show_dialog: true,
  });
  res.send('<html><body style="background:#0a0e27;color:#e0e6ff;font-family:monospace;padding:2rem">'
    + '<h2 style="color:#4cc9f0">Spotify Debug</h2>'
    + '<p><b>redirect_uri im Code:</b></p>'
    + '<pre style="background:#131838;padding:1rem;border-radius:8px;user-select:all;color:#ffd60a">' + SPOTIFY_REDIRECT_URI + '</pre>'
    + '<p style="margin-top:1rem">Kopiere die URI oben und trage sie <b>exakt so</b> im Spotify Dashboard ein.</p>'
    + '<p style="margin-top:1rem"><a href="' + authUrl + '" style="color:#06d6a0">→ Weiter zu Spotify Auth</a></p>'
    + '</body></html>');
});

app.get('/auth/spotify', requireAuthPage, (req, res) => {
  const roomCode = req.query.room;
  if (!roomCode || !sessions.has(roomCode)) {
    return res.status(404).send('Unbekannte Runde. Bitte den Verbinden-Link erneut über die Moderationsseite öffnen.');
  }
  if (!SPOTIFY_CONFIGURED) {
    return res.status(500).send('Spotify ist nicht eingerichtet: SPOTIFY_CLIENT_ID und SPOTIFY_CLIENT_SECRET in der .env-Datei des Servers eintragen (siehe .env.example) und den Server neu starten.');
  }
  const scopes = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state playlist-read-private playlist-read-collaborative';
  const authUrl = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    show_dialog: true,
    state: roomCode,
  });
  res.redirect(authUrl);
});

app.get('/auth/spotify/callback', async (req, res) => {
  // Only the signed-in moderator who started the login may attach a Spotify
  // account to a round — Spotify redirects back in that same browser.
  if (!isAuthenticated(req)) return res.status(401).send('Nicht angemeldet. Bitte zuerst auf der Moderationsseite einloggen und Spotify von dort aus verbinden.');
  const { code, error, state } = req.query;
  if (error) return res.send('Spotify Auth Fehler: ' + error);
  if (!code) return res.send('Kein Code erhalten');

  const session = state && sessions.get(state);
  if (!session) return res.send('Runde nicht mehr aktiv. Bitte erneut über die Moderationsseite dieser Runde verbinden.');

  try {
    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'),
      },
      body: querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
    });
    const data = await resp.json();
    if (data.error) return res.send('Token-Fehler: ' + data.error_description);

    session.setSpotifyTokens(data.access_token, data.refresh_token, data.expires_in);
    warmPlaylistCache(data.access_token);
    res.send('<html><body style="background:#0a0e27;color:#4cc9f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;font-size:1.5rem"><div style="text-align:center">✅ Spotify verbunden!<br><br><small style="color:#8892b0">Du kannst dieses Fenster schließen.</small></div></body></html>');
  } catch (e) {
    res.status(500).send('Fehler: ' + e.message);
  }
});

function requireSession(req, res) {
  const session = sessions.get(req.query.room);
  if (!session) {
    res.status(404).json({ error: 'Unbekannte oder keine Runde angegeben' });
    return null;
  }
  return session;
}

// Test-only seam: real Spotify OAuth needs a live account, which tests
// don't have — this lets the disconnect-on-empty-room test put a room into
// a "connected" state without one. Only registered when a test explicitly
// opts in, so it doesn't exist as a route at all in normal/production runs.
if (process.env.ENABLE_TEST_HOOKS === '1') {
  app.post('/api/test/seed-spotify-token/:room', (req, res) => {
    const session = sessions.get(req.params.room);
    if (!session) return res.status(404).json({ error: 'Unbekannte Runde' });
    session.setSpotifyTokens('test-fake-access-token', 'test-fake-refresh-token', 3600);
    res.json({ ok: true });
  });
}

// Spotify API proxy: the client gets the token to init the Web Playback SDK
app.get('/api/spotify/token', requireAuth, async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const token = await session.getValidToken();
  res.json({ token: token || null });
});

app.get('/api/spotify/search', requireAuth, async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const token = await session.getValidToken();
  if (!token) return res.status(401).json({ error: 'Nicht mit Spotify verbunden' });

  const q = req.query.q;
  if (!q) return res.json({ tracks: [] });

  try {
    const resp = await fetch(SPOTIFY_API_BASE + '/search?' + querystring.stringify({
      q, type: 'track', market: 'DE', limit: 10,
    }), {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await resp.json();
    const tracks = (data.tracks?.items || []).map(mapTrack);
    res.json({ tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Static config, no session needed — same playlist list offered to every room.
app.get('/api/spotify/playlists', (req, res) => {
  res.json({ playlists: SPOTIFY_PLAYLISTS.map((p) => ({ id: p.id, name: p.name })) });
});

// Lets a moderator add a playlist from the UI instead of editing server.js.
app.post('/api/spotify/playlists', requireAuth, (req, res) => {
  const name = (req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '').slice(0, 60);
  const url = req.body && req.body.url;
  if (!name) return res.status(400).json({ error: 'Name fehlt.' });
  if (!extractPlaylistId(url)) return res.status(400).json({ error: 'Keine gültige Spotify-Playlist-URL.' });

  SPOTIFY_PLAYLISTS.push({ id: uuidv4(), name, url });
  savePlaylists();
  res.json({ playlists: SPOTIFY_PLAYLISTS.map((p) => ({ id: p.id, name: p.name })) });
});

app.delete('/api/spotify/playlists/:id', requireAuth, (req, res) => {
  const idx = SPOTIFY_PLAYLISTS.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  if (SPOTIFY_PLAYLISTS.length === 1) return res.status(400).json({ error: 'Mindestens eine Playlist muss übrig bleiben.' });
  SPOTIFY_PLAYLISTS.splice(idx, 1);
  savePlaylists();
  res.json({ playlists: SPOTIFY_PLAYLISTS.map((p) => ({ id: p.id, name: p.name })) });
});

app.get('/api/spotify/playlist-random', requireAuth, async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const track = await session.fetchRandomPlaylistTrack(req.query.playlist);
    res.json({ track });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Socket.IO ───────────────────────────────────────────────────

const STAFF_ROLES = new Set(['moderator', 'display', 'overview']);

function isCellIndex(n) {
  return Number.isInteger(n) && n >= 0 && n < BINGO_SIZE;
}

// Only plain strings of sane length reach the game state — a malformed
// payload must never be able to crash the server or inject odd values.
function sanitizeSong(song) {
  if (!song || typeof song !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const clean = {
    title: str(song.title, 200),
    artist: str(song.artist, 200),
    year: str(song.year, 10),
    spotifyUri: typeof song.spotifyUri === 'string' && /^spotify:track:[A-Za-z0-9]+$/.test(song.spotifyUri) ? song.spotifyUri : null,
    cover: typeof song.cover === 'string' && /^https:\/\//.test(song.cover) ? song.cover.slice(0, 500) : null,
  };
  return clean.title && clean.artist ? clean : null;
}
// Which room a socket belongs to is fixed at connection time via the
// `room` handshake query param (see shared.js's connectSocket()) — every
// view already knows its own room from its own URL before it ever opens a
// socket, so the server can resolve (and validate) the session immediately,
// without waiting for a 'join'. That's what lets e.g. the team setup screen
// see already-taken names/emojis live, before the player has joined at all.

io.on('connection', (socket) => {
  const roomCode = socket.handshake.query.room;
  const session = roomCode && sessions.get(roomCode);

  console.log('Client connected:', socket.id, 'room:', roomCode || '(none)');

  if (!session) {
    socket.emit('invalid_room');
    return;
  }

  // Signed in with the site password (same cookie as the protected pages).
  // Only such sockets may run the show; everyone who merely knows the room
  // code — every team does — could otherwise pose as the moderator, read
  // all answers, or reset the round from the browser console.
  socket.isStaff = isAuthenticated(socket.request);

  socket.roomCode = roomCode;
  session.registerConnection();
  socket.join('room:' + roomCode);
  session.addViewer(socket);

  // Wraps a handler that only signed-in views may trigger; anything else is
  // dropped, with an explanation if the client asked for an acknowledgement.
  function staffOnly(handler) {
    return (...args) => {
      if (socket.isStaff) return handler(...args);
      const ack = args.find((a) => typeof a === 'function');
      if (ack) ack({ ok: false, auth: true, message: 'Nicht angemeldet — bitte neu einloggen.' });
    };
  }

  socket.on('join', (data, ack) => {
    const { role } = data || {};
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    let teamId;

    if (STAFF_ROLES.has(role)) {
      if (!socket.isStaff) { reply({ ok: false, auth: true, message: 'Nicht angemeldet — bitte neu einloggen.' }); return; }
    } else if (role === 'team') {
      const result = session.resolveTeamJoin(data);
      if (!result.ok) { reply(result); return; }
      teamId = result.teamId;
      socket.join('team_' + teamId);
      socket.teamId = teamId;
    } else {
      reply({ ok: false, message: 'Unbekannte Rolle' });
      return;
    }

    socket.join(role);
    session.setViewerRole(socket.id, role, teamId);
    session.broadcast();
    reply(role === 'team'
      ? { ok: true, teamId, teamSecret: session.teamSecretFor(teamId) }
      : { ok: true });
  });

  socket.on('start_spin', staffOnly(() => {
    session.clearAutoModeratorTimer();
    session.doStartSpin();
  }));

  socket.on('set_song', staffOnly((song) => {
    const clean = sanitizeSong(song);
    if (!clean) return;
    session.clearAutoModeratorTimer();
    session.doSetSong(clean);
  }));

  // A team always answers for itself — the teamId in the payload is ignored.
  socket.on('submit_answer', (data) => {
    if (!socket.teamId || !data || typeof data.answer !== 'string') return;
    const answer = data.answer.trim().slice(0, 200);
    if (answer) session.submitAnswer(socket.teamId, answer);
  });

  socket.on('pause_game', staffOnly(() => {
    session.pauseGame();
  }));

  socket.on('resume_game', staffOnly(() => {
    session.resumeGame();
  }));

  socket.on('reveal_solution', staffOnly(() => {
    session.clearAutoModeratorTimer();
    session.doRevealSolution();
  }));

  socket.on('set_auto_moderator', staffOnly(async (data, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    const result = await session.setAutoModerator(!!(data && data.enabled), data && data.playlist);
    reply(result);
  }));

  // Teams tick their own card; the moderator may correct any team's.
  socket.on('mark_correct', (data) => {
    if (!data || !isCellIndex(data.row) || !isCellIndex(data.col)) return;
    const teamId = socket.isStaff ? data.teamId : socket.teamId;
    if (!teamId || (!socket.isStaff && data.teamId !== socket.teamId)) return;
    session.markCorrect(teamId, data.row, data.col);
  });

  socket.on('kick_team', staffOnly((data) => {
    if (data && typeof data.teamId === 'string') session.kickTeam(data.teamId);
  }));

  socket.on('redraw_category', staffOnly(() => {
    session.clearAutoModeratorTimer();
    session.doRedrawCategory();
  }));

  socket.on('next_round', staffOnly(() => {
    session.clearAutoModeratorTimer();
    session.doNextRound();
  }));

  socket.on('reset_game', staffOnly(() => {
    session.clearAutoModeratorTimer();
    session.doResetGame();
  }));

  // ── Beamer player (display.html's Spotify Web Playback SDK) ──
  socket.on('spotify_player_ready', staffOnly((data) => {
    if (data && typeof data.deviceId === 'string' && data.deviceId) {
      session.registerPlayer(socket.id, data.deviceId);
    }
  }));

  socket.on('spotify_player_lost', () => {
    session.unregisterPlayer(socket.id);
  });

  socket.on('spotify_player_error', staffOnly((data) => {
    const message = data && typeof data.message === 'string' ? data.message.slice(0, 200) : 'Unbekannter Fehler';
    session.setPlayerIssue('Beamer-Player: ' + message);
  }));

  socket.on('spotify_playback_started', (data) => {
    session.confirmPlayback(socket.id, data && data.uris);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    session.unregisterPlayer(socket.id);
    session.removeViewer(socket.id);
    session.unregisterConnection();
    if (socket.teamId) session.handleTeamDisconnect(socket.teamId);
  });
});

// ── Start ───────────────────────────────────────────────────────

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  ❌ Port ' + PORT + ' ist bereits belegt!');
    console.error('  Lösung: killall node && node server.js\n');
  } else {
    console.error('\n  ❌ Server-Fehler:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🚀 Hitster Bingo - Space Edition');
  console.log('  ─────────────────────────────────');
  console.log('  Server:     http://localhost:' + PORT);
  console.log('  Rundenverwaltung: http://localhost:' + PORT + '/');
  console.log('');
  if (SITE_PASSWORD_GENERATED) {
    console.log('  ⚠ Kein SITE_PASSWORD gesetzt — Passwort für diesen Start: ' + SITE_PASSWORD);
    console.log('    Dauerhaft festlegen in der .env-Datei (siehe .env.example).');
    console.log('');
  }
  if (SPOTIFY_CONFIGURED) {
    console.log('  Spotify Auth (pro Runde):  http://127.0.0.1:' + PORT + '/auth/spotify?room=<code>');
    console.log('');
    console.log('  ⚠ Trage diese EXAKTE Redirect URI im Spotify Dashboard ein:');
    console.log('  → ' + SPOTIFY_REDIRECT_URI);
  } else {
    console.log('  Spotify:     Nicht konfiguriert');
    console.log('               SPOTIFY_CLIENT_ID und SPOTIFY_CLIENT_SECRET in der .env-Datei eintragen (siehe .env.example)');
  }
  console.log('');
});
