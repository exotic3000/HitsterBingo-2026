/* Synthesized sound effects (Web Audio API) — no audio files needed, so
   there's nothing to ship/load and it works even without internet at the
   venue. Browsers block audio until a user gesture, so the AudioContext is
   created lazily and unlocked from the splash screen's first click/keydown. */

(function () {
  let ctx = null;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, startTime, duration, opts) {
    opts = opts || {};
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, startTime + duration);
    const peak = opts.gain != null ? opts.gain : 0.2;
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peak, startTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.03);
  }

  // Filtered noise burst — the transient "clack" underlying both the spin
  // tick and the wheel-stop clunk below. Noise instead of a pure tone
  // matters for the tick especially: it fires many times per spin as the
  // wheel slows, and a repeated pure pitch gets grating fast.
  function noiseBurst(startTime, duration, opts) {
    opts = opts || {};
    const c = getCtx();
    const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    const curve = opts.curve != null ? opts.curve : 2;
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, curve);
    }
    const noise = c.createBufferSource();
    noise.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = opts.freq != null ? opts.freq : 2000;
    filter.Q.value = opts.q != null ? opts.q : 0.8;
    const gain = c.createGain();
    const peak = opts.gain != null ? opts.gain : 0.4;
    gain.gain.setValueAtTime(peak, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    noise.start(startTime);
    noise.stop(startTime + duration + 0.01);
  }

  function playTick() {
    const t0 = getCtx().currentTime;
    noiseBurst(t0, 0.03, { freq: 2200, q: 0.8, gain: 0.4 });
    tone(180, t0, 0.05, { type: 'sine', gain: 0.15, slideTo: 110 });
  }

  // The wheel's final "clunk" as the pointer settles on the winning segment
  // — a heavier, lower sibling of the spin tick (same noise+thump recipe) —
  // immediately followed by a punchy two-note "check" ding (square wave for
  // bite, a snappy perfect-fifth jump up) confirming the category landed,
  // instead of a soft trailing ring. Called once, right when the spin
  // animation actually finishes, not on every state sync (a reconnecting
  // client re-displaying an already-decided result shouldn't replay it).
  function playWheelLand() {
    const t0 = getCtx().currentTime;
    noiseBurst(t0, 0.09, { freq: 1400, q: 0.7, gain: 0.5, curve: 1.5 });
    tone(90, t0, 0.22, { type: 'sine', gain: 0.3, slideTo: 55 });
    tone(65, t0 + 0.02, 0.28, { type: 'sine', gain: 0.18, slideTo: 40 });

    const dingStart = t0 + 0.1;
    tone(1318.51, dingStart, 0.14, { type: 'square', gain: 0.24 }); // E6
    tone(2637.02, dingStart, 0.09, { type: 'sine', gain: 0.06 });
    noiseBurst(dingStart + 0.09, 0.02, { freq: 3000, q: 1, gain: 0.15 });
    tone(1975.99, dingStart + 0.09, 0.3, { type: 'square', gain: 0.28 }); // B6
    tone(3951.98, dingStart + 0.09, 0.18, { type: 'sine', gain: 0.07 });
  }

  // Countdown pulse for the last 10s. A high square-wave alarm cuts through
  // a song, but reads as shrill and grating fast — this instead pairs a
  // low percussive click (the noiseBurst transient, same family as the
  // wheel tick) with a warm mid-register triangle tone, more "confident
  // clock pulse" than "smoke alarm". Escalates gently: most of the window
  // stays a quiet, brief pulse, and only the final 3 seconds firm up into a
  // slightly fuller double-pulse — noticeably more present without turning
  // painful, so it still lands after many rounds instead of wearing the
  // room down.
  function playTimerBeep(secondsLeft) {
    const c = getCtx();
    const t0 = c.currentTime;

    if (secondsLeft <= 0) {
      noiseBurst(t0, 0.05, { freq: 800, q: 0.6, gain: 0.28 });
      tone(220, t0, 0.4, { type: 'triangle', gain: 0.26, slideTo: 110 });
      tone(164.81, t0 + 0.03, 0.35, { type: 'sine', gain: 0.15, slideTo: 82.41 });
      return;
    }

    const urgent = secondsLeft <= 3;
    const freq = urgent ? 493.88 : 392.0; // B4 vs G4 — grounded, not piercing
    const gain = urgent ? 0.2 : 0.11;
    const dur = urgent ? 0.09 : 0.07;

    noiseBurst(t0, dur * 0.5, { freq: urgent ? 1600 : 1100, q: 1, gain: urgent ? 0.16 : 0.08 });
    tone(freq, t0, dur, { type: 'triangle', gain });
    if (urgent) tone(freq, t0 + 0.16, dur, { type: 'triangle', gain: gain * 0.85 });
  }

  // Filtered-noise swell standing in for a crowd roar/applause burst — rises
  // quickly, brightens through the "cheer" then settles back down, sitting
  // underneath the musical fanfare so the whole thing reads as an audience
  // erupting rather than just a synth jingle.
  function crowdCheer(startTime, duration) {
    const c = getCtx();
    const bufferSize = Math.floor(c.sampleRate * duration);
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = c.createBufferSource();
    noise.buffer = buffer;

    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(500, startTime);
    filter.frequency.linearRampToValueAtTime(2200, startTime + duration * 0.35);
    filter.frequency.linearRampToValueAtTime(1100, startTime + duration);

    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(0.22, startTime + duration * 0.15);
    gain.gain.linearRampToValueAtTime(0.13, startTime + duration * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    noise.start(startTime);
    noise.stop(startTime + duration + 0.05);
  }

  // A quick rising glissando — reads as a party whistle/"woo!" amid a cheer.
  function cheerWhoop(startTime, opts) {
    opts = opts || {};
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    const dur = opts.dur != null ? opts.dur : 0.25;
    osc.type = opts.type || 'sawtooth';
    osc.frequency.setValueAtTime(opts.from || 300, startTime);
    osc.frequency.exponentialRampToValueAtTime(opts.to || 1400, startTime + dur);
    const peak = opts.gain != null ? opts.gain : 0.12;
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peak, startTime + dur * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.02);
  }

  // Victory fanfare for Bingo: a crowd-cheer swell and a couple of whistle
  // whoops underneath a quick ascending run that lands on a big sustained
  // major chord (the actual "ta-da"), with random high sparkle notes
  // twinkling over the chord's decay. The cheer layer is what turns this
  // from "synth jingle" into something that actually sounds like people
  // celebrating.
  function playBingoFanfare() {
    const c = getCtx();
    const t0 = c.currentTime;

    crowdCheer(t0, 1.6);
    cheerWhoop(t0 + 0.05, { from: 300, to: 1500, dur: 0.28, gain: 0.14 });
    cheerWhoop(t0 + 0.32, { from: 260, to: 1300, dur: 0.3, gain: 0.12, type: 'square' });

    const run = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    run.forEach((f, i) => {
      const t = t0 + i * 0.09;
      tone(f, t, 0.14, { type: 'sawtooth', gain: 0.16 });
      tone(f * 2, t, 0.1, { type: 'sine', gain: 0.05 });
    });

    const chordStart = t0 + run.length * 0.09 + 0.03;
    const chord = [1046.5, 1318.51, 1567.98, 2093.0]; // C6 E6 G6 C7
    chord.forEach((f) => {
      tone(f, chordStart, 1.1, { type: 'triangle', gain: 0.22 });
      tone(f * 2, chordStart, 0.7, { type: 'sine', gain: 0.06 });
    });

    cheerWhoop(chordStart + 0.15, { from: 500, to: 1900, dur: 0.32, gain: 0.11 });

    const sparkleNotes = [2093.0, 2349.32, 2637.02, 3135.96]; // C7 D7 E7 G7
    for (let i = 0; i < 6; i++) {
      const f = sparkleNotes[Math.floor(Math.random() * sparkleNotes.length)];
      const t = chordStart + 0.1 + Math.random() * 0.7;
      tone(f, t, 0.18, { type: 'sine', gain: 0.06 });
    }
  }

  window.HBSound = {
    unlock: getCtx,
    tick: playTick,
    wheelLand: playWheelLand,
    timerBeep: playTimerBeep,
    bingo: playBingoFanfare,
  };
})();
