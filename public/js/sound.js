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
  // followed by a quick decaying flurry of the exact same tick recipe, like
  // the ratchet arm still rattling briefly before it fully settles. That
  // rattle alone lost the "something got selected" feeling a musical ding
  // used to carry, so it closes on one single resonant note — a click plus
  // a detuned pair of oscillators for a metallic shimmer rather than a
  // clean pitch — reading as a mechanical indicator locking into place
  // instead of a full UI ding-ding. Called once, right when the spin
  // animation actually finishes, not on every state sync (a reconnecting
  // client re-displaying an already-decided result shouldn't replay it).
  function playWheelLand() {
    const t0 = getCtx().currentTime;
    noiseBurst(t0, 0.09, { freq: 1400, q: 0.7, gain: 0.5, curve: 1.5 });
    tone(90, t0, 0.22, { type: 'sine', gain: 0.3, slideTo: 55 });
    tone(65, t0 + 0.02, 0.28, { type: 'sine', gain: 0.18, slideTo: 40 });

    const rattleOffsets = [0.11, 0.17, 0.22, 0.26];
    rattleOffsets.forEach((offset, i) => {
      const decay = 1 - i / rattleOffsets.length;
      noiseBurst(t0 + offset, 0.025, { freq: 2200 - i * 150, q: 0.8, gain: 0.3 * decay });
      tone(150 - i * 12, t0 + offset, 0.04, { type: 'sine', gain: 0.12 * decay, slideTo: 90 });
    });

    // Two-stage "click...CLACK" — a small pre-click then a firmer, higher,
    // longer hit — reading as a mechanical flag/switch snapping into its
    // confirmed position. A single quiet note (the earlier version) got
    // buried under the rattle; the two-step rise plus the louder second hit
    // is what actually registers as "locked in" rather than a footnote.
    const lockStart = t0 + 0.33;
    noiseBurst(lockStart, 0.018, { freq: 2400, q: 1, gain: 0.22 });
    tone(329.63, lockStart, 0.07, { type: 'triangle', gain: 0.2 }); // E4

    const clackStart = lockStart + 0.1;
    noiseBurst(clackStart, 0.03, { freq: 2800, q: 1.1, gain: 0.38 });
    tone(440.0, clackStart, 0.4, { type: 'triangle', gain: 0.38 }); // A4
    tone(554.37, clackStart, 0.35, { type: 'triangle', gain: 0.16 }); // C#5 — major third makes it a bright A-major hit, not a bare pitch
    tone(440.0 * 2.01, clackStart, 0.26, { type: 'sine', gain: 0.1 }); // detuned overtone = metallic, not pure
    tone(220.0, clackStart, 0.17, { type: 'sine', gain: 0.16 }); // low body thump under the clack, for weight

    // Tiny tail sparkle capping the gesture — finality without going shrill.
    noiseBurst(clackStart + 0.13, 0.015, { freq: 3400, q: 1.4, gain: 0.09 });
  }

  // Countdown pulse for the last 10s. A high square-wave alarm cuts through
  // a song, but reads as shrill and grating fast — this instead pairs a
  // low percussive click (the noiseBurst transient, same family as the
  // wheel tick) with a warm mid-register triangle tone, more "confident
  // clock pulse" than "smoke alarm". A layered octave-below body note adds
  // perceived loudness without raising the pitch (which is what would tip
  // it back into shrill). Escalates gently: most of the window stays a
  // quiet, brief pulse, and only the final 3 seconds firm up into a fuller
  // double-pulse — noticeably more present without turning painful, so it
  // still lands after many rounds instead of wearing the room down. The
  // zero buzzer is the one moment allowed to actually punch through a loud
  // song: a brief bright attack transient plus a louder double-hit.
  function playTimerBeep(secondsLeft) {
    const c = getCtx();
    const t0 = c.currentTime;

    if (secondsLeft <= 0) {
      tone(880, t0, 0.05, { type: 'square', gain: 0.24 }); // short bright punch to grab the ear
      noiseBurst(t0, 0.07, { freq: 900, q: 0.6, gain: 0.42 });
      tone(220, t0, 0.55, { type: 'triangle', gain: 0.38, slideTo: 110 });
      tone(164.81, t0 + 0.03, 0.5, { type: 'sine', gain: 0.22, slideTo: 82.41 });

      const secondHit = t0 + 0.24;
      tone(660, secondHit, 0.045, { type: 'square', gain: 0.18 });
      noiseBurst(secondHit, 0.06, { freq: 900, q: 0.6, gain: 0.32 });
      tone(196, secondHit, 0.45, { type: 'triangle', gain: 0.3, slideTo: 98 });
      return;
    }

    const urgent = secondsLeft <= 3;
    const freq = urgent ? 493.88 : 392.0; // B4 vs G4 — grounded, not piercing
    const gain = urgent ? 0.3 : 0.18;
    const dur = urgent ? 0.1 : 0.08;

    noiseBurst(t0, dur * 0.5, { freq: urgent ? 1600 : 1100, q: 1, gain: urgent ? 0.22 : 0.12 });
    tone(freq, t0, dur, { type: 'triangle', gain });
    tone(freq / 2, t0, dur * 1.3, { type: 'sine', gain: gain * 0.4 }); // octave-below body for perceived loudness
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
    filter.frequency.setValueAtTime(450, startTime);
    filter.frequency.linearRampToValueAtTime(1700, startTime + duration * 0.35);
    filter.frequency.linearRampToValueAtTime(950, startTime + duration);

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

  // A shouted "wooo!" — a sawtooth in a human vocal-fundamental register,
  // pushed through a resonant bandpass sweep that moves like an open mouth
  // shaping a vowel, plus light vibrato so the pitch isn't perfectly steady.
  // A clean oscillator gliding straight up (the previous version) reads as
  // a synth/party-whistle; the formant sweep and vibrato are what make this
  // sound like an actual voice instead.
  function humanWhoop(startTime, opts) {
    opts = opts || {};
    const c = getCtx();
    const dur = opts.dur != null ? opts.dur : 0.5;
    const baseFreq = opts.from || 220;
    const peakFreq = opts.to || 340;

    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(baseFreq, startTime);
    osc.frequency.linearRampToValueAtTime(peakFreq, startTime + dur * 0.4);
    osc.frequency.linearRampToValueAtTime(peakFreq * 0.85, startTime + dur);

    const vibrato = c.createOscillator();
    vibrato.frequency.value = 6.5;
    const vibratoGain = c.createGain();
    vibratoGain.gain.value = peakFreq * 0.02;
    vibrato.connect(vibratoGain);
    vibratoGain.connect(osc.frequency);
    vibrato.start(startTime);
    vibrato.stop(startTime + dur + 0.05);

    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 3.5;
    filter.frequency.setValueAtTime(600, startTime);
    filter.frequency.linearRampToValueAtTime(1300, startTime + dur * 0.5);
    filter.frequency.linearRampToValueAtTime(850, startTime + dur);

    const gain = c.createGain();
    const peak = opts.gain != null ? opts.gain : 0.16;
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peak, startTime + dur * 0.2);
    gain.gain.linearRampToValueAtTime(peak * 0.7, startTime + dur * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.05);
  }

  // Scattered short noise clicks standing in for a burst of applause —
  // layered under the cheer and whoops to thicken the "crowd" texture.
  function applauseBurst(startTime, duration, count) {
    for (let i = 0; i < count; i++) {
      const t = startTime + Math.random() * duration;
      noiseBurst(t, 0.02 + Math.random() * 0.02, {
        freq: 2200 + Math.random() * 1600,
        q: 1.2,
        gain: 0.07 + Math.random() * 0.06,
      });
    }
  }

  // Victory fanfare for Bingo: overlapping crowd-cheer swells and applause
  // underneath several staggered, differently pitched "wooo!"s — more like
  // a full room reacting at once than a single voice — leading into a quick
  // ascending run that lands on a sustained major chord (the actual
  // "ta-da"). A third cheer/applause surge lands right on the chord itself
  // instead of tapering off before the peak, so the crowd's reaction
  // actually crests with the music rather than just opening it. Kept in a
  // lower register throughout (triangle waves, no octave-up partial pushed
  // too high) so it stays warm rather than piercing — the crowd/applause
  // layer and vocal-register whoops are what make it read as people
  // celebrating instead of a synth jingle.
  function playBingoFanfare() {
    const c = getCtx();
    const t0 = c.currentTime;

    crowdCheer(t0, 1.6);
    crowdCheer(t0 + 0.18, 1.35);
    applauseBurst(t0 + 0.1, 1.3, 24);

    humanWhoop(t0 + 0.05, { from: 220, to: 370, dur: 0.5, gain: 0.16 });
    humanWhoop(t0 + 0.2, { from: 260, to: 440, dur: 0.42, gain: 0.13 });
    humanWhoop(t0 + 0.38, { from: 196, to: 330, dur: 0.55, gain: 0.13 });
    humanWhoop(t0 + 0.55, { from: 300, to: 480, dur: 0.4, gain: 0.11 });

    const run = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    run.forEach((f, i) => {
      const t = t0 + i * 0.09;
      tone(f, t, 0.14, { type: 'triangle', gain: 0.18 });
    });

    const chordStart = t0 + run.length * 0.09 + 0.03;
    const chord = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    chord.forEach((f) => {
      tone(f, chordStart, 1.1, { type: 'triangle', gain: 0.24 });
      tone(f * 2, chordStart, 0.6, { type: 'sine', gain: 0.05 });
    });

    // Second surge, timed to the chord landing — the crowd's reaction
    // spikes again right at the payoff instead of already fading out.
    crowdCheer(chordStart - 0.05, 1.15);
    applauseBurst(chordStart, 0.9, 16);

    humanWhoop(chordStart + 0.1, { from: 240, to: 420, dur: 0.45, gain: 0.14 });
    humanWhoop(chordStart + 0.3, { from: 210, to: 360, dur: 0.4, gain: 0.11 });
    humanWhoop(chordStart + 0.5, { from: 280, to: 460, dur: 0.4, gain: 0.1 });

    const sparkleNotes = [1046.5, 1174.66, 1318.51, 1567.98]; // C6 D6 E6 G6
    for (let i = 0; i < 6; i++) {
      const f = sparkleNotes[Math.floor(Math.random() * sparkleNotes.length)];
      const t = chordStart + 0.1 + Math.random() * 0.8;
      tone(f, t, 0.18, { type: 'sine', gain: 0.05 });
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
