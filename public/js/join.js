/* Generic join picker — reachable from the one QR code that stays the same
   all event long. The player types a code or name and picks their round
   themselves; nothing here assumes which round that is. */

(function () {
  const input = document.getElementById('input-code');
  const resultsEl = document.getElementById('results');
  const hintEl = document.getElementById('hint');
  const emptyEl = document.getElementById('empty-msg');

  let rooms = [];
  let matches = [];

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function loadRooms() {
    try {
      const resp = await fetch('/api/rooms');
      const data = await resp.json();
      rooms = data.rooms || [];
      render();
    } catch (e) { /* keep showing the last known list */ }
  }

  function matchesQuery(room, query) {
    const q = query.toLowerCase();
    return room.roomCode.toLowerCase().includes(q) || (room.roomName || '').toLowerCase().includes(q);
  }

  function render() {
    const query = input.value.trim();

    if (!query) {
      resultsEl.innerHTML = '';
      hintEl.classList.remove('hidden');
      emptyEl.classList.add('hidden');
      matches = [];
      return;
    }
    hintEl.classList.add('hidden');

    matches = rooms.filter((r) => matchesQuery(r, query));

    if (!matches.length) {
      resultsEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    resultsEl.innerHTML = matches.map((room) => {
      const title = room.roomName
        ? escapeHtml(room.roomName) + ' <span style="color:var(--text-dim);font-size:.8rem;font-weight:normal">(' + room.roomCode + ')</span>'
        : room.roomCode;
      return '<button type="button" class="card" data-code="' + room.roomCode + '" ' +
        'style="width:100%;display:block;text-align:left;cursor:pointer;margin-top:.5rem;font-family:inherit;color:inherit;padding:.85rem 1rem">' +
        '<span style="font-family:var(--font-display);font-size:.95rem">' + title + '</span>' +
      '</button>';
    }).join('');

    resultsEl.querySelectorAll('[data-code]').forEach((btn) => {
      btn.addEventListener('click', () => joinRoom(btn.dataset.code));
    });
  }

  function joinRoom(roomCode) {
    location.href = '/team.html?room=' + encodeURIComponent(roomCode);
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches.length === 1) joinRoom(matches[0].roomCode);
  });

  loadRooms();
  setInterval(loadRooms, 8000);
})();
