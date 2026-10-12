// Quiet, dry rustling for the "touch grass" scene, synthesized as grains: each grain is
// a few milliseconds of band-passed noise with its own pitch, loudness and decay, like
// one blade brushing past another. Grains fire at random (Poisson) intervals whose rate
// follows brushing speed, over a faint swish, so a fast brush crackles densely and a
// slow one ticks sparsely. A steady filtered noise, by contrast, sounds like hiss.

// Grains per second at the lightest and the fastest brush.
const MIN_GRAIN_RATE = 14;
const MAX_GRAIN_RATE = 110;
const GRAIN_GAIN = 0.16;
const SWISH_GAIN = 0.018;
// Pointer speed (px/ms) that counts as a full-intensity brush.
const FULL_SPEED = 1.5;
// Rustling carries on this long after the last brush, then fades out.
const HOLD_MS = 60;
const FADE_MS = 140;
// Grains are scheduled this far ahead on the audio clock, every SCHEDULE_MS.
const LOOKAHEAD_S = 0.1;
const SCHEDULE_MS = 25;

export interface GrassRustle {
  /** Rustle for a brush at `speed` px/ms; faster brushing is denser and a little louder. */
  brush(speed: number): void;
  /** Silence at once, e.g. when the window goes to the background. */
  hush(): void;
  dispose(): void;
}

const SILENT: GrassRustle = { brush() {}, hush() {}, dispose() {} };

function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Create inside a user gesture so the browser lets the audio start. */
export function createGrassRustle(): GrassRustle {
  if (typeof AudioContext === "undefined") return SILENT;

  const ctx = new AudioContext();
  const noise = createNoiseBuffer(ctx);

  // Round off the very top so the crackle stays dry rather than harsh.
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 8500;
  const master = ctx.createGain();
  master.connect(tone).connect(ctx.destination);

  // The faint swish of blades moving together under the crackle.
  const swish = ctx.createBufferSource();
  swish.buffer = noise;
  swish.loop = true;
  const swishFilter = ctx.createBiquadFilter();
  swishFilter.type = "bandpass";
  swishFilter.frequency.value = 2600;
  swishFilter.Q.value = 0.5;
  const swishGain = ctx.createGain();
  swishGain.gain.value = 0;
  swish.connect(swishFilter).connect(swishGain).connect(master);
  swish.start();

  let intensity = 0;
  let lastBrushAt = 0;
  let nextGrainAt = 0;
  let timer: number | undefined;
  // A running context keeps the audio device busy (and the looping swish playing) even in
  // silence, so it runs only while there is rustling to play.
  let suspended = false;
  const suspend = () => {
    if (suspended) return;
    suspended = true;
    void ctx.suspend();
  };
  suspend();

  const playGrain = (when: number, level: number) => {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    // Log-uniform between 1.2 and 6.5 kHz: low rustles and bright ticks.
    filter.frequency.value = 1200 * 5.4 ** Math.random();
    filter.Q.value = 0.8 + Math.random() * 2.2;
    const envelope = ctx.createGain();
    const length = 0.005 + Math.random() ** 2 * 0.04;
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(level * (0.2 + Math.random() * 0.8), when + 0.0015);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + length);
    source.connect(filter).connect(envelope).connect(master);
    source.start(when, Math.random() * (noise.duration - 0.05), length + 0.01);
  };

  const schedule = () => {
    const idleMs = performance.now() - lastBrushAt;
    const activity =
      idleMs < HOLD_MS ? intensity : intensity * Math.exp(-(idleMs - HOLD_MS) / FADE_MS);
    const now = ctx.currentTime;
    swishGain.gain.setTargetAtTime(activity * SWISH_GAIN, now, 0.06);
    if (activity < 0.02) {
      nextGrainAt = now;
      if (idleMs > HOLD_MS + FADE_MS * 4) {
        window.clearInterval(timer);
        timer = undefined;
        suspend();
      }
      return;
    }
    const rate = MIN_GRAIN_RATE + activity * (MAX_GRAIN_RATE - MIN_GRAIN_RATE);
    nextGrainAt = Math.max(nextGrainAt, now);
    while (nextGrainAt < now + LOOKAHEAD_S) {
      playGrain(nextGrainAt, GRAIN_GAIN * (0.5 + activity * 0.5));
      nextGrainAt += -Math.log(1 - Math.random()) / rate;
    }
  };

  const hush = () => {
    intensity = 0;
    window.clearInterval(timer);
    timer = undefined;
    // Grains already queued inside the lookahead window are cut by the master fade.
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    swishGain.gain.cancelScheduledValues(ctx.currentTime);
    swishGain.gain.setValueAtTime(0, ctx.currentTime);
    suspend();
  };

  return {
    brush(speed) {
      if (suspended) {
        suspended = false;
        void ctx.resume();
      }
      intensity = intensity * 0.6 + Math.min(1, speed / FULL_SPEED) * 0.4;
      lastBrushAt = performance.now();
      if (timer === undefined) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(1, ctx.currentTime);
        nextGrainAt = ctx.currentTime;
        timer = window.setInterval(schedule, SCHEDULE_MS);
        schedule();
      }
    },
    hush,
    dispose() {
      hush();
      swish.stop();
      void ctx.close();
    },
  };
}
