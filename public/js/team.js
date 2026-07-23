/* Team / Mobile View */

(function () {
  const socket = connectSocket();
  const STORAGE_KEY = 'hitsterbingo_team_id';

  let myTeamId = null;
  let selectedEmoji = '🚀';
  let submitted = false;
  let lastRound = -1;

  // Setup: Emoji picker
  const emojiGrid = document.getElementById('emoji-grid');
  TEAM_EMOJIS.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn' + (e === selectedEmoji ? ' selected' : '');
    btn.textContent = e;
    btn.addEventListener('click', () => {
      selectedEmoji = e;
      emojiGrid.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    emojiGrid.appendChild(btn);
  });

  // Setup: Name input
  const nameInput = document.getElementById('input-name');
  const joinBtn = document.getElementById('btn-join');
  nameInput.addEventListener('input', () => {
    joinBtn.disabled = !nameInput.value.trim();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && nameInput.value.trim()) doJoin();
  });
  joinBtn.addEventListener('click', doJoin);

  // Ask the server for a team id, reusing a previous one if we have it so a
  // dropped connection or page reload doesn't wipe the team's bingo card.
  function requestTeamId(existingId, onAssigned) {
    socket.emit('join', { role: 'team', teamId: existingId || undefined });
    socket.once('team_assigned', (id) => {
      myTeamId = id;
      localStorage.setItem(STORAGE_KEY, id);
      onAssigned(id);
    });
  }

  function doJoin() {
    const name = nameInput.value.trim();
    if (!name) return;
    if (myTeamId) {
      // Session already resumed/joined for this connection — just (re)name it.
      socket.emit('update_team', { teamId: myTeamId, name: name, emoji: selectedEmoji });
      hide('sec-setup');
      show('sec-game');
      return;
    }
    requestTeamId(localStorage.getItem(STORAGE_KEY), (id) => {
      socket.emit('update_team', { teamId: id, name: name, emoji: selectedEmoji });
      hide('sec-setup');
      show('sec-game');
    });
  }

  // On every connect (initial load, or an automatic reconnect after a
  // dropped connection), silently try to resume a known team id instead of
  // waiting for the user to re-enter their name.
  socket.on('connect', () => {
    const idToResume = myTeamId || localStorage.getItem(STORAGE_KEY);
    if (!idToResume) return;
    requestTeamId(idToResume, (id) => {
      if (id === idToResume) {
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
  });

  socket.on('kicked', () => {
    localStorage.removeItem(STORAGE_KEY);
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
