/* Rundenverwaltung — creates/lists/closes rooms, no socket connection needed */

(function () {
  const sectionsEl = document.getElementById('room-sections');
  const emptyEl = document.getElementById('room-list-empty');
  const createBtn = document.getElementById('btn-create-room');

  // Same cards/copy as the original single-game home screen — just repeated
  // once per room now, with the room code appended to each link.
  const VIEWS = [
    { icon: '🖥️', label: 'Beamer-Ansicht', desc: 'Drehrad, Timer &amp; Lösung für die Leinwand', path: '/display.html' },
    { icon: '🎙️', label: 'Moderation', desc: 'Spielsteuerung, Antworten &amp; Bingokarten', path: '/moderator.html' },
    { icon: '📱', label: 'Team erstellen', desc: 'Antworten eingeben &amp; Bingokarte sehen', path: '/team.html' },
    { icon: '📷', label: 'QR-Code', desc: 'Beitritts-Code zum Scannen, separat anzeigbar', path: '/qr.html' },
    { icon: '🏆', label: 'Übersicht', desc: 'Alle Bingokarten, Rangliste &amp; Runde auf einen Blick', path: '/overview.html' },
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
      sectionsEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    sectionsEl.innerHTML = rooms.map(roomSectionHTML).join('');

    sectionsEl.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => deleteRoom(btn.dataset.delete));
    });
  }

  function roomSectionHTML(room) {
    const cards = VIEWS.map((v) =>
      '<a href="' + v.path + '?room=' + encodeURIComponent(room.roomCode) + '" target="_blank" rel="noopener" class="card home-card">' +
        '<div class="icon">' + v.icon + '</div>' +
        '<h3>' + v.label + '</h3>' +
        '<p>' + v.desc + '</p>' +
      '</a>'
    ).join('');

    return '<div style="max-width:800px;margin:0 auto 3rem">' +
      '<div class="flex justify-between items-center mb">' +
        '<div>' +
          '<span style="font-family:var(--font-display);font-size:1.3rem;letter-spacing:.15em">' + room.roomCode + '</span>' +
          '<span style="font-size:.8rem;color:var(--text-dim);margin-left:.75rem">' +
            room.teamCount + ' Team' + (room.teamCount !== 1 ? 's' : '') + ' · ' + (STATE_LABELS[room.gameState] || room.gameState) +
          '</span>' +
        '</div>' +
        '<button class="btn btn-secondary" data-delete="' + room.roomCode + '" style="font-size:.75rem;padding:.4rem .8rem">Runde beenden</button>' +
      '</div>' +
      '<div class="home-grid">' + cards + '</div>' +
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
