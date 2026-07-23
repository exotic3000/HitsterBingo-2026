/* Team / Mobile View */

(function () {
  const socket = connectSocket();
  const STORAGE_KEY = 'hitsterbingo_team_id';

  let myTeamId = null;
  let selectedEmoji = '🚀';
  let submitted = false;
  let lastRound = -1;
  let latestTeams = {};
  let lastState = null;

  // Setup: Emoji picker
  const emojiGrid = document.getElementById('emoji-grid');
  const setupError = document.getElementById('setup-error');

  function showSetupError(msg) {
    setupError.textContent = msg;
    setupError.classList.remove('hidden');
  }
  function hideSetupError() {
    setupError.classList.add('hidden');
  }

  function isNameTaken(name) {
    return Object.values(latestTeams).some(
      (t) => t.id !== myTeamId && t.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
  }

  // Grey out emoji already claimed by another team; nudge selection off a
  // freshly-taken emoji so the join button doesn't silently keep failing.
  function refreshEmojiAvailability() {
    const takenEmojis = new Set(
      Object.values(latestTeams).filter(t => t.id !== myTeamId).map(t => t.emoji)
    );
    emojiGrid.querySelectorAll('.emoji-btn').forEach(btn => {
      const taken = takenEmojis.has(btn.textContent);
      btn.classList.toggle('taken', taken);
    });
    if (takenEmojis.has(selectedEmoji)) {
      const free = TEAM_EMOJIS.find(e => !takenEmojis.has(e));
      if (free) {
        selectedEmoji = free;
        emojiGrid.querySelectorAll('.emoji-btn').forEach(b => b.classList.toggle('selected', b.textContent === free));
      }
    }
  }

  TEAM_EMOJIS.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn' + (e === selectedEmoji ? ' selected' : '');
    btn.textContent = e;
    btn.addEventListener('click', () => {
      if (btn.classList.contains('taken')) return;
      selectedEmoji = e;
      hideSetupError();
      emojiGrid.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    emojiGrid.appendChild(btn);
  });

  // Setup: Name input
  const nameInput = document.getElementById('input-name');
  const joinBtn = document.getElementById('btn-join');
  nameInput.addEventListener('input', () => {
    const name = nameInput.value.trim();
    if (name && isNameTaken(name)) {
      showSetupError('Dieser Teamname ist bereits vergeben.');
      joinBtn.disabled = true;
      return;
    }
    hideSetupError();
    joinBtn.disabled = !name;
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && nameInput.value.trim()) doJoin();
  });
  joinBtn.addEventListener('click', doJoin);

  // Ask the server to (re)join a team. Resuming an existing id needs no
  // name/emoji; creating a new one sends them so the server can validate
  // uniqueness before the team is even created (avoids leaving a
  // half-created team behind on a rejected name/emoji).
  function requestTeamId(existingId, name, emoji, onResult) {
    socket.emit('join', { role: 'team', teamId: existingId || undefined, name, emoji }, (res) => {
      if (res && res.ok && res.teamId) {
        myTeamId = res.teamId;
        sessionStorage.setItem(STORAGE_KEY, res.teamId);
        // The game_state broadcasts triggered by our own join already
        // arrived while myTeamId was still null, so they were ignored —
        // re-apply the last one now that we know which team is ours.
        if (lastState) applyGameState(lastState);
      }
      onResult(res);
    });
  }

  function doJoin() {
    const name = nameInput.value.trim();
    if (!name) return;
    hideSetupError();
    joinBtn.disabled = true;

    // This button always creates a brand-new team — never reuse an id
    // cached from a team this device joined earlier.
    sessionStorage.removeItem(STORAGE_KEY);
    myTeamId = null;

    requestTeamId(undefined, name, selectedEmoji, (res) => {
      joinBtn.disabled = false;
      if (!res || res.ok === false) {
        showSetupError((res && res.message) || 'Fehler beim Erstellen des Teams.');
        return;
      }
      hide('sec-setup');
      show('sec-game');
    });
  }

  // On every connect (initial load, or an automatic reconnect after a
  // dropped connection), silently try to resume a known team id instead of
  // waiting for the user to re-enter their name.
  socket.on('connect', () => {
    const idToResume = myTeamId || sessionStorage.getItem(STORAGE_KEY);
    if (!idToResume) return;
    requestTeamId(idToResume, null, null, (res) => {
      if (res && res.ok && res.teamId === idToResume) {
        hide('sec-setup');
        show('sec-game');
      }
      // else: server no longer knows this id (e.g. it restarted) — the
      // setup screen stays visible so the team can (re)join normally.
    });
  });

  // Submit answer
  const answerInput = document.getElementById('input-answer');
  document.getElementById('btn-submit').addEventListener('click', submitAnswer);
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAnswer();
  });

  function submitAnswer() {
    const val = answerInput.value.trim();
    if (!val || !myTeamId) return;
    socket.emit('submit_answer', { teamId: myTeamId, answer: val });
    submitted = true;
    hide('answer-form');
    show('answer-sent');
    document.getElementById('answer-echo').textContent = '„' + val + '"';
  }

  // Game state
  socket.on('game_state', (state) => {
    lastState = state;
    applyGameState(state);
  });

  function applyGameState(state) {
    latestTeams = state.teams || {};
    refreshEmojiAvailability();

    if (!myTeamId) return;
    const team = state.teams[myTeamId];
    if (!team) return;

    document.getElementById('my-emoji').textContent = team.emoji;
    document.getElementById('my-name').textContent = team.name;

    // Reset on new round
    if (state.currentRound !== lastRound || state.gameState === 'spinning') {
      submitted = false;
      answerInput.value = '';
      show('answer-form');
      hide('answer-sent');
      lastRound = state.currentRound;
    }

    const gs = state.gameState;
    const timerEl = document.getElementById('timer');

    // Hide all game sections
    ['sec-waiting', 'sec-answer', 'sec-reveal'].forEach(id => hide(id));
    timerEl.classList.add('hidden');

    if (gs === 'lobby' || gs === 'between_rounds') {
      show('sec-waiting');
      renderBingoCard(document.getElementById('bingo-waiting'), team.bingoCard);
    }

    if (gs === 'spinning') {
      show('sec-waiting');
      renderBingoCard(document.getElementById('bingo-waiting'), team.bingoCard);
    }

    if (gs === 'playing') {
      show('sec-answer');
      timerEl.classList.remove('hidden');
      renderTimer(timerEl, state.timerValue);
      document.getElementById('answer-category').innerHTML = categoryBadgeHTML(state.currentCategory, state.currentMysterySub);
      renderBingoCard(document.getElementById('bingo-play'), team.bingoCard);

      if (submitted) {
        hide('answer-form');
        show('answer-sent');
      }
    }

    if (gs === 'revealing') {
      show('sec-reveal');
      timerEl.classList.remove('hidden');
      renderTimer(timerEl, state.timerValue);
      const songEl = document.getElementById('reveal-song');
      if (state.currentSong) {
        songEl.innerHTML =
          '<div class="text-center" style="padding:1.5rem">' +
            '<p style="font-size:.75rem;color:var(--text-dim);font-family:var(--font-display)">Lösung</p>' +
            '<p class="song-title">' + state.currentSong.title + '</p>' +
            '<p class="song-artist">' + state.currentSong.artist + '</p>' +
            (state.currentSong.year ? '<p class="song-meta">' + state.currentSong.year + '</p>' : '') +
          '</div>';
      }
      renderBingoCard(document.getElementById('bingo-reveal'), team.bingoCard);
    }

    // Bingo!
    if (team.hasBingo) show('sec-bingo');
    else hide('sec-bingo');
  }

  socket.on('kicked', () => {
    sessionStorage.removeItem(STORAGE_KEY);
    myTeamId = null;
    submitted = false;
    hide('sec-game');
    show('sec-setup');
    document.getElementById('kicked-notice').classList.remove('hidden');
    nameInput.value = '';
    joinBtn.disabled = true;
  });

  socket.on('timer_tick', (val) => {
    const timerEl = document.getElementById('timer');
    if (!timerEl.classList.contains('hidden')) renderTimer(timerEl, val);
  });
})();
