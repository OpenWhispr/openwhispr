const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");

// The PCM tap must follow the batch recorder exactly: handed over at finalize,
// released on cancel, and carried onto a replacement microphone.

async function load(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-pcm-tap-lifecycle-test-",
    settingsKey: "__pcmTapLifecycleSettings",
  });
  return AudioManager;
}

const webm = () => new Blob([new Uint8Array(512)], { type: "audio/webm" });
const wav = () => new Blob([new Uint8Array(4)], { type: "audio/wav" });

function finalizingManager(AudioManager, tap) {
  let handoff = null;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _batchSegments: [],
    _batchPcmTap: tap,
    _receivedAudioData: true,
    _localSpeechGateState: null,
    _streamingCommitActive: false,
    recordingMimeType: "audio/webm",
    recordingStartTime: Date.now(),
    lastAudioBlob: null,
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    cleanupPreview: async () => null,
    shouldShowPreviewCleanupState: () => false,
    mergeRecordedSegments: async () => webm(),
    getLargestRecordedSegment: () => null,
    processAudio: async (blob, metadata) => {
      handoff = { blob, metadata };
    },
    onStateChange() {},
    _requestStreamingCancellation() {},
  });
  return { manager, handoff: () => handoff };
}

test("finalize waits for the tap and hands its WAV over beside the WebM", async (t) => {
  const AudioManager = await load(t);
  const rawWav = wav();
  const { manager, handoff } = finalizingManager(AudioManager, { stop: async () => rawWav });

  await manager.finalizeBatchRecording(webm());

  assert.equal(handoff().blob.type, "audio/webm", "the WebM remains the recording of record");
  assert.strictEqual(handoff().metadata.rawWav, rawWav);
  assert.equal(manager._batchPcmTap, null);
});

test("a dropped tap leaves the WebM path exactly as before", async (t) => {
  const AudioManager = await load(t);
  const { manager, handoff } = finalizingManager(AudioManager, { stop: async () => null });

  await manager.finalizeBatchRecording(webm());

  assert.equal("rawWav" in handoff().metadata, false);
});

test("cancelling a recording releases the tap", async (t) => {
  const AudioManager = await load(t);
  let closes = 0;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    _batchPcmTap: { close: () => (closes += 1) },
    teardownSpeechGate() {},
    cleanupPreview() {},
    onStateChange() {},
  });

  manager.resetDiscardedBatchRecordingState();

  assert.equal(closes, 1);
  assert.equal(manager._batchPcmTap, null);
});

test("a replacement microphone is bound into the same tap", async (t) => {
  const AudioManager = await load(t);
  const replacement = { id: "headset" };
  const rebound = [];
  const recorders = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    mediaRecorder: { state: "inactive" },
    _silenceSource: null,
    _silenceCtx: null,
    _previewSource: null,
    _previewAudioContext: null,
    _batchPcmTap: { attach: (stream) => rebound.push(stream) },
    _cancelRequestedDuringMicRecovery: false,
    _stopRequestedDuringMicRecovery: false,
    createBatchRecorder: (stream) => recorders.push(stream),
  });

  await manager.replaceBatchMic(replacement);

  assert.deepEqual(rebound, [replacement]);
  assert.deepEqual(recorders, [replacement]);
});

async function loadWithSettings(t, settings, mockModules = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-pcm-tap-start-test-",
    settingsKey: "__pcmTapStartSettings",
    settings,
    mockModules,
  });
  installMicCaptureGlobals(t);
  return loaded;
}

const offlineLocal = {
  useLocalWhisper: true,
  localTranscriptionProvider: "nvidia",
  parakeetModel: "orukeet-v0.1.0",
  showTranscriptionPreview: false,
};

test("only offline local engines get a tap", async (t) => {
  const { setSettings, createManager } = await loadWithSettings(t, offlineLocal);
  const manager = createManager({ getWorkletBlobUrl: () => "blob:worklet" });
  const taps = (settings) => {
    setSettings(settings);
    const tap = manager._startPcmTap();
    tap?.close();
    return tap !== null;
  };

  assert.equal(taps({ useLocalWhisper: true, localTranscriptionProvider: "whisper" }), true);
  assert.equal(taps(offlineLocal), true);
  assert.equal(taps({ useLocalWhisper: true, localTranscriptionProvider: "cohere" }), true);
  assert.equal(
    taps({
      useLocalWhisper: true,
      localTranscriptionProvider: "nvidia",
      parakeetModel: "nemotron-speech-streaming-en-0.6b",
    }),
    false,
    "online models commit their own stream"
  );
  assert.equal(taps({ useLocalWhisper: false, cloudTranscriptionMode: "byok" }), false);
  assert.equal(taps({ useLocalWhisper: false, cloudTranscriptionMode: "openwhispr" }), false);
});

