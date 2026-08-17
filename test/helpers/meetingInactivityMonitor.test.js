const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MeetingInactivityMonitor,
  computeRmsFromPcm16,
} = require("../../src/helpers/meetingInactivityMonitor.js");

const MIC_ACTIVE = 0.01;
const SYSTEM_ACTIVE = 0.005;

function createMonitor(overrides = {}) {
  const events = [];
  const monitor = new MeetingInactivityMonitor({
    onEvent: (type, payload) => events.push({ type, payload }),
    ...overrides,
  });
  return { monitor, events };
}

// Advances the clock in 1s ticks, optionally feeding chunk RMS before each
// tick, mirroring how the controller drives the monitor.
function run(monitor, fromMs, toMs, feed = null) {
  for (let now = fromMs + 1000; now <= toMs; now += 1000) {
    if (feed) feed(now);
    monitor.tick(now);
  }
}

test("60s of dual-channel silence fires exactly one threshold event", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  run(monitor, 0, 59_000, (now) => {
    monitor.recordChunkRms("mic", 0.0, now);
    monitor.recordChunkRms("system", 0.0, now);
  });
  assert.equal(events.length, 0);

  run(monitor, 59_000, 120_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "silence-threshold-reached");
  assert.equal(events[0].payload.reason, "silence");
});

test("single-channel activity keeps the session alive", () => {
  for (const feed of [
    (monitor, now) => monitor.recordChunkRms("mic", MIC_ACTIVE, now),
    // Music on system audio counts as activity even below the mic threshold.
    (monitor, now) => monitor.recordChunkRms("system", SYSTEM_ACTIVE, now),
  ]) {
    const { monitor, events } = createMonitor();
    monitor.start(0);
    run(monitor, 0, 300_000, (now) => feed(monitor, now));
    assert.equal(events.length, 0);
  }
});

test("sub-threshold RMS counts as silence (Windows digital-zero, noise floor)", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  run(monitor, 0, 61_000, (now) => {
    monitor.recordChunkRms("mic", 0.001, now);
    monitor.recordChunkRms("system", 0.001, now);
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, "silence");
});

test("activity resets the silence accumulation", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  run(monitor, 0, 44_000);
  monitor.recordChunkRms("mic", MIC_ACTIVE, 45_000);
  run(monitor, 44_000, 60_000);
  assert.equal(events.length, 0);

  run(monitor, 60_000, 104_000);
  assert.equal(events.length, 0);
  run(monitor, 104_000, 106_000);
  assert.equal(events.length, 1);
});

test("activity while prompting emits activity-resumed once", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  run(monitor, 0, 61_000);
  assert.equal(events.length, 1);

  monitor.recordChunkRms("system", SYSTEM_ACTIVE, 62_000);
  monitor.tick(62_000);
  monitor.tick(63_000);

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "activity-resumed");
  assert.equal(monitor.isPrompting(), false);
});

test("keepRecording consumes the episode and arms the cooldown floor", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  run(monitor, 0, 61_000);
  assert.equal(events.length, 1);
  monitor.keepRecording(61_000);

  // Continued silence never re-prompts: the episode is consumed.
  run(monitor, 61_000, 600_000);
  assert.equal(events.length, 1);

  // Activity opens a new episode…
  monitor.recordChunkRms("mic", MIC_ACTIVE, 601_000);
  run(monitor, 600_000, 700_000);
  // …and after fresh 60s of silence (601s + 60s = 661s, past the 361s
  // cooldown floor) the prompt fires again.
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "silence-threshold-reached");
});

test("cooldown floor delays a re-prompt even after fresh activity", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  run(monitor, 0, 61_000);
  monitor.keepRecording(61_000); // cooldown until 361s

  // A brief cough at 70s, then silence again.
  monitor.recordChunkRms("mic", MIC_ACTIVE, 70_000);
  run(monitor, 61_000, 360_000);
  // 60s of silence elapsed long ago (at 130s), but the floor holds.
  assert.equal(events.length, 1);

  run(monitor, 360_000, 363_000);
  assert.equal(events.length, 2);
});

test("armFast prompts after 10s of silence with reason process-exit", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  monitor.recordChunkRms("mic", MIC_ACTIVE, 4_000);
  run(monitor, 0, 5_000);
  monitor.armFast(5_000);

  run(monitor, 5_000, 14_000);
  assert.equal(events.length, 0);
  run(monitor, 14_000, 16_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, "process-exit");
});

test("ongoing audio after armFast clears fast mode without prompting", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  monitor.armFast(5_000);
  monitor.recordChunkRms("system", SYSTEM_ACTIVE, 6_000);
  monitor.tick(6_000);

  // Fast mode is gone; the normal 60s window applies from the last activity.
  run(monitor, 6_000, 65_000);
  assert.equal(events.length, 0);
  run(monitor, 65_000, 67_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, "silence");
});

test("a clock jump resets accumulation and cancels an outstanding prompt", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  run(monitor, 0, 59_000);
  // Laptop slept for 10 minutes; the first tick after wake must not fire.
  monitor.tick(659_000);
  assert.equal(events.length, 0);

  // Silence restarts from the wake tick.
  run(monitor, 659_000, 718_000);
  assert.equal(events.length, 0);
  run(monitor, 718_000, 720_000);
  assert.equal(events.length, 1);

  // A jump while prompting cancels the prompt.
  monitor.tick(1_500_000);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "activity-resumed");
  assert.equal(monitor.isPrompting(), false);
});

test("stopped monitor emits nothing and chunkless windows accumulate silence", () => {
  const { monitor, events } = createMonitor();
  monitor.start(0);

  // No recordChunkRms calls at all — a stalled capture still counts as silence.
  run(monitor, 0, 61_000);
  assert.equal(events.length, 1);

  monitor.stop();
  monitor.recordChunkRms("mic", 0.0, 62_000);
  monitor.tick(200_000);
  monitor.armFast(200_000);
  monitor.keepRecording(200_000);
  assert.equal(events.length, 1);
});

test("computeRmsFromPcm16 sanity", () => {
  assert.equal(computeRmsFromPcm16(Buffer.alloc(0)), 0);
  assert.equal(computeRmsFromPcm16(null), 0);

  const zeros = Buffer.alloc(2000);
  assert.equal(computeRmsFromPcm16(zeros), 0);

  // Full-scale square wave → RMS ≈ 1.
  const square = Buffer.alloc(2000);
  for (let i = 0; i < 1000; i += 1) {
    square.writeInt16LE(i % 2 === 0 ? 32767 : -32768, i * 2);
  }
  const rms = computeRmsFromPcm16(square);
  assert.ok(rms > 0.99 && rms <= 1.0001, `expected ~1, got ${rms}`);
});
