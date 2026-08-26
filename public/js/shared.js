/* Shared helpers used by all pages */

const TEAM_EMOJIS = ['🚀','🌟','🪐','👽','🛸','☄️','🌙','⭐','🔭','🌌','💫','🛰️'];

const CAT_MAP = {
  artist:  { name:'Interpret',  color:'#ff4d6d', icon:'🎤' },
  title:   { name:'Titel',      color:'#4cc9f0', icon:'🎵' },
  decade:  { name:'Jahrzehnt',  color:'#7209b7', icon:'📅' },
  year4:   { name:'Jahr ±4',    color:'#f72585', icon:'🎯' },
  mystery: { name:'?',          color:'#4361ee', icon:'❓' },
};

/* ── Room code ──────────────────────────────────────────────── */

function getRoomCode() {
  return new URLSearchParams(location.search).get('room') || '';
}

/* ── Socket wrapper ─────────────────────────────────────────── */
// The room is bound once, at the handshake, via a query param the server
// reads before any 'join' — every view already knows its own room from its
// own URL before it opens a socket at all (see server.js's io.on('connection')).

function connectSocket() {
  const socket = io({ query: { room: getRoomCode() } });
  const connDot = document.getElementById('conn');

  socket.on('connect', () => { if (connDot) connDot.className = 'conn on'; });
  socket.on('disconnect', () => { if (connDot) connDot.className = 'conn off'; });
  socket.on('invalid_room', () => showRoomUnavailableOverlay());
  socket.on('room_closed', () => showRoomUnavailableOverlay());

  return socket;
}

function showRoomUnavailableOverlay() {
  if (document.getElementById('room-unavailable-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'room-unavailable-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,14,39,.95);'
    + 'color:#e0e6ff;display:flex;flex-direction:column;align-items:center;justify-content:center;'
    + 'gap:1rem;text-align:center;padding:2rem;font-family:inherit';
  overlay.innerHTML = '<div style="font-size:2.5rem">❌</div>'
    + '<p style="max-width:420px">Diese Runde ist nicht (mehr) verfügbar. Bitte den Link erneut über die Rundenübersicht öffnen.</p>'
    + '<a href="/" class="btn btn-primary">Zur Rundenübersicht</a>';
  document.body.appendChild(overlay);
}

/* ── Bingo card renderer ────────────────────────────────────── */

function renderBingoCard(container, card, options) {
  const opts = Object.assign({ small: false, clickable: false, onCellClick: null }, options);
  container.innerHTML = '';
  container.className = 'bingo-grid' + (opts.small ? ' small' : '');

  card.forEach((row, r) => {
    row.forEach((cell, c) => {
      const div = document.createElement('div');
      div.className = 'bingo-cell' + (cell.checked ? ' checked' : '');
      div.setAttribute('data-cat', cell.categoryId);

      const cat = CAT_MAP[cell.categoryId];
      if (!cell.checked) {
        div.textContent = opts.small ? cat.icon : cat.name;
      }
      div.title = cat.name;

      if (opts.clickable) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => {
          if (opts.onCellClick) opts.onCellClick(r, c);
        });
      }

      container.appendChild(div);
    });
  });
}

/* ── Timer renderer ─────────────────────────────────────────── */

function renderTimer(el, value) {
  const m = Math.floor(value / 60);
  const s = value % 60;
  el.textContent = m + ':' + String(s).padStart(2, '0');
  el.className = 'timer';
  if (value <= 10) el.classList.add('danger');
  else if (value <= 20) el.classList.add('warning');
}

/* ── Category badge HTML ────────────────────────────────────── */

function categoryBadgeHTML(cat, sub) {
  if (!cat) return '';
  const c = typeof cat === 'string' ? CAT_MAP[cat] : cat;
  const isMystery = (cat.id || cat) === 'mystery';

  let icon = c.icon || '';
  let text = c.name || cat.name || '';
  if (sub) {
    if (isMystery && sub.icon) {
      // Show the resolved sub-category instead of a redundant "❓ ?"
      icon = sub.icon;
      text = sub.name || sub;
    } else {
      text += ': ' + (sub.name || sub);
    }
  }

  const label = icon + ' ' + text;
  const color = c.color || cat.color || 'var(--accent)';
  return '<span class="category-badge" style="background:' + color + '">' + label + '</span>';
}

/* ── Wheel drawing ──────────────────────────────────────────── */

function drawWheel(canvas, categories, rotationDeg) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 10;
  const segAngle = (2 * Math.PI) / categories.length;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotationDeg * Math.PI) / 180);

  categories.forEach((cat, i) => {
    const start = i * segAngle - Math.PI / 2;
    const end = start + segAngle;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = cat.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.rotate(start + segAngle / 2 + Math.PI / 2);
    ctx.translate(0, -radius * 0.6);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + (size / 18) + 'px Orbitron, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cat.icon, 0, -12);
    ctx.font = 'bold ' + (size / 25) + 'px Orbitron, monospace';
    ctx.fillText(cat.name, 0, 12);
    ctx.restore();
  });

  ctx.beginPath();
  ctx.arc(0, 0, 28, 0, 2 * Math.PI);
  ctx.fillStyle = '#0a0e27';
  ctx.fill();
  ctx.strokeStyle = '#ffd60a';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

/* ── Helper: show/hide by id ────────────────────────────────── */

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
