const test = require("node:test");
const assert = require("node:assert/strict");

const {
  requiresMicReferenceAlignment,
  SystemAudioSilenceMonitor,
} = require("../../src/helpers/meetingSystemAudio");

const NOW = 1_000_000;
const GRACE_MS = 60000;
const SILENT = 0;
const AUDIBLE = 0.05;

test("helper-process capture strategies require mic reference alignment", () => {
  // Windows and Linux report mode "loopback" for both the helper and the
  // renderer path, so only the strategy can tell them apart.
  assert.equal(requiresMicReferenceAlignment("native"), true);
  assert.equal(requiresMicReferenceAlignment("wasapi-loopback"), true);
  assert.equal(requiresMicReferenceAlignment("pipewire-loopback"), true);
});

test("renderer loopback and absent capture skip mic reference alignment", () => {
  assert.equal(requiresMicReferenceAlignment("loopback"), false);
  assert.equal(requiresMicReferenceAlignment("unsupported"), false);
  assert.equal(requiresMicReferenceAlignment(null), false);
});

test("reports once after a full grace period of silence", () => {
  const monitor = new SystemAudioSilenceMonitor();

  assert.equal(monitor.record(SILENT, NOW), false);
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS - 1), false);
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS), true);
  // A dead capture keeps delivering padded silence for the whole meeting; one
  // warning is the signal, the rest would be noise.
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS * 2), false);
});

test("never reports once any audible chunk arrives", () => {
  const monitor = new SystemAudioSilenceMonitor();

  monitor.record(SILENT, NOW);
  monitor.record(AUDIBLE, NOW + 1000);

  // A far end that goes quiet for minutes after speaking is a normal meeting,
  // not a broken capture.
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS * 3), false);
});

test("measures the grace period from the first chunk, not from construction", () => {
  const monitor = new SystemAudioSilenceMonitor();

  // Capture can start well after the monitor is created; the clock must start
  // when audio actually begins flowing.
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS), false);
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS * 2), true);
});

test("reset re-arms the monitor for the next meeting", () => {
  const monitor = new SystemAudioSilenceMonitor();

  monitor.record(SILENT, NOW);
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS), true);

  monitor.reset();
  assert.equal(monitor.record(SILENT, NOW), false);
  assert.equal(monitor.record(SILENT, NOW + GRACE_MS), true);
});

test("treats chunks exactly at the audibility floor as audio", () => {
  const monitor = new SystemAudioSilenceMonitor({ audibleRms: 0.004 });

  monitor.record(0.004, NOW);

  assert.equal(monitor.record(SILENT, NOW + GRACE_MS), false);
});
