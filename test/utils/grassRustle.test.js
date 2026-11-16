const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/grassRustle.ts");

// Just enough of the Web Audio graph for the rustle to build and schedule grains; records
// when the context is suspended or resumed.
function installFakeAudio(t) {
  const calls = [];
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  const node = (extra = {}) => ({ connect: (next) => next, ...extra });
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 8000;
      this.currentTime = 0;
      this.destination = node();
    }
    createBuffer(_channels, length) {
      const data = new Float32Array(length);
      return { duration: 1, getChannelData: () => data };
    }
    createBiquadFilter() {
      return node({ frequency: param(), Q: param() });
    }
    createGain() {
      return node({ gain: param() });
    }
    createBufferSource() {
      return node({ start() {}, stop() {} });
    }
    suspend() {
      calls.push("suspend");
      return Promise.resolve();
    }
    resume() {
      calls.push("resume");
      return Promise.resolve();
    }
    close() {
      calls.push("close");
      return Promise.resolve();
    }
  }

  let clock = 0;
  let tick = null;
  const originalNow = performance.now;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.window = {
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  };
  performance.now = () => clock;
  t.after(() => {
    delete globalThis.AudioContext;
    delete globalThis.window;
    performance.now = originalNow;
  });
  return {
    calls,
    advance(ms) {
      clock += ms;
      tick?.();
    },
  };
}

test("the audio context runs only while there is rustling to play", async (t) => {
  const audio = installFakeAudio(t);
  const { createGrassRustle } = await load();

  const rustle = createGrassRustle();
  assert.deepEqual(audio.calls, ["suspend"], "silent until the first brush");

  rustle.brush(1);
  rustle.brush(1);
  assert.deepEqual(audio.calls, ["suspend", "resume"]);

  // The rustle fades out after the last brush, then the context sleeps again.
  audio.advance(2000);
  assert.deepEqual(audio.calls, ["suspend", "resume", "suspend"]);

  rustle.brush(1);
  assert.deepEqual(audio.calls, ["suspend", "resume", "suspend", "resume"]);
  rustle.dispose();
});

test("hushing puts the context to sleep", async (t) => {
  const audio = installFakeAudio(t);
  const { createGrassRustle } = await load();

  const rustle = createGrassRustle();
  rustle.brush(1);
  rustle.hush();
  assert.deepEqual(audio.calls, ["suspend", "resume", "suspend"]);
  rustle.dispose();
  assert.equal(audio.calls.at(-1), "close");
});