test("managed enterprise transcription gets no tap even with local settings", async (t) => {
  const { createManager } = await loadWithSettings(t, offlineLocal, {
    "/services/managedTranscription.ts": `
      export const getManagedTranscriptionResolution = () => ({ kind: "managed" });
      export const isManagedTranscriptionActive = () => true;
    `,
  });
  const manager = createManager({ getWorkletBlobUrl: () => "blob:worklet" });

  assert.equal(manager._startPcmTap(), null);
});

function startingManager(AudioManager, { prepared, tap, events }) {
  const stream = { getAudioTracks: () => [], getTracks: () => [] };
  return Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    _streamingStopPromise: null,
    mediaRecorder: null,
    _batchPcmTap: null,
    _batchSegments: [],
    audioChunks: [],
    preparedMicCapture: { take: async () => prepared },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({ audio: true }),
    _acquireCaptureStream: async () => {
      events.push("acquire");
      return stream;
    },
    _startPcmTap: () => {
      events.push("tap");
      return tap;
    },
    createBatchRecorder: () => events.push("recorder"),
    beginMicRecovery: async () => {},
    onStateChange() {},
  });
}

const fakeTap = (events, name) => ({
  attach: () => events.push(`attach:${name}`),
  close: () => events.push(`close:${name}`),
});

test("a fresh pre-roll hands its tap to the recording", async (t) => {
  const { AudioManager } = await loadWithSettings(t, offlineLocal);
  const events = [];
  const preRollTap = fakeTap(events, "preroll");
  const prepared = {
    stream: { getAudioTracks: () => [], getTracks: () => [] },
    constraints: { audio: true },
    recorder: { state: "recording" },
    chunks: [],
    pcmTap: preRollTap,
    startedAt: Date.now(),
  };
  const manager = startingManager(AudioManager, { prepared, tap: null, events });
  t.after(() => manager.teardownSpeechGate());

  assert.equal(await manager.startRecording(), true);
  assert.strictEqual(manager._batchPcmTap, preRollTap);
  assert.deepEqual(events, ["recorder"], "no second tap is built and nothing is re-attached");
});

test("an expired pre-roll takes its tap with it and the WebM path runs", async (t) => {
  const { AudioManager, vite } = await loadWithSettings(t, offlineLocal);
  const { PRE_ROLL_MAX_AGE_MS } = await vite.ssrLoadModule("/helpers/preparedMicCapture.js");
  const events = [];
  const prepared = {
    stream: { getAudioTracks: () => [], getTracks: () => [] },
    constraints: { audio: true },
    recorder: { state: "recording", stop: () => events.push("recorder-stop") },
    chunks: ["stale"],
    pcmTap: fakeTap(events, "preroll"),
    startedAt: Date.now() - PRE_ROLL_MAX_AGE_MS - 1,
  };
  const manager = startingManager(AudioManager, { prepared, tap: null, events });
  t.after(() => manager.teardownSpeechGate());

  assert.equal(await manager.startRecording(), true);
  assert.equal(manager._batchPcmTap, null);
  assert.deepEqual(events, ["recorder-stop", "close:preroll", "recorder"]);
});

test("without a prepared capture the tap is built before the mic opens and attached with the recorder", async (t) => {
  const { AudioManager } = await loadWithSettings(t, offlineLocal);
  const events = [];
  const tap = fakeTap(events, "fresh");
  const manager = startingManager(AudioManager, { prepared: null, tap, events });
  t.after(() => manager.teardownSpeechGate());

  assert.equal(await manager.startRecording(), true);
  assert.strictEqual(manager._batchPcmTap, tap);
  assert.deepEqual(events, ["tap", "acquire", "recorder", "attach:fresh"]);
});
