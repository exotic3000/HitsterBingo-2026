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
  // — a heavier, lower sibling of the spin tick (same noise+thump recipe),
  // topped with a short metallic ring to mark the reveal. Called once, right
  // when the spin animation actually finishes, not on every state sync (a
  // reconnecting client re-displaying an already-decided result shouldn't
  // replay it).
  function playWheelLand() {
    const t0 = getCtx().currentTime;
    noiseBurst(t0, 0.09, { freq: 1400, q: 0.7, gain: 0.5, curve: 1.5 });
    tone(90, t0, 0.22, { type: 'sine', gain: 0.3, slideTo: 55 });
    tone(65, t0 + 0.02, 0.28, { type: 'sine', gain: 0.18, slideTo: 40 });

    const ringStart = t0 + 0.09;
    [1046.5, 1567.98, 2350].forEach((f, i) => {
      tone(f, ringStart, 0.5 - i * 0.05, { type: 'triangle', gain: 0.1 - i * 0.02 });
    });
  }

  // Countdown beep for the last 10s. A plain sine has no harmonics, so it
  // gets buried under whatever the currently-playing song is doing — square/
  // sawtooth carry upper overtones that punch through a music mix far
  // better. Escalates in stages instead of being loud for the full 10s:
  // most of the window stays a light, short tick, and only the final 3
  // seconds turn into a sharper double-blip alarm, closed out by a distinct
  // buzzer at zero. Round after round, a cue that's intense the whole
  // window wears a room down fast — keeping the "stressful" part to a brief
  // final crunch is what lets it still land after many rounds.
  function playTimerBeep(secondsLeft) {
    const c = getCtx();
    const t0 = c.currentTime;

    if (secondsLeft <= 0) {
      tone(311.13, t0, 0.4, { type: 'sawtooth', gain: 0.3, slideTo: 155.56 });
      tone(233.08, t0 + 0.05, 0.35, { type: 'square', gain: 0.14 });
      return;
    }

    const urgent = secondsLeft <= 3;
    const freq = urgent ? 1567.98 : 1046.5; // G6 vs C6
    const type = urgent ? 'square' : 'triangle';
    const gain = urgent ? 0.34 : 0.17;
    const dur = urgent ? 0.11 : 0.09;

    tone(freq, t0, dur, { type, gain });
    if (urgent) tone(freq, t0 + 0.14, dur, { type, gain: gain * 0.9 });
  }

  // Victory fanfare for Bingo: a quick ascending run building anticipation,
  // landing on a big sustained major chord (the actual "ta-da"), then a few
  // random high sparkle notes twinkling over the chord's decay. Each note is
  // layered with a soft octave-up partial for a bell-like richness instead
  // of a single flat pitch, so it reads as festive rather than a plain scale.
  function playBingoFanfare() {
    const c = getCtx();
    const t0 = c.currentTime;

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
