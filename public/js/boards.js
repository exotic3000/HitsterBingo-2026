/* Boards View — read-only, big-screen overview of every team's live bingo card */

(function () {
  const socket = connectSocket();
  socket.emit('join', { role: 'boards' });

  const timerEl = document.getElementById('timer');

  socket.on('game_state', (state) => {
    const gs = state.gameState;
    const teams = Object.values(state.teams);

    if (gs === 'playing' || gs === 'revealing') {
      timerEl.classList.remove('hidden');
      renderTimer(timerEl, state.timerValue);
    } else {
      timerEl.classList.add('hidden');
    }

    if (!teams.length) {
      document.getElementById('team-cards').innerHTML = '';
      show('no-teams');
      return;
    }
    hide('no-teams');

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
        '<div id="bingo-bd-' + t.id + '"></div>' +
        (t.hasBingo ? '<p style="text-align:center;color:var(--gold);font-family:var(--font-display);margin-top:.5rem;font-weight:700">BINGO!</p>' : '') +
      '</div>';
    }).join('');

    teams.forEach(t => {
      const container = document.getElementById('bingo-bd-' + t.id);
      if (container) renderBingoCard(container, t.bingoCard);
    });
  });

  socket.on('timer_tick', (val) => {
    if (!timerEl.classList.contains('hidden')) renderTimer(timerEl, val);
  });
})();
