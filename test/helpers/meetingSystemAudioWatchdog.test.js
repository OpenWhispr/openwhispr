const test = require("node:test");
const assert = require("node:assert/strict");

const createMeetingSystemAudioWatchdog = require("../../src/helpers/meetingSystemAudioWatchdog");

const { STALL_MS, GONE_QUIET_MS, MAX_RESTARTS, TICK_GAP_MS } = createMeetingSystemAudioWatchdog;

const START_TIME = 1_000_000;
const TICK_MS = 2_000;

// The restart hook settles on the microtask queue, so every helper that can
// trigger one yields the loop before the caller inspects state.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const createHarness = ({ startImpl, stopImpl } = {}) => {
  let now = START_TIME;
  const calls = [];
  const interruptions = [];

  const watchdog = createMeetingSystemAudioWatchdog({
    now: () => now,
    onInterrupted: (payload) => interruptions.push(payload),
  });

  // Mirrors startManagedMeetingSystemAudio: capture is attached when it starts,
  // which is before the session is armed.
  const attach = () =>
    watchdog.attachCapture({
      stop: () => {
        calls.push("stop");
        return Promise.resolve(stopImpl?.());
      },
      start: () => {
        calls.push("start");
        return Promise.resolve(startImpl?.());
      },
    });

  const advance = async (ms) => {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(TICK_MS, remaining);
      now += step;
      remaining -= step;
      watchdog.tick();
      await flush();
    }
  };

  return {
    watchdog,
    calls,
    interruptions,
    attach,
    advance,
    jump: (ms) => {
      now += ms;
    },
    restarts: () => calls.filter((call) => call === "start").length,
    deliver: (audible = false) => watchdog.recordChunk(audible),
  };
};

// Real ordering: attach, arm, then the first chunk proves the stream delivers.
const startNative = (harness, { deliver = true } = {}) => {
  harness.attach();
  harness.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  if (deliver) harness.deliver(true);
};

test("a stream that keeps delivering never restarts", async () => {
  const h = createHarness();
  startNative(h);

  for (let i = 0; i < 100; i += 1) {
    h.deliver(true);
    await h.advance(TICK_MS);
  }

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.interruptions, []);
});

test("delivery stopping past the stall window restarts capture once", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance(STALL_MS);
  assert.equal(h.restarts(), 0, "must not fire before the window elapses");

  await h.advance(TICK_MS);
  assert.deepEqual(h.calls, ["stop", "start"], "recovery bounces the helper process");
  assert.deepEqual(h.interruptions, [
    { systemAudioStrategy: "native", reason: "no_audio_delivered", recovering: true },
  ]);
});

// The regression that shipped in the first draft: capture attaches during start
// and the session is armed afterwards, so arming must not detach it. It did,
// and the watchdog reported stalls it could not actually recover from.
test("arming the session keeps the capture attached by the start path", async () => {
  const h = createHarness();
  h.attach();
  h.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  h.deliver(true);

  h.watchdog.reportDeviceInvalidated();
  await flush();

  assert.deepEqual(h.calls, ["stop", "start"], "arming must not drop the restart target");
});

test("a restart resets the stall window rather than firing again immediately", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  // Still no audio, but the clock restarts from the restart, not the last chunk.
  await h.advance(STALL_MS);
  assert.equal(h.restarts(), 1);

  await h.advance(TICK_MS);
  assert.equal(h.restarts(), 2);
});

test("restart attempts are capped and the give-up report is sent exactly once", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 4));

  assert.equal(h.restarts(), MAX_RESTARTS);
  const gaveUp = h.interruptions.filter((entry) => entry.recovering === false);
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].reason, "no_audio_delivered");
  assert.equal(h.interruptions.filter((entry) => entry.recovering === true).length, MAX_RESTARTS);
});

test("giving up suppresses the later quiet report rather than piling on", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));
  assert.equal(h.interruptions.filter((entry) => entry.recovering === false).length, 1);

  // The delivery branch is latched off, so the quiet check is reachable again;
  // it must not add a second, weaker verdict on top of the give-up one.
  await h.advance(GONE_QUIET_MS + TICK_MS);
  assert.equal(h.interruptions.filter((entry) => entry.reason === "gone_quiet").length, 0);
});

test("a device event after the cap is exhausted cannot hand out more attempts", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));
  assert.equal(h.restarts(), MAX_RESTARTS);

  h.watchdog.reportDeviceInvalidated();
  await flush();
  assert.equal(h.restarts(), MAX_RESTARTS);
  assert.equal(h.interruptions.filter((entry) => entry.recovering === false).length, 1);
});

test("a device invalidation restarts without waiting for the stall window", async () => {
  const h = createHarness();
  startNative(h);

  h.watchdog.reportDeviceInvalidated();
  await flush();

  assert.deepEqual(h.calls, ["stop", "start"]);
  assert.deepEqual(h.interruptions, [
    { systemAudioStrategy: "native", reason: "device_invalidated", recovering: true },
  ]);
});

