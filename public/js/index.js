/* Rundenverwaltung — creates/lists/closes rooms, no socket connection needed */

(function () {
  const sectionsEl = document.getElementById('room-sections');
  const emptyEl = document.getElementById('room-list-empty');
  const createBtn = document.getElementById('btn-create-room');
  const overlay = document.getElementById('create-room-overlay');
  const createForm = document.getElementById('create-room-form');
  const cancelBtn = document.getElementById('btn-cancel-room');
  const nameInput = document.getElementById('input-room-name');

  // Compact — one small pill link per view instead of the big illustrated
  // cards, since those get cramped fast once several rounds are running side
  // by side. The big cards are still what a round's own views (moderator,
  // etc.) use; this is just the launcher list.
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

  // Room names are free-text from the organizer — escape before dropping
  // into innerHTML so a name can't inject markup/script.
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

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
    sectionsEl.innerHTML = rooms.map(roomCardHTML).join('');

    sectionsEl.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => deleteRoom(btn.dataset.delete));
    });
  }

  function roomCardHTML(room) {
    const links = VIEWS.map((v) =>
      '<a href="' + v.path + '?room=' + encodeURIComponent(room.roomCode) + '" target="_blank" rel="noopener" ' +
      'class="btn btn-secondary" style="font-size:.75rem;padding:.4rem .7rem">' + v.icon + ' ' + v.label + '</a>'
    ).join('');

    const title = room.roomName
      ? escapeHtml(room.roomName) + ' <span style="font-size:.75rem;color:var(--text-dim);font-weight:normal">(' + room.roomCode + ')</span>'
      : room.roomCode;

    return '<div class="card mb" style="max-width:800px;margin-left:auto;margin-right:auto">' +
      '<div class="flex justify-between items-center mb">' +
        '<div>' +
          '<span style="font-family:var(--font-display);font-size:1.05rem;letter-spacing:.05em">' + title + '</span>' +
          '<div style="font-size:.75rem;color:var(--text-dim)">' +
            room.teamCount + ' Team' + (room.teamCount !== 1 ? 's' : '') + ' · ' + (STATE_LABELS[room.gameState] || room.gameState) +
          '</div>' +
        '</div>' +
        '<button class="btn btn-secondary" data-delete="' + room.roomCode + '" style="font-size:.7rem;padding:.35rem .6rem">Beenden</button>' +
      '</div>' +
      '<div class="flex gap-sm flex-wrap">' + links + '</div>' +
    '</div>';
  }

  // ── Create-room dialog ────────────────────────────────────────

  function openCreateDialog() {
    nameInput.value = '';
    overlay.classList.remove('hidden');
    nameInput.focus();
  }

  function closeCreateDialog() {
    overlay.classList.add('hidden');
  }

  async function createRoom(e) {
    e.preventDefault();
    const submitBtn = createForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const resp = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value.trim() }),
      });
      if (resp.status === 401) {
        alert('Sitzung abgelaufen — bitte Seite neu laden und erneut einloggen.');
        return;
      }
      closeCreateDialog();
      await loadRooms();
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function deleteRoom(roomCode) {
    if (!confirm('Runde ' + roomCode + ' wirklich beenden? Alle Teams werden getrennt.')) return;
    const resp = await fetch('/api/rooms/' + encodeURIComponent(roomCode), { method: 'DELETE' });
    if (resp.status === 401) {
      alert('Sitzung abgelaufen — bitte Seite neu laden und erneut einloggen.');
      return;
    }
    await loadRooms();
  }

  createBtn.addEventListener('click', openCreateDialog);
  cancelBtn.addEventListener('click', closeCreateDialog);
  createForm.addEventListener('submit', createRoom);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCreateDialog(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeCreateDialog();
  });

  loadRooms();
  setInterval(loadRooms, 10000);
})();
