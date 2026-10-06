/* Moderator Control View — with Spotify search */

(function () {
  const socket = connectSocket('moderator');

  const roomCode = getRoomCode();
  document.getElementById('spotify-link').href = '/auth/spotify?room=' + encodeURIComponent(roomCode);

  const controlsEl = document.getElementById('controls');
  let selectedSong = null;
  let searchTimeout = null;
  let spotifyConnected = false;
  let currentGameState = null;
  let gamePaused = false;

  function makeBtn(text, cls, handler) {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.addEventListener('click', handler);
    return b;
  }

  // ── Spotify search ─────────────────────────────────────────────

  const searchInput = document.getElementById('input-search');
  const searchBtn = document.getElementById('btn-search');
  const resultsEl = document.getElementById('search-results');

  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    resultsEl.innerHTML = '<p style="color:var(--text-dim);padding:.5rem">Suche...</p>';
    try {
      const resp = await fetch('/api/spotify/search?room=' + encodeURIComponent(roomCode) + '&q=' + encodeURIComponent(q));
      const data = await resp.json();
      if (data.error) {
        resultsEl.innerHTML = '<p style="color:var(--pink);padding:.5rem">' + data.error + '</p>';
        return;
      }
      renderSearchResults(data.tracks || []);
    } catch (e) {
      resultsEl.innerHTML = '<p style="color:var(--pink);padding:.5rem">Fehler: ' + e.message + '</p>';
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      if (searchInput.value.trim().length >= 3) doSearch();
    }, 400);
  });

  function renderSearchResults(tracks) {
    if (!tracks.length) {
      resultsEl.innerHTML = '<p style="color:var(--text-dim);padding:.5rem">Keine Ergebnisse</p>';
      return;
    }
    resultsEl.innerHTML = tracks.map((t, i) =>
      '<div class="search-result" data-idx="' + i + '">' +
        (t.cover ? '<img src="' + t.cover + '" alt="">' : '<div style="width:48px;height:48px;background:var(--surface);border-radius:6px"></div>') +
        '<div class="meta">' +
          '<div class="t">' + t.title + '</div>' +
          '<div class="a">' + t.artist + '</div>' +
        '</div>' +
        '<span class="yr">' + t.year + '</span>' +
      '</div>'
    ).join('');

    resultsEl.querySelectorAll('.search-result').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        const track = tracks[idx];
        selectSpotifyTrack(track);
      });
    });
  }

  function selectSpotifyTrack(track) {
    selectedSong = track;
    document.getElementById('input-title').value = track.title;
    document.getElementById('input-artist').value = track.artist;
    document.getElementById('input-year').value = track.year;
    resultsEl.innerHTML = '<div class="search-result" style="background:var(--surface-light);border:1px solid var(--green);border-radius:10px">' +
      (track.cover ? '<img src="' + track.cover + '" alt="">' : '') +
      '<div class="meta"><div class="t">' + track.title + '</div><div class="a">' + track.artist + '</div></div>' +
      '<span style="color:var(--green);font-size:.8rem">Ausgewählt ✓</span></div>';
  }

  // ── Playlists ─────────────────────────────────────────────────

  const randomBtn = document.getElementById('btn-random-song');
  const playlistSelect = document.getElementById('select-playlist');
  const autoPlaylistSelect = document.getElementById('select-auto-playlist');
  const playlistListEl = document.getElementById('playlist-list');
  const addPlaylistForm = document.getElementById('add-playlist-form');
  const addPlaylistError = document.getElementById('add-playlist-error');
  const btnToggleAddPlaylist = document.getElementById('btn-toggle-add-playlist');
  const inputPlaylistName = document.getElementById('input-playlist-name');
  const inputPlaylistUrl = document.getElementById('input-playlist-url');

  async function loadPlaylists() {
    try {
      const resp = await fetch('/api/spotify/playlists');
      const data = await resp.json();
      renderPlaylists(data.playlists || []);
    } catch (e) { /* keep showing whatever was there before */ }
  }

  function renderPlaylists(playlists) {
    // Keep whatever was already picked, if it's still around, instead of
    // silently resetting the moderator's selection on every refresh.
    const prevManual = playlistSelect.value;
    const prevAuto = autoPlaylistSelect.value;

    const options = playlists.map((p) => '<option value="' + p.id + '">' + p.name + '</option>').join('');
    playlistSelect.innerHTML = options;
    autoPlaylistSelect.innerHTML = options;
    if (playlists.some((p) => p.id === prevManual)) playlistSelect.value = prevManual;
    if (playlists.some((p) => p.id === prevAuto)) autoPlaylistSelect.value = prevAuto;

    playlistListEl.innerHTML = playlists.map((p) =>
      '<div class="flex justify-between items-center" style="padding:.4rem 0">' +
        '<span style="font-size:.85rem">' + p.name + '</span>' +
        '<button type="button" class="btn btn-secondary" data-delete-playlist="' + p.id + '" ' +
        'style="font-size:.7rem;padding:.25rem .5rem" ' + (playlists.length <= 1 ? 'disabled title="Mindestens eine Playlist muss übrig bleiben"' : '') + '>✕</button>' +
      '</div>'
    ).join('');

    playlistListEl.querySelectorAll('[data-delete-playlist]').forEach((btn) => {
      btn.addEventListener('click', () => deletePlaylist(btn.dataset.deletePlaylist));
    });
  }

  btnToggleAddPlaylist.addEventListener('click', () => {
    addPlaylistForm.classList.toggle('hidden');
    addPlaylistError.classList.add('hidden');
    if (!addPlaylistForm.classList.contains('hidden')) inputPlaylistName.focus();
  });

  addPlaylistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    addPlaylistError.classList.add('hidden');
    const name = inputPlaylistName.value.trim();
    const url = inputPlaylistUrl.value.trim();
    try {
      const resp = await fetch('/api/spotify/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        addPlaylistError.textContent = data.error || 'Playlist konnte nicht hinzugefügt werden.';
        addPlaylistError.classList.remove('hidden');
        return;
      }
      inputPlaylistName.value = '';
      inputPlaylistUrl.value = '';
      addPlaylistForm.classList.add('hidden');
      renderPlaylists(data.playlists);
    } catch (e) {
      addPlaylistError.textContent = 'Fehler: ' + e.message;
      addPlaylistError.classList.remove('hidden');
    }
  });

  async function deletePlaylist(id) {
    if (!confirm('Diese Playlist wirklich entfernen?')) return;
    const resp = await fetch('/api/spotify/playlists/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(data.error || 'Playlist konnte nicht entfernt werden.');
      return;
    }
    renderPlaylists(data.playlists);
  }

  loadPlaylists();

  async function doRandomSong() {
    resultsEl.innerHTML = '<p style="color:var(--text-dim);padding:.5rem">Wähle zufälligen Song...</p>';
    try {
      const resp = await fetch('/api/spotify/playlist-random?room=' + encodeURIComponent(roomCode) + '&playlist=' + playlistSelect.value);
      const data = await resp.json();
      if (data.error) {
        resultsEl.innerHTML = '<p style="color:var(--pink);padding:.5rem">' + data.error + '</p>';
        return;
      }
      selectSpotifyTrack(data.track);
    } catch (e) {
      resultsEl.innerHTML = '<p style="color:var(--pink);padding:.5rem">Fehler: ' + e.message + '</p>';
    }
  }

  randomBtn.addEventListener('click', doRandomSong);

  // ── Start song ─────────────────────────────────────────────────

  function doStartSong() {
    const title = document.getElementById('input-title').value.trim();
    const artist = document.getElementById('input-artist').value.trim();
    const year = document.getElementById('input-year').value.trim();
    if (!title || !artist) return;

    const songData = {
      title, artist, year,
      spotifyUri: selectedSong?.spotifyUri || null,
      cover: selectedSong?.cover || null,
    };
    socket.emit('set_song', songData);
    selectedSong = null;
  }

  document.getElementById('btn-start-song').addEventListener('click', doStartSong);

  // ── Toggle manual input ────────────────────────────────────────

  const btnToggle = document.getElementById('btn-toggle-manual');
  function toggleManual() {
    const fields = document.getElementById('manual-fields');
    fields.classList.toggle('hidden');
    btnToggle.textContent = fields.classList.contains('hidden') ? 'Manuell eingeben' : 'Verbergen';
  }
  if (btnToggle) {
    btnToggle.addEventListener('click', toggleManual);
  }

  // ── Automatischer Moderator ───────────────────────────────────

  let autoModeratorEnabled = false;
  const autoToggle = document.getElementById('auto-moderator-toggle');
  const autoSettingsEl = document.getElementById('auto-moderator-settings');
  const autoStatusEl = document.getElementById('auto-moderator-status');

  autoToggle.addEventListener('change', () => {
    const enabled = autoToggle.checked;
    autoToggle.disabled = true;
    socket.emit('set_auto_moderator', {
      enabled,
      playlist: autoPlaylistSelect.value || null,
    }, (res) => {
      autoToggle.disabled = false;
      if (!res || !res.ok) {
        autoToggle.checked = false;
        alert((res && res.message) || 'Automatischer Moderator konnte nicht aktiviert werden.');
      }
    });
  });

  socket.on('auto_moderator_stopped', (data) => {
    autoToggle.checked = false;
    alert('Automatischer Moderator wurde gestoppt: ' + ((data && data.reason) || 'Unbekannter Fehler'));
  });

  // ── Control actions (shared by buttons and keyboard shortcuts) ──

  function clearSongInputs() {
    document.getElementById('input-title').value = '';
    document.getElementById('input-artist').value = '';
    document.getElementById('input-year').value = '';
    searchInput.value = '';
    resultsEl.innerHTML = '';
    selectedSong = null;
  }

  function doSpin() {
    socket.emit('start_spin');
  }

  function doRedrawCategory() {
    socket.emit('redraw_category');
    clearSongInputs();
  }

  function doRevealSolution() {
    socket.emit('reveal_solution');
  }

  function doNextRound() {
    socket.emit('next_round');
    clearSongInputs();
  }

  function doReset() {
    socket.emit('reset_game');
  }

  function doPause() {
    socket.emit('pause_game');
  }

  function doResume() {
    socket.emit('resume_game');
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────
  // Ignored while typing in a text field, except Enter in the manual
  // song fields (starts the song) — everything else stays mouse-only.

  window.addEventListener('keydown', (e) => {
    const target = e.target;
    const isTextField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

    if (isTextField) {
      const manualFieldIds = ['input-title', 'input-artist', 'input-year'];
      if (e.key === 'Enter' && manualFieldIds.includes(target.id)) {
        e.preventDefault();
        doStartSong();
      }
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (currentGameState === 'lobby' || currentGameState === 'between_rounds') doSpin();
        else if (currentGameState === 'playing') doRevealSolution();
        else if (currentGameState === 'revealing') doNextRound();
        break;
      case 'd':
      case 'D':
        if (currentGameState === 'lobby' || currentGameState === 'between_rounds') doSpin();
        break;
      case 'k':
      case 'K':
        if (['spinning', 'playing', 'revealing'].includes(currentGameState)) doRedrawCategory();
        break;
      case 'l':
      case 'L':
        if (currentGameState === 'playing') doRevealSolution();
        break;
      case 'n':
      case 'N':
        if (currentGameState === 'revealing') doNextRound();
        break;
      case 'm':
      case 'M':
        if (currentGameState === 'spinning' && btnToggle && !btnToggle.classList.contains('hidden')) toggleManual();
        break;
      case 's':
      case 'S':
        if (currentGameState === 'spinning') doStartSong();
        break;
      case 'z':
      case 'Z':
        if (currentGameState === 'spinning' && spotifyConnected) doRandomSong();
        break;
      case 'r':
      case 'R':
        doReset();
        break;
      case 'p':
      case 'P':
        if (currentGameState === 'playing') gamePaused ? doResume() : doPause();
        break;
    }
  });

  // ── Game state rendering ───────────────────────────────────────

  socket.on('game_state', (state) => {
    renderRoomBadge(state);
    const gs = state.gameState;
    currentGameState = gs;
    gamePaused = !!state.paused;
    document.getElementById('pause-banner').classList.toggle('hidden', !gamePaused);
    const teams = Object.values(state.teams);

    // Spotify status bar
    spotifyConnected = state.spotifyReady;
    const bar = document.getElementById('spotify-bar');
    const icon = document.getElementById('spotify-icon');
    const statusTxt = document.getElementById('spotify-status');
    const link = document.getElementById('spotify-link');

    if (spotifyConnected) {
      bar.className = 'spotify-bar ' + (state.spotifyPlayerReady ? 'connected' : 'disconnected') + ' mb';
      icon.textContent = state.spotifyPlayerReady ? '🎵' : '⚠️';
      statusTxt.textContent = state.spotifyPlayerReady
        ? 'Spotify verbunden · Beamer-Player bereit'
        : 'Spotify verbunden · Beamer-Player fehlt (Beamer-Seite öffnen bzw. neu laden)';
      link.textContent = 'Neu verbinden';
    } else {
      bar.className = 'spotify-bar disconnected mb';
      icon.textContent = '🔇';
      statusTxt.textContent = 'Spotify nicht verbunden';
      link.textContent = 'Verbinden';
    }

    const issueEl = document.getElementById('spotify-issue');
    let issue = state.spotifyPlayerIssue || '';
    if (!issue && state.awaitingPlayback) issue = '⏳ Warte, bis der Song auf dem Beamer läuft — der Timer startet danach.';
    issueEl.textContent = issue;
    issueEl.classList.toggle('hidden', !issue);

    // Automatischer Moderator
    autoModeratorEnabled = !!state.autoModeratorEnabled;
    autoToggle.checked = autoModeratorEnabled;
    if (state.autoModeratorPlaylist) {
      autoPlaylistSelect.value = state.autoModeratorPlaylist;
    }
    autoSettingsEl.classList.toggle('hidden', autoModeratorEnabled);
    autoStatusEl.classList.toggle('hidden', !autoModeratorEnabled);
    if (autoModeratorEnabled) {
      autoStatusEl.textContent = '🤖 Automatischer Moderator läuft — Runde ' + (state.currentRound + 1) + '. Die Steuerung unten übernimmt der Server.';
    }

    // Controls — the automatic moderator drives these itself, so hide the
    // manual round controls while it's running (Reset stays available in
    // case the host wants to stop everything by hand).
    controlsEl.innerHTML = '';
    if (!autoModeratorEnabled) {
      if (gs === 'lobby' || gs === 'between_rounds') {
        controlsEl.appendChild(makeBtn('Drehen (D)', 'btn-primary', doSpin));
      }
      if (gs === 'spinning' || gs === 'playing' || gs === 'revealing') {
        controlsEl.appendChild(makeBtn('Kategorie neu drehen (K)', 'btn-secondary', doRedrawCategory));
      }
      if (gs === 'playing') {
        controlsEl.appendChild(gamePaused
          ? makeBtn('▶ Fortsetzen (P)', 'btn-primary', doResume)
          : makeBtn('⏸ Pause (P)', 'btn-secondary', doPause));
        controlsEl.appendChild(makeBtn('Lösung zeigen (L)', 'btn-danger', doRevealSolution));
      }
      if (gs === 'revealing') {
        controlsEl.appendChild(makeBtn('Nächste Runde (N)', 'btn-primary', doNextRound));
      }
    }
    controlsEl.appendChild(makeBtn('Reset (R)', 'btn-secondary', doReset));

    // Song form
    if (gs === 'spinning' && !autoModeratorEnabled) {
      show('song-form');
      document.getElementById('ctrl-category').innerHTML = categoryBadgeHTML(state.currentCategory, state.currentMysterySub);

      if (spotifyConnected) {
        show('spotify-search');
        show('toggle-manual');
        document.getElementById('manual-fields').classList.add('hidden');
        document.getElementById('btn-start-song').classList.remove('hidden');
      } else {
        hide('spotify-search');
        hide('toggle-manual');
        document.getElementById('manual-fields').classList.remove('hidden');
      }
    } else {
      hide('song-form');
    }

    // Current song
    if (state.currentSong && (gs === 'playing' || gs === 'revealing')) {
      show('sec-song');
      let html = '';
      if (state.currentSong.cover) {
        html += '<img src="' + state.currentSong.cover + '" style="width:60px;height:60px;border-radius:8px;vertical-align:middle;margin-right:.75rem">';
      }
      html += '<span class="song-title" style="font-size:1.1rem">' + state.currentSong.title + '</span>';
      html += '<span style="color:var(--text-dim);margin:0 .5rem">—</span>';
      html += '<span class="song-artist" style="font-size:.9rem">' + state.currentSong.artist + '</span>';
      if (state.currentSong.year) html += '<span class="song-meta" style="margin-left:.75rem">' + state.currentSong.year + '</span>';
      document.getElementById('song-display').innerHTML = html;
    } else {
      hide('sec-song');
    }

    // Answers
    if (gs === 'playing' || gs === 'revealing') {
      show('sec-answers');
      document.getElementById('answer-list').innerHTML = teams.map(t => {
        const ans = state.answers[t.id];
        let right = '';
        if (gs === 'revealing' && ans) {
          right = '<span style="color:var(--gold);font-weight:600">' + ans + '</span>';
        } else if (gs === 'playing' && ans) {
          right = '<span style="color:var(--green);font-size:.8rem">eingegangen</span>';
        }
        return '<div class="answer-item">' +
          '<div class="flex items-center gap-sm">' +
            '<span class="dot ' + (ans ? 'on' : 'off') + '"></span>' +
            '<span>' + t.emoji + ' ' + t.name + '</span>' +
          '</div>' + right + '</div>';
      }).join('');
    } else {
      hide('sec-answers');
    }

    // Team bingo cards
    document.getElementById('team-cards').innerHTML = teams.map(t => {
      const winner = t.hasBingo ? ' bingo-winner' : '';
      return '<div class="card' + winner + '" style="padding:1rem">' +
        '<div class="flex items-center justify-between mb">' +
          '<div class="flex items-center gap-sm">' +
            '<span style="font-size:1.25rem">' + t.emoji + '</span>' +
            '<span style="font-weight:600">' + t.name + '</span>' +
          '</div>' +
          '<div class="flex items-center gap-sm">' +
            '<span style="color:var(--text-dim);font-size:.8rem">' + t.score + ' Punkte</span>' +
            '<button class="btn-kick" data-team="' + t.id + '" data-name="' + t.name + '" title="Team entfernen">✕</button>' +
          '</div>' +
        '</div>' +
        '<div id="bingo-mod-' + t.id + '" class="bingo-grid small"></div>' +
        (t.hasBingo ? '<p style="text-align:center;color:var(--gold);font-family:var(--font-display);margin-top:.5rem;font-weight:700">BINGO!</p>' : '') +
      '</div>';
    }).join('');

    teams.forEach(t => {
      const container = document.getElementById('bingo-mod-' + t.id);
      if (container) {
        renderBingoCard(container, t.bingoCard, {
          small: true,
          clickable: true,
          onCellClick: (row, col) => socket.emit('mark_correct', { teamId: t.id, row, col }),
        });
      }
    });

    document.querySelectorAll('.btn-kick').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Team "' + btn.dataset.name + '" wirklich aus dem Spiel entfernen?')) {
          socket.emit('kick_team', { teamId: btn.dataset.team });
        }
      });
    });
  });

})();