test("a restart that throws still clears the in-flight flag", async () => {
  const h = createHarness({
    startImpl: () => Promise.reject(new Error("helper would not start")),
  });
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 2, "a failed restart must not wedge the watchdog");
});

test("nothing is judged while a restart is still in flight", async () => {
  let release;
  const h = createHarness({
    startImpl: () => new Promise((resolve) => (release = resolve)),
  });
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  // The helper is slow to come back; ticks during that must not stack restarts.
  await h.advance(STALL_MS * 3);
  assert.equal(h.restarts(), 1);

  release();
  await flush();
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 2);
});

test("delivery gaps are ignored for strategies that may legitimately go idle", async () => {
  const h = createHarness();
  h.attach();
  h.watchdog.start({ systemAudioStrategy: "wasapi-loopback", watchesDelivery: false });
  h.deliver(true);

  await h.advance(STALL_MS * 10);

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.interruptions, []);
});

// Capture that never produced a single chunk belongs to the one-shot silence
// warning. Judging it here would restart during startup, before the renderer
// has even registered its listener.
test("a stream that has never delivered is not judged on delivery", async () => {
  const h = createHarness();
  startNative(h, { deliver: false });

  await h.advance(STALL_MS * 10);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.interruptions, []);

  // Once it has delivered, the window applies normally.
  h.deliver(true);
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);
});

// Date.now() jumps across sleep, and a blocked main process delivers the timer
// tick before the stdout data it should have been judging.
test("a tick gap longer than the sleep threshold rebases the delivery window", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance(TICK_MS);
  h.jump(TICK_GAP_MS + STALL_MS * 5);
  h.watchdog.tick();
  await flush();

  assert.deepEqual(h.calls, [], "waking from sleep must not read as a dead tap");

  // The rebase is one-shot: a stall that outlives it is still caught.
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);
});

test("a call that goes quiet is reported once and never restarted", async () => {
  const h = createHarness();
  startNative(h);

  // Chunks keep arriving, so delivery is healthy; they are simply silent.
  let elapsed = 0;
  while (elapsed <= GONE_QUIET_MS + TICK_MS * 2) {
    h.deliver(false);
    await h.advance(TICK_MS);
    elapsed += TICK_MS;
  }

  assert.deepEqual(h.calls, [], "a quiet call must never cost the user a restart");
  assert.deepEqual(h.interruptions, [
    { systemAudioStrategy: "native", reason: "gone_quiet", recovering: false },
  ]);
});

test("a session that was never audible does not report going quiet", async () => {
  const h = createHarness();
  h.attach();
  h.watchdog.start({ systemAudioStrategy: "wasapi-loopback", watchesDelivery: false });

  let elapsed = 0;
  while (elapsed <= GONE_QUIET_MS * 2) {
    h.deliver(false);
    await h.advance(TICK_MS);
    elapsed += TICK_MS;
  }

  // That case belongs to the one-shot start-of-session warning, not here.
  assert.deepEqual(h.interruptions, []);
});

test("stop ends the session and a late restart cannot resurrect it", async () => {
  let release;
  const h = createHarness({
    startImpl: () => new Promise((resolve) => (release = resolve)),
  });
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  h.watchdog.stop();
  release();
  await flush();

  await h.advance(STALL_MS * 5);
  assert.equal(h.restarts(), 1);
});

// A meeting can end in the window between the helper being killed and the
// replacement being spawned. Without the generation check the restart would
// complete anyway and leave an orphan process holding a CoreAudio process tap.
test("a session that ends mid-restart never starts a replacement helper", async () => {
  let releaseStop;
  const h = createHarness({
    stopImpl: () => new Promise((resolve) => (releaseStop = resolve)),
  });
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.deepEqual(h.calls, ["stop"], "suspended between the two halves");

  h.watchdog.stop();
  releaseStop();
  await flush();
  await flush();

  assert.deepEqual(h.calls, ["stop"], "the replacement must never be spawned");
});

test("a session that ends while the replacement is starting stops the orphan", async () => {
  let releaseStart;
  const h = createHarness({
    startImpl: () => new Promise((resolve) => (releaseStart = resolve)),
  });
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.deepEqual(h.calls, ["stop", "start"]);

  h.watchdog.stop();
  releaseStart();
  await flush();
  await flush();

  assert.deepEqual(h.calls, ["stop", "start", "stop"], "the helper it started must be killed");
});

test("starting again clears the previous session's attempt count", async () => {
  const h = createHarness();
  startNative(h);
  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));
  assert.equal(h.restarts(), MAX_RESTARTS);

  h.watchdog.stop();
  startNative(h);
  await h.advance(STALL_MS + TICK_MS);

  assert.equal(h.restarts(), MAX_RESTARTS + 1);
});
