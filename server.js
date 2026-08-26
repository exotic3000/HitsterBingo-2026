const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Site password ───────────────────────────────────────────────
// Gates every view except team.html (players need to join without a
// password) and the assets/sockets/APIs every page depends on. Session
// token is derived from a secret that's regenerated on each server start,
// so a restart simply logs everyone out again — no persistence needed.
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'OutOfOrbit26';
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

app.use((req, res, next) => {
  if (!PROTECTED_PAGES.has(req.path) || isAuthenticated(req)) return next();
  // originalUrl (not path) so a `?room=` on the requested page survives the
  // login round-trip instead of dropping the moderator back into a room-less page.
  res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
});

// Cloudflare rewrites the browser-facing Cache-Control for static assets to
// its own ~4h default regardless of what the origin sends, so a plain
// no-cache header alone isn't enough — phones kept showing stale CSS/JS
// after a fix went live. Instead, every HTML page gets its /css and /js
// references stamped with a version query string that changes on every
// server start, so each deploy is a brand new URL Cloudflare has never
// cached, sidestepping the edge cache entirely.
const ASSET_VERSION = Date.now();

app.use((req, res, next) => {
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  if (!reqPath.endsWith('.html')) return next();
  const filePath = path.join(__dirname, 'public', reqPath);
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next();
    const versioned = html.replace(
      /(href|src)="(\/(?:css|js)\/[^"?]+)"/g,
      (m, attr, url) => attr + '="' + url + '?v=' + ASSET_VERSION + '"'
    );
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(versioned);
  });
});

// no-cache (not no-store): browsers/Cloudflare still keep a copy but must
// revalidate via ETag on every load, so edits go live immediately instead of
// being stuck behind Cloudflare's ~4h default browser cache TTL.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.use(express.json());
console.log('[3] Middleware OK, weiter zu Routes...');

app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== SITE_PASSWORD) return res.status(401).json({ ok: false });

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

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'f019a8aaafee49a99be7d0d50cfb3db4';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'b31d81165bba4bc1ab5e947a9889154b';
const PORT = process.env.PORT || 3000;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:' + PORT + '/auth/spotify/callback';

// Public base URL used to build the join-QR link — same origin players scan
// from their phones, so it has to be the tunnel/public domain, not localhost.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://bingo.hitsterquizshow.de';

