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

  function playTick() {
    tone(1400, getCtx().currentTime, 0.045, { type: 'square', gain: 0.1 });
  }

  // Countdown beep for the last seconds of the timer; urgent = higher/louder
  // for the final few seconds so the room feels the clock running out.
  function playTimerBeep(urgent) {
    tone(urgent ? 1046.5 : 784, getCtx().currentTime, urgent ? 0.16 : 0.11, {
      type: 'sine',
      gain: urgent ? 0.28 : 0.16,
    });
  }

  // Rising arpeggio + held final note — a small victory fanfare for Bingo.
  function playBingoFanfare() {
    const c = getCtx();
    const t0 = c.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51]; // C5 E5 G5 C6 E6
    notes.forEach((f, i) => tone(f, t0 + i * 0.1, 0.35, { type: 'triangle', gain: 0.22 }));
    tone(1318.51, t0 + notes.length * 0.1, 1.0, { type: 'triangle', gain: 0.24 });
  }

  window.HBSound = {
    unlock: getCtx,
    tick: playTick,
    timerBeep: playTimerBeep,
    bingo: playBingoFanfare,
  };
})();
