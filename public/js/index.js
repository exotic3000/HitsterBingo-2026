/* Rundenverwaltung — creates/lists/closes rooms, no socket connection needed */

(function () {
  const listEl = document.getElementById('room-list');
  const emptyEl = document.getElementById('room-list-empty');
  const createBtn = document.getElementById('btn-create-room');

  const VIEWS = [
    { icon: '🖥️', label: 'Beamer', path: '/display.html' },
    { icon: '🎙️', label: 'Moderation', path: '/moderator.html' },
    { icon: '📱', label: 'Team', path: '/team.html' },
    { icon: '📷', label: 'QR-Code', path: '/qr.html' },
    { icon: '🏆', label: 'Übersicht', path: '/overview.html' },
  ];

  const STATE_LABELS = {
    lobby: 'Lobby',
    spinning: 'Dreht...',
    playing: 'Läuft',
    revealing: 'Auflösung',
    between_rounds: 'Zwischen Runden',
  };

  async function loadRooms() {
    const resp = await fetch('/api/rooms');
    const data = await resp.json();
    renderRooms(data.rooms || []);
  }

  function renderRooms(rooms) {
    if (!rooms.length) {
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = rooms.map(roomCardHTML).join('');

    listEl.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => deleteRoom(btn.dataset.delete));
    });
  }

  function roomCardHTML(room) {
    const links = VIEWS.map((v) =>
      '<a href="' + v.path + '?room=' + encodeURIComponent(room.roomCode) + '" target="_blank" rel="noopener" ' +
      'class="btn btn-secondary" style="font-size:.75rem;padding:.4rem .7rem">' + v.icon + ' ' + v.label + '</a>'
    ).join('');

    return '<div class="card mb">' +
      '<div class="flex justify-between items-center mb">' +
        '<div>' +
          '<div style="font-family:var(--font-display);font-size:1.1rem;letter-spacing:.1em">' + room.roomCode + '</div>' +
          '<div style="font-size:.75rem;color:var(--text-dim)">' +
            room.teamCount + ' Team' + (room.teamCount !== 1 ? 's' : '') + ' · ' + (STATE_LABELS[room.gameState] || room.gameState) +
          '</div>' +
        '</div>' +
        '<button class="btn btn-secondary" data-delete="' + room.roomCode + '" style="font-size:.7rem;padding:.35rem .6rem">Beenden</button>' +
      '</div>' +
      '<div class="flex gap-sm flex-wrap">' + links + '</div>' +
    '</div>';
  }

  async function createRoom() {
    createBtn.disabled = true;
    try {
      await fetch('/api/rooms', { method: 'POST' });
      await loadRooms();
    } finally {
      createBtn.disabled = false;
    }
  }

  async function deleteRoom(roomCode) {
    if (!confirm('Runde ' + roomCode + ' wirklich beenden? Alle Teams werden getrennt.')) return;
    await fetch('/api/rooms/' + encodeURIComponent(roomCode), { method: 'DELETE' });
    await loadRooms();
  }

  createBtn.addEventListener('click', createRoom);
  loadRooms();
  setInterval(loadRooms, 10000);
})();