// Playlists — Name + Spotify-URL/ID, wählbar in der Moderator-Ansicht. Reine
// Konfiguration, kein Geheimnis — bleibt bewusst global für alle Runden.
const SPOTIFY_PLAYLISTS = [
  { name: 'Teenscamp HitsterGameshow 2026', url: 'https://open.spotify.com/playlist/5CF56knZKCMgpfOBz5r0S4?si=CKn55_V1SfGL6anks2hqVg&utm_source=whatsapp&pt=9764aed2b277e286ce2d298fa80145e1' },
  { name: 'Teenscamp Disse 2026', url : 'https://open.spotify.com/playlist/4RTxuCmYBccS5M6rhAWfMd?si=478a56b62e174378'}
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

// Also drop a room's Spotify connection once nobody has any tab of that
// room open at all. A short grace period tolerates a page reload or brief
// network hiccup (same pattern as team reconnects) without forcing a fresh
// Spotify login mid-show.
const SPOTIFY_DISCONNECT_GRACE_MS = 20000;

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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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
  let gameState = (restore && restore.gameState) || 'lobby';
  let currentRound = (restore && restore.currentRound) || 0;
  let spinToken = (restore && restore.spinToken) || 0;
  let currentCategory = (restore && restore.currentCategory) || null;
  let currentMysterySub = (restore && restore.currentMysterySub) || null;
  let currentSong = (restore && restore.currentSong) || null;
  let timerValue = restore && typeof restore.timerValue === 'number' ? restore.timerValue : TIMER_SECONDS;
  let timerInterval = null;

  // ── Automatischer Moderator ─────────────────────────────────────
  // Never auto-resumes after a restore — it needs a fresh Spotify
  // connection anyway (tokens aren't persisted), so the moderator has to
  // flip it back on manually. The playlist choice is kept as a convenience.
  let autoModeratorEnabled = false;
  let autoModeratorPlaylist = (restore && restore.autoModeratorPlaylist) || 0;
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
      categories: CATEGORIES,
      spotifyReady: !!spotifyAccessToken,
      autoModeratorEnabled,
      autoModeratorPlaylist,
    };
  }

  function broadcast() {
    io.to('room:' + roomCode).emit('game_state', getFullState());
  }

  function clearTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function startTimer() {
    clearTimer();
    timerInterval = setInterval(() => {
      timerValue--;
      io.to('room:' + roomCode).emit('timer_tick', timerValue);
      if (timerValue <= 0) {
        clearTimer();
        io.to('room:' + roomCode).emit('spotify_pause');
        broadcast();
        if (autoModeratorEnabled) scheduleAuto(doRevealSolution, AUTO_REVEAL_HOLD_MS);
      }
    }, 1000);
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

  // Shared by the moderator's "Zufälliger Song" button and the automatic
  // moderator loop, so both pick songs the exact same way.
  async function fetchRandomPlaylistTrack(playlistIndex) {
    const token = await getValidToken();
    if (!token) throw httpError(401, 'Nicht mit Spotify verbunden');

    const playlist = SPOTIFY_PLAYLISTS[playlistIndex] || SPOTIFY_PLAYLISTS[0];
    const playlistId = extractPlaylistId(playlist?.url);
    if (!playlistId) throw httpError(400, 'Keine Playlist im Code hinterlegt (SPOTIFY_PLAYLISTS in server.js)');

    const metaResp = await fetch(
      'https://api.spotify.com/v1/playlists/' + playlistId + '?fields=items.total',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const meta = await metaResp.json();
    if (!metaResp.ok) throw httpError(metaResp.status, meta.error?.message || 'Playlist nicht gefunden');

    const total = meta.items?.total || 0;
    if (!total) throw httpError(404, 'Playlist ist leer — Spotify-Antwort: ' + JSON.stringify(meta));

    for (let attempt = 0; attempt < 5; attempt++) {
      const offset = Math.floor(Math.random() * total);
      const resp = await fetch(
        'https://api.spotify.com/v1/playlists/' + playlistId + '/items?' + querystring.stringify({
          limit: 1, offset, market: 'DE',
          fields: 'items(is_local,item(name,uri,id,artists,album,preview_url,duration_ms))',
        }),
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
      const data = await resp.json();
      const entry = data.items?.[0];
      const track = entry?.item;
      if (track && !entry.is_local && track.uri) {
        return mapTrack(track);
      }
    }
    throw httpError(404, 'Kein abspielbarer Song in der Playlist gefunden');
  }

  // ── Round actions ────────────────────────────────────────────────
  // Shared by the socket handlers (manual/moderator-triggered) and the
  // automatic moderator loop below, so both drive the exact same state
  // transitions instead of duplicating the logic.

  function doStartSpin() {
    gameState = 'spinning';
    spinToken++;
    currentCategory = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    currentMysterySub = currentCategory.id === 'mystery' ? pickWeightedRandom(MYSTERY_SUBS) : null;
    answers.clear();
    broadcast();

    if (autoModeratorEnabled) {
      autoModeratorRetries = 0;
      scheduleAuto(doAutoPickSong, AUTO_SPIN_REVEAL_MS);
    }
  }

  function doSetSong(song) {
    currentSong = song;
    gameState = 'playing';
    timerValue = TIMER_SECONDS;
    broadcast();
    startTimer();
    if (song.spotifyUri) {
      io.to('room:' + roomCode).emit('spotify_play', { uri: song.spotifyUri });
    }
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
    clearTimer();
    gameState = 'revealing';
    io.to('room:' + roomCode).emit('spotify_pause');
    broadcast();

    if (autoModeratorEnabled) scheduleAuto(doNextRound, AUTO_REVEAL_DURATION_MS);
  }

  function doRedrawCategory() {
    clearTimer();
    spinToken++;
    currentCategory = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    currentMysterySub = currentCategory.id === 'mystery' ? pickWeightedRandom(MYSTERY_SUBS) : null;
    currentSong = null;
    answers.clear();
    gameState = 'spinning';
    io.to('room:' + roomCode).emit('spotify_pause');
    broadcast();

    if (autoModeratorEnabled) {
      autoModeratorRetries = 0;
      scheduleAuto(doAutoPickSong, AUTO_SPIN_REVEAL_MS);
    }
  }

  function doNextRound() {
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
    clearTimer();
    currentRound = 0;
    currentCategory = null;
    currentMysterySub = null;
    currentSong = null;
    answers.clear();
    gameState = 'lobby';
    for (const [, team] of teams) {
      team.bingoCard = generateBingoCard();
      team.score = 0;
      team.hasBingo = false;
    }
    io.to('room:' + roomCode).emit('spotify_pause');
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

    if (resuming) {
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
      answers.delete(teamId);
      broadcast();
    }, TEAM_DISCONNECT_GRACE_MS);
    pendingTeamRemoval.set(teamId, timer);
  }

  function submitAnswer(teamId, answer) {
    if (gameState !== 'playing') return;
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
    answers.delete(teamId);
    io.to('team_' + teamId).emit('kicked');
    broadcast();
  }

  // Turns the automatic moderator loop on/off. While enabled, the server
  // itself drives start_spin → auto-picked song → timer → reveal_solution →
  // next_round in a loop, so the host can join as a team on their phone
  // instead of operating this screen.
  async function setAutoModerator(enabled, playlistIndex) {
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

    if (typeof playlistIndex === 'number' && SPOTIFY_PLAYLISTS[playlistIndex]) {
      autoModeratorPlaylist = playlistIndex;
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
      answers: [...answers.entries()],
      gameState,
      currentRound,
      spinToken,
      currentCategory,
      currentMysterySub,
      currentSong,
      timerValue,
      autoModeratorPlaylist,
    };
  }

  // A round mid-song when the crash happened resumes ticking down from the
  // saved value once restored — the only piece of state that can't just sit
  // there inert, since its progress lived in a setInterval that died with
  // the process. Every other gameState is static and just gets served as-is
  // to whoever reconnects next.
  if (restore && gameState === 'playing') {
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
    resolveTeamJoin,
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
    getValidToken,
    fetchRandomPlaylistTrack,
    setSpotifyTokens,
    close,
  };
}

// ── Crash recovery ─────────────────────────────────────────────────
// Everything lives in memory, so a crash or redeploy would otherwise wipe
// every running round. A periodic snapshot to disk (teams, scores, round
// state — deliberately never Spotify tokens, see createSession) means the
// worst case is losing the last ~30s of progress instead of the whole event.

const SNAPSHOT_FILE = path.join(__dirname, '.rooms-snapshot.json');
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

app.get('/auth/spotify/debug', (req, res) => {
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

app.get('/auth/spotify', (req, res) => {
  const roomCode = req.query.room;
  if (!roomCode || !sessions.has(roomCode)) {
    return res.status(404).send('Unbekannte Runde. Bitte den Verbinden-Link erneut über die Moderationsseite öffnen.');
  }
  if (!SPOTIFY_CLIENT_ID) {
    return res.status(500).send('SPOTIFY_CLIENT_ID nicht gesetzt. Starte den Server mit: SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node server.js');
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

// Spotify API proxy: the client gets the token to init the Web Playback SDK
app.get('/api/spotify/token', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const token = await session.getValidToken();
  res.json({ token: token || null });
});

app.get('/api/spotify/search', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const token = await session.getValidToken();
  if (!token) return res.status(401).json({ error: 'Nicht mit Spotify verbunden' });

  const q = req.query.q;
  if (!q) return res.json({ tracks: [] });

  try {
    const resp = await fetch('https://api.spotify.com/v1/search?' + querystring.stringify({
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
  res.json({ playlists: SPOTIFY_PLAYLISTS.map((p, index) => ({ index, name: p.name })) });
});

app.get('/api/spotify/playlist-random', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const track = await session.fetchRandomPlaylistTrack(parseInt(req.query.playlist));
    res.json({ track });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.put('/api/spotify/play', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const token = await session.getValidToken();
  if (!token) return res.status(401).json({ error: 'Nicht mit Spotify verbunden' });

  const { uri, deviceId } = req.body;
  try {
    const resp = await fetch('https://api.spotify.com/v1/me/player/play' + (deviceId ? '?device_id=' + deviceId : ''), {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [uri] }),
    });
    if (resp.status === 204 || resp.status === 200) {
      res.json({ ok: true });
    } else {
      const data = await resp.json().catch(() => ({}));
      res.status(resp.status).json({ error: data.error?.message || 'Playback failed' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/spotify/pause', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const token = await session.getValidToken();
  if (!token) return res.status(401).json({ error: 'Nicht verbunden' });

  try {
    await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Socket.IO ───────────────────────────────────────────────────
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

  socket.roomCode = roomCode;
  session.registerConnection();
  socket.join('room:' + roomCode);
  socket.emit('game_state', session.getFullState());

  socket.on('join', (data, ack) => {
    const { role } = data || {};
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    let teamId;

    if (role === 'team') {
      const result = session.resolveTeamJoin(data);
      if (!result.ok) { reply(result); return; }
      teamId = result.teamId;
      socket.join('team_' + teamId);
      socket.teamId = teamId;
    }

    socket.join(role);
    socket.emit('game_state', session.getFullState());
    session.broadcast();
    reply({ ok: true, teamId: role === 'team' ? teamId : undefined });
  });

  socket.on('start_spin', () => {
    session.clearAutoModeratorTimer();
    session.doStartSpin();
  });

  socket.on('set_song', (song) => {
    session.clearAutoModeratorTimer();
    session.doSetSong(song);
  });

  socket.on('submit_answer', (data) => {
    session.submitAnswer(data.teamId, data.answer);
  });

  socket.on('reveal_solution', () => {
    session.clearAutoModeratorTimer();
    session.doRevealSolution();
  });

  socket.on('set_auto_moderator', async (data, ack) => {
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    const result = await session.setAutoModerator(!!(data && data.enabled), data && data.playlist);
    reply(result);
  });

  socket.on('mark_correct', (data) => {
    session.markCorrect(data.teamId, data.row, data.col);
  });

  socket.on('kick_team', (data) => {
    session.kickTeam(data.teamId);
  });

  socket.on('redraw_category', () => {
    session.clearAutoModeratorTimer();
    session.doRedrawCategory();
  });

  socket.on('next_round', () => {
    session.clearAutoModeratorTimer();
    session.doNextRound();
  });

  socket.on('reset_game', () => {
    session.clearAutoModeratorTimer();
    session.doResetGame();
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
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
  if (SPOTIFY_CLIENT_ID) {
    console.log('  Spotify Auth (pro Runde):  http://127.0.0.1:' + PORT + '/auth/spotify?room=<code>');
    console.log('');
    console.log('  ⚠ Trage diese EXAKTE Redirect URI im Spotify Dashboard ein:');
    console.log('  → ' + SPOTIFY_REDIRECT_URI);
  } else {
    console.log('  Spotify:     Nicht konfiguriert');
    console.log('               Starte mit: SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node server.js');
  }
  console.log('');
});
