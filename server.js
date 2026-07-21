const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
console.log('[3] Middleware OK, weiter zu Routes...');

// ── Spotify Config ──────────────────────────────────────────────

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'f019a8aaafee49a99be7d0d50cfb3db4';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'b31d81165bba4bc1ab5e947a9889154b';
const PORT = process.env.PORT || 3000;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:' + PORT + '/auth/spotify/callback';

// Playlists
const SPOTIFY_PLAYLIST = 'https://open.spotify.com/playlist/4QsXN56c7y8hH0v6EEnHRa?si=b107b7adf82f49a2';

let spotifyAccessToken = null;
let spotifyRefreshToken = null;
let spotifyTokenExpiry = 0;

// ── Game Constants ──────────────────────────────────────────────

const CATEGORIES = [
  { id: 'artist', name: 'Interpret', color: '#ff4d6d', icon: '🎤' },
  { id: 'title', name: 'Titel', color: '#4cc9f0', icon: '🎵' },
  { id: 'decade', name: 'Jahrzehnt', color: '#7209b7', icon: '📅' },
  { id: 'year4', name: 'Jahr ±4', color: '#f72585', icon: '🎯' },
  { id: 'mystery', name: '?', color: '#4361ee', icon: '❓' },
];

const MYSTERY_SUBS = [
  { id: 'band_or_solo', name: 'Band oder Solo?', weight: 25 },
  { id: 'before_2000', name: 'Vor 2000?', weight: 25 },
  { id: 'exact_year', name: 'Genaues Jahr', weight: 12.5 },
  { id: 'year3', name: 'Jahr ±3', weight: 25 },
  { id: 'year2', name: 'Jahr ±2', weight: 12.5 },
];

const MAX_TEAMS = 7;
const BINGO_SIZE = 5;
const TIMER_SECONDS = 60;

// ── Game State ──────────────────────────────────────────────────

const teams = new Map();
const answers = new Map();
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

// Linear coefficients (a,b) for L[r][c] = (a*r + b*c + d) mod 5 that keep
// every row, column AND both diagonals a permutation of all 5 categories
// (a "Knut Vik" style Latin square). Picking randomly among these plus a
// random offset d and a random category order gives a fresh, well-shuffled
// layout each time while preserving the one-of-each guarantee.
const LATIN_COEFFS = [
  [1, 2], [1, 3], [2, 1], [2, 4],
  [3, 1], [3, 4], [4, 2], [4, 3],
];

function generateBingoCard() {
  const catOrder = shuffle(CATEGORIES).map(cat => cat.id);
  const [a, b] = LATIN_COEFFS[Math.floor(Math.random() * LATIN_COEFFS.length)];
  const d = Math.floor(Math.random() * BINGO_SIZE);

  const card = [];
  for (let r = 0; r < BINGO_SIZE; r++) {
    const row = [];
    for (let c = 0; c < BINGO_SIZE; c++) {
      const idx = (a * r + b * c + d) % BINGO_SIZE;
      row.push({ categoryId: catOrder[idx], checked: false });
    }
    card.push(row);
  }
  return card;
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

  socket.on('join', (data) => {
    const { role } = data;

    if (role === 'team') {
      let teamId = data.teamId;
      if (!teamId || !teams.has(teamId)) {
        if (teams.size >= MAX_TEAMS) {
          socket.emit('error_msg', 'Maximale Teamanzahl erreicht');
          return;
        }
        teamId = uuidv4();
        teams.set(teamId, {
          id: teamId,
          name: 'Team ' + (teams.size + 1),
          emoji: '🚀',
          bingoCard: generateBingoCard(),
          score: 0,
          hasBingo: false,
        });
      }
      socket.join('team_' + teamId);
      socket.teamId = teamId;
      socket.emit('team_assigned', teamId);
    }

    socket.join(role);
    socket.emit('game_state', getFullState());
    broadcast();
  });

  socket.on('update_team', (data) => {
    const team = teams.get(data.teamId);
    if (!team) return;
    if (data.name) team.name = data.name;
    if (data.emoji) team.emoji = data.emoji;
    broadcast();
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
