/* Teamer View — a helper picks the physical team they're watching and
   keeps that team's bingo card in sync with the moderator view. */

(function () {
  const socket = connectSocket();
  socket.emit('join', { role: 'teamer' });

  const STORAGE_KEY = 'hitster_teamer_team_id';
  let myTeamId = localStorage.getItem(STORAGE_KEY) || null;

  const teamListEl = document.getElementById('team-list');

  function renderTeamList(teams) {
    if (!teams.length) {
      teamListEl.innerHTML = '';
      show('no-teams-msg');
      return;
    }
    hide('no-teams-msg');
    teamListEl.innerHTML = teams.map(t =>
      '<button class="btn btn-secondary team-pick" data-id="' + t.id + '">' +
        '<span style="font-size:1.25rem">' + t.emoji + '</span><span>' + t.name + '</span>' +
      '</button>'
    ).join('');
    teamListEl.querySelectorAll('.team-pick').forEach(btn => {
      btn.addEventListener('click', () => selectTeam(btn.dataset.id));
    });
  }

  function selectTeam(teamId) {
    myTeamId = teamId;
    localStorage.setItem(STORAGE_KEY, teamId);
  }

  document.getElementById('btn-switch').addEventListener('click', () => {
    myTeamId = null;
    localStorage.removeItem(STORAGE_KEY);
    hide('sec-card');
    show('sec-select');
  });

  socket.on('game_state', (state) => {
    const teams = Object.values(state.teams);
    renderTeamList(teams);

    if (myTeamId && !state.teams[myTeamId]) {
      myTeamId = null;
      localStorage.removeItem(STORAGE_KEY);
    }

    if (myTeamId) {
      const team = state.teams[myTeamId];
      hide('sec-select');
      show('sec-card');

      document.getElementById('team-emoji').textContent = team.emoji;
      document.getElementById('team-name').textContent = team.name;
      document.getElementById('team-score').textContent = team.score + ' Punkte';

      renderBingoCard(document.getElementById('bingo-teamer'), team.bingoCard, {
        clickable: true,
        onCellClick: (row, col) => socket.emit('mark_correct', { teamId: myTeamId, row, col }),
      });

      if (team.hasBingo) show('team-bingo-msg');
      else hide('team-bingo-msg');
    } else {
      show('sec-select');
      hide('sec-card');
    }
  });
})();
