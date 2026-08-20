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

  // A short filtered-noise "clack" plus a low thump underneath — reads as a
  // mechanical ratchet peg hitting a divider, not an electronic beep. Noise
  // instead of a pure tone matters here: this fires many times per spin as
  // the wheel slows, and a repeated pure pitch gets grating fast.
  function playTick() {
    const c = getCtx();
    const t0 = c.currentTime;

    const dur = 0.03;
    const bufferSize = Math.max(1, Math.floor(c.sampleRate * dur));
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
    }
    const noise = c.createBufferSource();
    noise.buffer = buffer;
    const noiseFilter = c.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2200;
    noiseFilter.Q.value = 0.8;
    const noiseGain = c.createGain();
    noiseGain.gain.setValueAtTime(0.4, t0);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(c.destination);
    noise.start(t0);
    noise.stop(t0 + dur + 0.01);

    tone(180, t0, 0.05, { type: 'sine', gain: 0.15, slideTo: 110 });
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
    timerBeep: playTimerBeep,
    bingo: playBingoFanfare,
  };
})();
