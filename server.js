const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

// ── Join QR codes ───────────────────────────────────────────────
// Fixed public URLs (Cloudflare Tunnel) scanned from phones.
const JOIN_URL = 'https://bingo.hitsterquizshow.de/team.html';
const TEAMER_URL = 'https://bingo.hitsterquizshow.de/teamer.html';

app.get('/api/join-qr', async (req, res) => {
  try {
    const png = await QRCode.toBuffer(JOIN_URL, { width: 400, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/teamer-qr', async (req, res) => {
  try {
    const png = await QRCode.toBuffer(TEAMER_URL, { width: 400, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ── Spotify Config ──────────────────────────────────────────────

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'f019a8aaafee49a99be7d0d50cfb3db4';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'b31d81165bba4bc1ab5e947a9889154b';
const PORT = process.env.PORT || 3000;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:' + PORT + '/auth/spotify/callback';

// Playlists
const SPOTIFY_PLAYLIST = 'https://open.spotify.com/playlist/5CF56knZKCMgpfOBz5r0S4?si=CKn55_V1SfGL6anks2hqVg&utm_source=whatsapp&pt=9764aed2b277e286ce2d298fa80145e1';

let spotifyAccessToken = null;
let spotifyRefreshToken = null;
let spotifyTokenExpiry = 0;

// Persist tokens to disk so a server restart doesn't force re-login.
const SPOTIFY_TOKEN_FILE = path.join(__dirname, '.spotify-token.json');

function saveSpotifyTokens() {
  try {
    fs.writeFileSync(SPOTIFY_TOKEN_FILE, JSON.stringify({
      accessToken: spotifyAccessToken,
      refreshToken: spotifyRefreshToken,
      expiry: spotifyTokenExpiry,
    }));
  } catch (e) {
    console.error('Spotify-Token konnte nicht gespeichert werden:', e.message);
  }
}

function loadSpotifyTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_FILE, 'utf8'));
    spotifyAccessToken = data.accessToken || null;
    spotifyRefreshToken = data.refreshToken || null;
    spotifyTokenExpiry = data.expiry || 0;
    if (spotifyRefreshToken) console.log('  Spotify-Login aus .spotify-token.json wiederhergestellt');
  } catch (e) {
    // Keine gespeicherten Tokens vorhanden — normal beim ersten Start.
  }
}

loadSpotifyTokens();

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

const MAX_TEAMS = 10 ;
const BINGO_SIZE = 5;
const TIMER_SECONDS = 60;
const TEAM_DISCONNECT_GRACE_MS = 450000;

// ── Game State ──────────────────────────────────────────────────

const teams = new Map();
const answers = new Map();
const pendingTeamRemoval = new Map(); // teamId -> Timeout, cancelled on reconnect
let gameState = 'lobby';
let currentRound = 0;
let currentCategory = null;
let currentMysterySub = null;
let currentSong = null;
let timerValue = TIMER_SECONDS;
let timerInterval = null;

// ── Helper Functions ────────────────────────────────────────────

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

function getFullState() {
  return {
    gameState,
    teams: Object.fromEntries(teams),
    currentRound,
    currentCategory,
    currentMysterySub,
    currentSong,
    answers: Object.fromEntries(answers),
    timerValue,
    categories: CATEGORIES,
    spotifyReady: !!spotifyAccessToken,
  };
}

function broadcast() {
  io.emit('game_state', getFullState());
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
    io.emit('timer_tick', timerValue);
    if (timerValue <= 0) {
      clearTimer();
      io.emit('spotify_pause');
      broadcast();
    }
  }, 1000);
}

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
  });
  res.redirect(authUrl);
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send('Spotify Auth Fehler: ' + error);
  if (!code) return res.send('Kein Code erhalten');

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

    spotifyAccessToken = data.access_token;
    spotifyRefreshToken = data.refresh_token;
    spotifyTokenExpiry = Date.now() + data.expires_in * 1000;
    saveSpotifyTokens();

    broadcast();
    res.send('<html><body style="background:#0a0e27;color:#4cc9f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;font-size:1.5rem"><div style="text-align:center">✅ Spotify verbunden!<br><br><small style="color:#8892b0">Du kannst dieses Fenster schließen.</small></div></body></html>');
  } catch (e) {
    res.status(500).send('Fehler: ' + e.message);
  }
});

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
      saveSpotifyTokens();
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

// Spotify API proxy: the client gets the token to init the Web Playback SDK
app.get('/api/spotify/token', async (req, res) => {
  const token = await getValidToken();
  if (!token) return res.json({ token: null });
  res.json({ token });
});

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

