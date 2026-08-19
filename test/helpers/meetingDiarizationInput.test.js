const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDiarizationInput } = require("../../src/helpers/meetingDiarizationInput");

test("audible system audio diarizes the system capture", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: "/tmp/ow-diarize-raw-1.pcm",
    micPcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    systemAudioHeard: true,
    systemStartedAt: 1000,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-1.pcm",
    startedAt: 1000,
    diarizedSource: "system",
    cleanupPcmPaths: ["/tmp/ow-diarize-raw-mic-1.pcm"],
  });
});

test("a silent system capture yields to the mic capture", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: "/tmp/ow-diarize-raw-1.pcm",
    micPcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    systemAudioHeard: false,
    systemStartedAt: 1000,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    startedAt: 900,
    diarizedSource: "mic",
    cleanupPcmPaths: ["/tmp/ow-diarize-raw-1.pcm"],
  });
});

test("a silent system capture with no mic capture keeps today's system path", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: "/tmp/ow-diarize-raw-1.pcm",
    micPcmPath: null,
    systemAudioHeard: false,
    systemStartedAt: 1000,
    micStartedAt: null,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-1.pcm",
    startedAt: 1000,
    diarizedSource: "system",
    cleanupPcmPaths: [],
  });
});

test("no capture at all skips diarization without cleanup work", () => {
  const input = resolveDiarizationInput({});

  assert.deepEqual(input, {
    pcmPath: null,
    startedAt: null,
    diarizedSource: "system",
    cleanupPcmPaths: [],
  });
});

test("mic-only capture (no system channel) diarizes the mic", () => {
  // Linux "unsupported" system-audio mode never delivers a system chunk, so
  // only the mic capture exists.
  const input = resolveDiarizationInput({
    systemPcmPath: null,
    micPcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    systemAudioHeard: false,
    systemStartedAt: null,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    startedAt: 900,
    diarizedSource: "mic",
    cleanupPcmPaths: [],
  });
});
