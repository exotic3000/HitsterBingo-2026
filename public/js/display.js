/* Beamer / Display View — wheel always visible */

(function () {
  // ── Title / Splash Screen ────────────────────────────────────

  (function initSplash() {
    var splash = document.getElementById('splash-screen');
    if (!splash) return;

    var visible = true;
    function hideSplash() {
      if (!visible) return;
      visible = false;
      splash.classList.add('leaving');
      setTimeout(function () { splash.classList.add('hidden'); }, 900);
    }
    function showSplash() {
      visible = true;
      splash.classList.remove('leaving', 'hidden');
    }

    // "T" (Titel) brings the splash back at any point during the show, e.g.
    // for a break — any other key or a click dismisses it again.
    window.addEventListener('keydown', function (e) {
      if (e.key === 'T' || e.key === 't') { showSplash(); return; }
      hideSplash();
    });
    splash.addEventListener('click', hideSplash);
  })();

  const socket = connectSocket();
  socket.emit('join', { role: 'display' });

  // ── Particles ──────────────────────────────────────────────────

  const particlesCanvas = document.getElementById('particles-canvas');
  const pCtx = particlesCanvas.getContext('2d');
  let particles = [];

  function resizeParticles() {
    particlesCanvas.width = window.innerWidth;
    particlesCanvas.height = window.innerHeight;
  }
  resizeParticles();
  window.addEventListener('resize', resizeParticles);

  function spawnBurst(cx, cy, color, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 6;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.008 + Math.random() * 0.015,
        size: 2 + Math.random() * 4,
        color: color,
      });
    }
  }

  function tickParticles() {
    pCtx.clearRect(0, 0, particlesCanvas.width, particlesCanvas.height);
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04;
      p.life -= p.decay;
      pCtx.globalAlpha = p.life;
      pCtx.fillStyle = p.color;
      pCtx.shadowColor = p.color;
      pCtx.shadowBlur = 8;
      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      pCtx.fill();
    }
    pCtx.globalAlpha = 1;
    pCtx.shadowBlur = 0;
    requestAnimationFrame(tickParticles);
  }
  tickParticles();

  // ── Wheel ──────────────────────────────────────────────────────

  const canvas = document.getElementById('wheel-canvas');
  const ctx = canvas.getContext('2d');
  const SIZE = canvas.width;

  let categories = [];
  let wheelAngle = 0;
  let isSpinning = false;
  let spinHandled = false;

  function drawWheel(angleDeg, highlightIdx) {
    const count = categories.length;
    if (!count) return;
    const segAngle = (2 * Math.PI) / count;
    const radius = SIZE / 2 - 16;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);

    // Outer glow ring
    ctx.beginPath();
    ctx.arc(0, 0, radius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(124,58,237,.3)';
    ctx.lineWidth = 8;
    ctx.shadowColor = 'rgba(124,58,237,.5)';
    ctx.shadowBlur = 30;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.rotate((angleDeg * Math.PI) / 180);

    for (let i = 0; i < count; i++) {
      const cat = categories[i];
      const start = i * segAngle - Math.PI / 2;
      const end = start + segAngle;
      const isHighlighted = i === highlightIdx;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, start, end);
      ctx.closePath();

      if (isHighlighted) {
        ctx.fillStyle = cat.color;
        ctx.shadowColor = cat.color;
        ctx.shadowBlur = 40;
      } else {
        var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        grad.addColorStop(0, cat.color + '55');
        grad.addColorStop(0.6, cat.color + 'cc');
        grad.addColorStop(1, cat.color);
        ctx.fillStyle = grad;
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = 'rgba(255,255,255,.15)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Inner decorative arc
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.35, start, end);
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Text + icon
      ctx.save();
      var midAngle = start + segAngle / 2;
      var textR = radius * 0.65;
      ctx.rotate(midAngle);
      ctx.translate(textR, 0);
      ctx.rotate(Math.PI / 2);

      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold ' + (SIZE / 14) + 'px serif';
      ctx.fillText(cat.icon, 0, -16);
      ctx.font = 'bold ' + (SIZE / 28) + 'px Orbitron, monospace';
      ctx.shadowColor = 'rgba(0,0,0,.7)';
      ctx.shadowBlur = 4;
      ctx.fillText(cat.name, 0, 14);
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // Center hub
    var hubGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 36);
    hubGrad.addColorStop(0, '#1a2147');
    hubGrad.addColorStop(1, '#0a0e27');
    ctx.beginPath();
    ctx.arc(0, 0, 36, 0, Math.PI * 2);
    ctx.fillStyle = hubGrad;
    ctx.fill();
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ffd60a';
    ctx.shadowBlur = 15;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Hub star
    ctx.fillStyle = '#ffd60a';
    ctx.font = 'bold 24px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', 0, 1);

    ctx.restore();
  }

  // Idle floating animation when not spinning
  let idleAnimId = null;
  function startIdleFloat() {
    stopIdleFloat();
    var startTime = performance.now();
    function tick(now) {
      if (isSpinning) return;
      var t = (now - startTime) / 1000;
      var drift = Math.sin(t * 0.3) * 2;
      drawWheel(wheelAngle + drift, null);
      idleAnimId = requestAnimationFrame(tick);
    }
    idleAnimId = requestAnimationFrame(tick);
  }
  function stopIdleFloat() {
    if (idleAnimId) { cancelAnimationFrame(idleAnimId); idleAnimId = null; }
  }

  function spinWheel(targetCatId) {
    if (isSpinning) return;
    isSpinning = true;
    spinHandled = false;
    stopIdleFloat();

    var idx = categories.findIndex(function(c) { return c.id === targetCatId; });
    var segAngle = 360 / categories.length;
    var desiredPos = ((360 - idx * segAngle - segAngle / 2) % 360 + 360) % 360;
    var currentPos = ((wheelAngle % 360) + 360) % 360;
    var delta = ((desiredPos - currentPos) % 360 + 360) % 360;
    var targetStop = wheelAngle + 360 * 8 + delta;
    var startAngle = wheelAngle;
    var duration = 5500;
    var startTime = performance.now();
    var lastTickIdx = -1;

    document.getElementById('result-overlay').classList.remove('visible');
    document.getElementById('wheel-ring').classList.remove('glowing');

    function animate(now) {
      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 5);
      wheelAngle = startAngle + (targetStop - startAngle) * ease;

      // Tick particles at segment boundaries
      var currentSegIdx = Math.floor(((wheelAngle % 360) + 360) % 360 / segAngle);
      if (currentSegIdx !== lastTickIdx && progress < 0.9) {
        lastTickIdx = currentSegIdx;
        var rect = canvas.getBoundingClientRect();
        var px = rect.left + rect.width / 2;
        var py = rect.top;
        var col = categories[currentSegIdx % categories.length].color;
        spawnBurst(px, py, col, 3);
      }

      drawWheel(wheelAngle, null);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        isSpinning = false;
        showResult(idx);
      }
    }
    requestAnimationFrame(animate);
  }

  // Smoothly morphs the result icon (e.g. the red "❓") into a new emoji
  function morphResultIcon(newIcon) {
    var iconEl = document.getElementById('result-icon');
    if (iconEl.textContent === newIcon) return;
    iconEl.classList.add('morphing');
    setTimeout(function() {
      iconEl.textContent = newIcon;
      iconEl.classList.remove('morphing');
    }, 500);
  }

  function showResult(catIdx) {
    if (spinHandled) return;
    spinHandled = true;

    var cat = categories[catIdx];
    drawWheel(wheelAngle, catIdx);

    document.getElementById('wheel-ring').classList.add('glowing');

    // Big particle burst
    var rect = canvas.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    spawnBurst(cx, cy, cat.color, 80);
    spawnBurst(cx, cy, '#ffd60a', 40);

    // Result text overlay
    // The "❓" itself belongs on the wheel only — for mystery, keep the
    // overlay icon blank (and the label as plain "Mystery") until the
    // sub-category reveal fades the real icon in further down.
    var isMystery = cat.id === 'mystery';
    document.getElementById('result-icon').textContent = isMystery ? '' : cat.icon;
    document.getElementById('result-label').textContent = isMystery ? 'Mystery' : cat.name;
    document.getElementById('result-label').style.color = cat.color;
    document.getElementById('result-overlay').classList.add('visible');

    // Start idle float after result shown
    setTimeout(function() { if (!isSpinning) startIdleFloat(); }, 2000);
  }

  // Keeps the result display under the wheel in sync with the server's
  // actual current category. Needed whenever we're not mid-spin (e.g. right
  // after a reconnect during "playing"/"revealing") so it never keeps
  // showing a category from a previous round.
  function syncWheelResult(state) {
    if (isSpinning || !state.currentCategory || !categories.length) return;
    var idx = categories.findIndex(function(c) { return c.id === state.currentCategory.id; });
    if (idx < 0) return;
    showResult(idx);
    if (state.currentMysterySub) {
      document.getElementById('result-icon').textContent = state.currentMysterySub.icon;
      document.getElementById('result-sub').textContent = state.currentMysterySub.name;
    }
  }

  // ── Spotify Web Playback SDK ───────────────────────────────────

  var spotifyPlayer = null;
  var spotifyDeviceId = null;

  async function initSpotifyPlayer() {
    try {
      var resp = await fetch('/api/spotify/token');
      var data = await resp.json();
      if (!data.token) return;

      if (!window.Spotify) {
        await new Promise(function(resolve) {
          window.onSpotifyWebPlaybackSDKReady = resolve;
          var s = document.createElement('script');
          s.src = 'https://sdk.scdn.co/spotify-player.js';
          document.head.appendChild(s);
        });
      }

      spotifyPlayer = new Spotify.Player({
        name: 'Hitster Bingo Beamer',
        getOAuthToken: async function(cb) {
          var r = await fetch('/api/spotify/token');
          var d = await r.json();
          cb(d.token);
        },
        volume: 0.8,
      });

      spotifyPlayer.addListener('ready', function(data) {
        spotifyDeviceId = data.device_id;
        console.log('Spotify Player ready, device:', data.device_id);
      });

      await spotifyPlayer.connect();
    } catch (e) {
      console.log('Spotify SDK not available:', e.message);
    }
  }

  socket.on('spotify_play', async function(data) {
    if (!spotifyDeviceId) return;
    try {
      await fetch('/api/spotify/play', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: data.uri, deviceId: spotifyDeviceId }),
      });
    } catch (e) { console.error('Play failed:', e); }
  });

  socket.on('spotify_pause', async function() {
    try {
      if (spotifyPlayer) spotifyPlayer.pause();
      await fetch('/api/spotify/pause', { method: 'PUT' });
    } catch (e) { /* ignore */ }
  });

  initSpotifyPlayer();

  // ── State Management ───────────────────────────────────────────

  var lastSpinState = null;

  socket.on('game_state', function(state) {
    categories = state.categories || [];
    var teams = Object.values(state.teams);
    var gs = state.gameState;

    // Timer
    var timerEl = document.getElementById('timer');
    if (gs === 'playing' || gs === 'revealing') {
      timerEl.classList.remove('hidden');
      renderTimer(timerEl, state.timerValue);
    } else {
      timerEl.classList.add('hidden');
    }

    // Wheel section is ALWAYS visible — update round label
    var roundLabel = document.getElementById('round-label');
    var lobbyInfo = document.getElementById('lobby-info');

    // Hide/show overlay sections
    hide('sec-playing');
    hide('sec-revealing');

    if (gs !== 'spinning') {
      lastSpinState = null;
      isSpinning = false;
    }

    if (gs === 'lobby') {
      roundLabel.textContent = '';
      lobbyInfo.classList.remove('hidden');
      document.getElementById('lobby-count').textContent =
        teams.length + ' Team' + (teams.length !== 1 ? 's' : '') + ' verbunden';
      document.getElementById('lobby-teams').innerHTML = teams.map(function(t) {
        return '<div class="card" style="padding:.75rem 1.25rem;min-width:80px;text-align:center">' +
          '<span style="font-size:1.5rem">' + t.emoji + '</span>' +
          '<p style="font-size:.8rem;margin-top:.25rem">' + t.name + '</p></div>';
      }).join('');

      // Draw and idle-float
      if (categories.length) {
        drawWheel(wheelAngle, null);
        startIdleFloat();
      }
    }

    if (gs === 'between_rounds') {
      document.getElementById('result-overlay').classList.remove('visible');
      document.getElementById('wheel-ring').classList.remove('glowing');
    }

    if (gs === 'spinning' || gs === 'between_rounds') {
      lobbyInfo.classList.add('hidden');
      roundLabel.textContent = 'Runde ' + (state.currentRound + 1);

      if (gs === 'spinning' && state.currentCategory && lastSpinState !== state.spinToken) {
        lastSpinState = state.spinToken;
        document.getElementById('result-overlay').classList.remove('visible');
        document.getElementById('result-sub').textContent = '';
        document.getElementById('wheel-ring').classList.remove('glowing');
        spinWheel(state.currentCategory.id);
        if (state.currentMysterySub) {
          // Hold on the plain "Mystery" label (no icon) a beat before
          // revealing the sub-category, so the reveal itself is clearly
          // noticeable instead of happening almost immediately after the
          // wheel stops.
          setTimeout(function() {
            morphResultIcon(state.currentMysterySub.icon);
            document.getElementById('result-sub').textContent = state.currentMysterySub.name;
          }, 7500);
        }
      } else if (!isSpinning && categories.length) {
        drawWheel(wheelAngle, null);
        syncWheelResult(state);
        startIdleFloat();
      }
    }

    if (gs === 'playing') {
      lobbyInfo.classList.add('hidden');
      roundLabel.textContent = 'Runde ' + (state.currentRound + 1);
      show('sec-playing');
      document.getElementById('play-category').innerHTML =
        categoryBadgeHTML(state.currentCategory, state.currentMysterySub);
      renderTeamDots(teams, state.answers);

      // Keep wheel visible with last result (and correct it after a reconnect)
      syncWheelResult(state);
    }

    if (gs === 'revealing') {
      lobbyInfo.classList.add('hidden');
      roundLabel.textContent = 'Runde ' + (state.currentRound + 1);
      show('sec-revealing');
      document.getElementById('reveal-category').innerHTML =
        categoryBadgeHTML(state.currentCategory, state.currentMysterySub);
      renderSolution(state.currentSong);
      syncWheelResult(state);
    }
  });

  socket.on('timer_tick', function(val) {
    renderTimer(document.getElementById('timer'), val);
  });

  function renderTeamDots(teams, answers) {
    document.getElementById('play-teams').innerHTML = teams.map(function(t) {
      var a = answers && answers[t.id];
      return '<div class="card flex items-center gap-sm" style="padding:.5rem 1rem;border-color:' +
        (a ? 'var(--green)' : 'var(--border)') + '">' +
        '<span class="dot ' + (a ? 'on' : 'off') + '"></span>' +
        '<span>' + t.emoji + ' ' + t.name + '</span></div>';
    }).join('');
  }

  function renderSolution(song) {
    var el = document.getElementById('reveal-song');
    if (!song) {
      el.innerHTML = '<p class="text-center" style="color:var(--text-dim)">Keine Lösung gesetzt</p>';
      return;
    }
    var html = '<div class="text-center" style="padding:1.5rem">';
    if (song.cover) {
      html += '<img src="' + song.cover + '" style="width:120px;height:120px;border-radius:12px;margin:0 auto .75rem;display:block;box-shadow:0 0 30px rgba(0,0,0,.5)">';
    }
    html += '<p style="font-size:.8rem;color:var(--text-dim);font-family:var(--font-display);margin-bottom:.5rem">Lösung</p>';
    html += '<p class="song-title">' + song.title + '</p>';
    html += '<p class="song-artist">' + song.artist + '</p>';
    if (song.year) html += '<p class="song-meta">' + song.year + '</p>';
    html += '</div>';
    el.innerHTML = html;
  }
})();
