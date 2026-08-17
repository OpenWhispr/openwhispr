const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMeetingAudioActivityMonitor,
  MIC_ACTIVITY_TAIL_MS,
  SYSTEM_ACTIVITY_TAIL_MS,
} = require("../../src/helpers/meetingAudioActivityMonitor");
const {
  MEETING_MIC_ACTIVITY_RMS,
  MEETING_SYSTEM_ACTIVITY_RMS,
} = require("../../src/utils/audioUtils");

const START = 1_000_000;

// A constant-amplitude s16le buffer whose RMS is exactly `rms`.
function pcmAtRms(rms, sampleCount = 800) {
  const buffer = Buffer.alloc(sampleCount * 2);
  const amplitude = Math.round(rms * 32768);
  for (let i = 0; i < sampleCount; i += 1) {
    buffer.writeInt16LE(amplitude, i * 2);
  }
  return buffer;
}

function createMonitor() {
  const changes = [];
  const monitor = createMeetingAudioActivityMonitor({
    onActivityChanged: (state) => changes.push({ ...state }),
  });
  return { monitor, changes };
}

test("a chunk at the mic threshold marks the mic active on the next tick and emits once", () => {
  const { monitor, changes } = createMonitor();

  monitor.recordChunk("mic", pcmAtRms(MEETING_MIC_ACTIVITY_RMS));
  assert.deepEqual(monitor.getState(), { micActive: false, systemActive: false });

  monitor.tick(START);
  monitor.tick(START + 1000);

  assert.deepEqual(changes, [{ micActive: true, systemActive: false }]);
  assert.deepEqual(monitor.getState(), { micActive: true, systemActive: false });
});

test("chunks below their channel threshold never mark a channel active", () => {
  const { monitor, changes } = createMonitor();

  monitor.recordChunk("mic", pcmAtRms(MEETING_MIC_ACTIVITY_RMS * 0.5));
  monitor.recordChunk("system", pcmAtRms(MEETING_SYSTEM_ACTIVITY_RMS * 0.5));
  monitor.tick(START);

  assert.deepEqual(changes, []);
});

test("digital-zero system chunks (Windows loopback silence) never mark the system active", () => {
  const { monitor, changes } = createMonitor();

  for (let i = 0; i < 30; i += 1) {
    monitor.recordChunk("system", Buffer.alloc(1600));
  }
  monitor.tick(START);
  monitor.tick(START + 1000);

  assert.deepEqual(changes, []);
});

test("activity ages out after each channel's tail with a single change", () => {
  const { monitor, changes } = createMonitor();

  monitor.recordChunk("mic", pcmAtRms(0.05));
  monitor.recordChunk("system", pcmAtRms(0.05));
  monitor.tick(START);
  assert.deepEqual(changes, [{ micActive: true, systemActive: true }]);

  monitor.tick(START + MIC_ACTIVITY_TAIL_MS - 1);
  assert.equal(changes.length, 1, "still inside both tails");

  monitor.tick(START + MIC_ACTIVITY_TAIL_MS);
  assert.deepEqual(changes.at(-1), { micActive: false, systemActive: true });

  monitor.tick(START + SYSTEM_ACTIVITY_TAIL_MS);
  assert.deepEqual(changes.at(-1), { micActive: false, systemActive: false });
  assert.equal(changes.length, 3);
});

test("odd-length and unaligned buffers are measured without throwing", () => {
  const { monitor, changes } = createMonitor();

  const aligned = pcmAtRms(0.05, 801);
  const oddLength = aligned.subarray(0, aligned.length - 1);
  const unaligned = Buffer.concat([Buffer.alloc(1), aligned]).subarray(1);

  assert.doesNotThrow(() => {
    monitor.recordChunk("mic", oddLength);
    monitor.recordChunk("system", unaligned);
    monitor.recordChunk("system", Buffer.alloc(1));
    monitor.recordChunk("system", null);
  });
  monitor.tick(START);

  assert.deepEqual(changes, [{ micActive: true, systemActive: true }]);
});

test("reset clears pending and active state without emitting", () => {
  const { monitor, changes } = createMonitor();

  monitor.recordChunk("mic", pcmAtRms(0.05));
  monitor.tick(START);
  monitor.recordChunk("system", pcmAtRms(0.05));
  assert.equal(changes.length, 1);

  monitor.reset();

  assert.deepEqual(monitor.getState(), { micActive: false, systemActive: false });
  monitor.tick(START + 100);
  assert.equal(changes.length, 1, "neither the pending system chunk nor the reset emitted");
});

test("a long tick gap ages out stale activity without spurious activity", () => {
  const { monitor, changes } = createMonitor();

  monitor.recordChunk("mic", pcmAtRms(0.05));
  monitor.tick(START);
  monitor.tick(START + 8 * 60 * 60 * 1000);

  assert.deepEqual(changes, [
    { micActive: true, systemActive: false },
    { micActive: false, systemActive: false },
  ]);
});

test("unknown sources are ignored", () => {
  const { monitor, changes } = createMonitor();

  monitor.recordChunk("other", pcmAtRms(0.5));
  monitor.tick(START);

  assert.deepEqual(changes, []);
});
