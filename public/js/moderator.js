/* Moderator Control View — with Spotify search */

(function () {
  const socket = connectSocket();
  socket.emit('join', { role: 'moderator' });

  const controlsEl = document.getElementById('controls');
  let selectedSong = null;
  let searchTimeout = null;
  let spotifyConnected = false;

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
      const resp = await fetch('/api/spotify/search?q=' + encodeURIComponent(q));
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

  // ── Random song from playlist ──────────────────────────────────

  const randomBtn = document.getElementById('btn-random-song');

  randomBtn.addEventListener('click', async () => {
    resultsEl.innerHTML = '<p style="color:var(--text-dim);padding:.5rem">Wähle zufälligen Song...</p>';
    try {
      const resp = await fetch('/api/spotify/playlist-random');
      const data = await resp.json();
      if (data.error) {
        resultsEl.innerHTML = '<p style="color:var(--pink);padding:.5rem">' + data.error + '</p>';
        return;
      }
      selectSpotifyTrack(data.track);
    } catch (e) {
      resultsEl.innerHTML = '<p style="color:var(--pink);padding:.5rem">Fehler: ' + e.message + '</p>';
    }
  });

  // ── Start song ─────────────────────────────────────────────────

  document.getElementById('btn-start-song').addEventListener('click', () => {
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
  });

  // ── Toggle manual input ────────────────────────────────────────

  const btnToggle = document.getElementById('btn-toggle-manual');
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      const fields = document.getElementById('manual-fields');
      fields.classList.toggle('hidden');
      btnToggle.textContent = fields.classList.contains('hidden') ? 'Manuell eingeben' : 'Verbergen';
    });
  }

  // ── Game state rendering ───────────────────────────────────────

  socket.on('game_state', (state) => {
    const gs = state.gameState;
    const teams = Object.values(state.teams);

    // Spotify status bar
    spotifyConnected = state.spotifyReady;
    const bar = document.getElementById('spotify-bar');
    const icon = document.getElementById('spotify-icon');
    const statusTxt = document.getElementById('spotify-status');
    const link = document.getElementById('spotify-link');

    if (spotifyConnected) {
      bar.className = 'spotify-bar connected mb';
      icon.textContent = '🎵';
      statusTxt.textContent = 'Spotify verbunden';
      link.textContent = 'Neu verbinden';
    } else {
      bar.className = 'spotify-bar disconnected mb';
      icon.textContent = '🔇';
      statusTxt.textContent = 'Spotify nicht verbunden';
      link.textContent = 'Verbinden';
    }

    // Controls
    controlsEl.innerHTML = '';
    if (gs === 'lobby' || gs === 'between_rounds') {
      controlsEl.appendChild(makeBtn('Drehen', 'btn-primary', () => socket.emit('start_spin')));
    }
    if (gs === 'playing') {
      controlsEl.appendChild(makeBtn('Lösung zeigen', 'btn-danger', () => socket.emit('reveal_solution')));
    }
    if (gs === 'revealing') {
      controlsEl.appendChild(makeBtn('Nächste Runde', 'btn-primary', () => {
        socket.emit('next_round');
        document.getElementById('input-title').value = '';
        document.getElementById('input-artist').value = '';
        document.getElementById('input-year').value = '';
        searchInput.value = '';
        resultsEl.innerHTML = '';
        selectedSong = null;
      }));
    }
    controlsEl.appendChild(makeBtn('Reset', 'btn-secondary', () => socket.emit('reset_game')));

    // Song form
    if (gs === 'spinning') {
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
          '<span style="color:var(--text-dim);font-size:.8rem">' + t.score + ' Punkte</span>' +
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
  });

})();