app.get('/api/spotify/search', async (req, res) => {
  const token = await getValidToken();
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

app.get('/api/spotify/playlist-random', async (req, res) => {
  const token = await getValidToken();
  if (!token) return res.status(401).json({ error: 'Nicht mit Spotify verbunden' });

  const playlistId = extractPlaylistId(SPOTIFY_PLAYLIST);
  if (!playlistId) return res.status(400).json({ error: 'Keine Playlist im Code hinterlegt (SPOTIFY_PLAYLIST in server.js)' });

  try {
    const metaResp = await fetch(
      'https://api.spotify.com/v1/playlists/' + playlistId + '?fields=items.total',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const meta = await metaResp.json();
    console.log('[playlist-random] playlistId=' + playlistId + ' status=' + metaResp.status + ' body=' + JSON.stringify(meta));
    if (!metaResp.ok) return res.status(metaResp.status).json({ error: meta.error?.message || 'Playlist nicht gefunden' });

    const total = meta.items?.total || 0;
    if (!total) return res.status(404).json({ error: 'Playlist ist leer — Spotify-Antwort: ' + JSON.stringify(meta) });

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
        return res.json({ track: mapTrack(track) });
      }
    }
    res.status(404).json({ error: 'Kein abspielbarer Song in der Playlist gefunden' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/spotify/play', async (req, res) => {
  const token = await getValidToken();
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
  const token = await getValidToken();
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

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send the current state right away, before any 'join' — lets a client
  // still on the team setup screen see already-taken names/emojis live.
  socket.emit('game_state', getFullState());

  socket.on('join', (data, ack) => {
    const { role } = data;
    const reply = (res) => { if (typeof ack === 'function') ack(res); };
    let teamId;

    if (role === 'team') {
      teamId = data.teamId;
      const resuming = teamId && teams.has(teamId);

      if (resuming) {
        // Reconnected (reload/network hiccup) before the grace period
        // expired — the team stays, cancel its scheduled removal.
        const pending = pendingTeamRemoval.get(teamId);
        if (pending) {
          clearTimeout(pending);
          pendingTeamRemoval.delete(teamId);
        }
      } else {
        // Validate before the team exists so a rejected name/emoji never
        // leaves a half-created team with a placeholder name behind.
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        const emoji = data.emoji || '🚀';

        if (!name) {
          reply({ ok: false, message: 'Teamname fehlt.' });
          return;
        }
        if (teams.size >= MAX_TEAMS) {
          reply({ ok: false, message: 'Maximale Teamanzahl erreicht' });
          return;
        }
        const nameTaken = [...teams.values()].some(
          (t) => t.name.trim().toLowerCase() === name.toLowerCase()
        );
        if (nameTaken) {
          reply({ ok: false, field: 'name', message: 'Dieser Teamname ist bereits vergeben.' });
          return;
        }
        const emojiTaken = [...teams.values()].some((t) => t.emoji === emoji);
        if (emojiTaken) {
          reply({ ok: false, field: 'emoji', message: 'Dieses Emoji ist bereits vergeben.' });
          return;
        }

        teamId = uuidv4();
        teams.set(teamId, {
          id: teamId,
          name,
          emoji,
          bingoCard: generateBingoCard(),
          score: 0,
          hasBingo: false,
        });
      }

      socket.join('team_' + teamId);
      socket.teamId = teamId;
    }

    socket.join(role);
    socket.emit('game_state', getFullState());
    broadcast();
    reply({ ok: true, teamId: role === 'team' ? teamId : undefined });
  });

  socket.on('start_spin', () => {
    gameState = 'spinning';
    currentCategory = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    currentMysterySub = currentCategory.id === 'mystery' ? pickWeightedRandom(MYSTERY_SUBS) : null;
    answers.clear();
    broadcast();
  });

  socket.on('set_song', (song) => {
    currentSong = song;
    gameState = 'playing';
    timerValue = TIMER_SECONDS;
    broadcast();
    startTimer();
    // Tell display to start Spotify playback
    if (song.spotifyUri) {
      io.emit('spotify_play', { uri: song.spotifyUri });
    }
  });

  socket.on('submit_answer', (data) => {
    if (gameState !== 'playing') return;
    answers.set(data.teamId, data.answer);
    broadcast();
  });

  socket.on('reveal_solution', () => {
    clearTimer();
    gameState = 'revealing';
    io.emit('spotify_pause');
    broadcast();
  });

  socket.on('mark_correct', (data) => {
    const team = teams.get(data.teamId);
    if (!team) return;
    const cell = team.bingoCard[data.row][data.col];
    cell.checked = !cell.checked;
    team.score = team.bingoCard.flat().filter(c => c.checked).length;
    team.hasBingo = checkBingo(team.bingoCard);
    broadcast();
  });

  socket.on('kick_team', (data) => {
    const teamId = data.teamId;
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
  });

  socket.on('next_round', () => {
    currentRound++;
    currentCategory = null;
    currentMysterySub = null;
    currentSong = null;
    answers.clear();
    gameState = 'between_rounds';
    broadcast();
  });

  socket.on('reset_game', () => {
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
    io.emit('spotify_pause');
    broadcast();
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    const teamId = socket.teamId;
    if (!teamId) return;

    // Don't remove immediately — a page reload or brief network drop also
    // fires 'disconnect' and would otherwise wipe a still-playing team.
    // The 'join' resume path cancels this if the same team reconnects.
    const timer = setTimeout(() => {
      pendingTeamRemoval.delete(teamId);
      if (!teams.has(teamId)) return;
      teams.delete(teamId);
      answers.delete(teamId);
      broadcast();
    }, TEAM_DISCONNECT_GRACE_MS);
    pendingTeamRemoval.set(teamId, timer);
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
  console.log('');
  console.log('  Ansichten:');
  console.log('    Start:       http://localhost:' + PORT);
  console.log('    Beamer:      http://localhost:' + PORT + '/display.html');
  console.log('    Moderation:  http://localhost:' + PORT + '/moderator.html');
  console.log('    Team:        http://localhost:' + PORT + '/team.html');
  console.log('    Übersicht:   http://localhost:' + PORT + '/overview.html');
  console.log('    Teamer:      http://localhost:' + PORT + '/teamer.html');
  console.log('    Bingokarten: http://localhost:' + PORT + '/boards.html');
  console.log('');
  if (SPOTIFY_CLIENT_ID) {
    console.log('  Spotify Auth:  http://127.0.0.1:' + PORT + '/auth/spotify');
    console.log('');
    console.log('  ⚠ Trage diese EXAKTE Redirect URI im Spotify Dashboard ein:');
    console.log('  → ' + SPOTIFY_REDIRECT_URI);
  } else {
    console.log('  Spotify:     Nicht konfiguriert');
    console.log('               Starte mit: SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node server.js');
  }
  console.log('');
});
