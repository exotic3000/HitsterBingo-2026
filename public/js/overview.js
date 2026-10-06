/* Overview / Scoreboard View */

(function () {
  const socket = connectSocket('overview');

  const timerEl = document.getElementById('timer');

  socket.on('game_state', (state) => {
    renderRoomBadge(state);
    const gs = state.gameState;
    const teams = Object.values(state.teams);
    const sorted = [...teams].sort((a, b) => b.score - a.score);

    // Timer
    if (gs === 'playing' || gs === 'revealing') {
      timerEl.classList.remove('hidden');
      renderTimer(timerEl, state.timerValue);
    } else {
      timerEl.classList.add('hidden');
    }

    // Round
    if (state.currentCategory && gs !== 'lobby') {
      show('sec-category');
      document.getElementById('ov-round').textContent =
        'Runde ' + (state.currentRound + 1) + (state.paused ? ' · ⏸ Pausiert' : '');
    } else {
      hide('sec-category');
    }

    // Scoreboard
    if (teams.length > 0) {
      show('scoreboard');
      hide('no-teams');
      document.getElementById('score-list').innerHTML = sorted.map((t, i) => {
        const color = i === 0 ? 'var(--gold)' : 'var(--text-dim)';
        return '<div class="flex items-center justify-between" style="padding:.5rem .75rem;' +
          (i < sorted.length - 1 ? 'border-bottom:1px solid var(--border)' : '') + '">' +
          '<div class="flex items-center gap-sm">' +
            '<span style="font-family:var(--font-display);font-size:.8rem;color:' + color + ';width:24px">#' + (i + 1) + '</span>' +
            '<span style="font-size:1.25rem">' + t.emoji + '</span>' +
            '<span style="font-weight:600">' + t.name + '</span>' +
            (t.hasBingo ? '<span style="color:var(--gold);font-size:.7rem;font-family:var(--font-display);margin-left:.5rem">BINGO</span>' : '') +
          '</div>' +
          '<span style="font-family:var(--font-display);font-size:.9rem">' + t.score + '</span>' +
        '</div>';
      }).join('');
    } else {
      hide('scoreboard');
      show('no-teams');
    }

    // Team cards
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
        '<div id="bingo-ov-' + t.id + '" class="bingo-grid small"></div>' +
      '</div>';
    }).join('');

    teams.forEach(t => {
      const container = document.getElementById('bingo-ov-' + t.id);
      if (container) {
        renderBingoCard(container, t.bingoCard, { small: true });
      }
    });
  });

  socket.on('timer_tick', (val) => {
    if (!timerEl.classList.contains('hidden')) renderTimer(timerEl, val);
  });
})();
