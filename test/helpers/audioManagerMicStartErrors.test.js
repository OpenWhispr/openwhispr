const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// A microphone that won't open must reach the pill as a mic error with a code
// it can translate, from the batch and the streaming start alike. On Windows,
// another app holding the mic in exclusive mode surfaces as NotReadableError (#1138).
async function managerWhoseMicFails(t, error) {
  const { createManager, vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-mic-start-errors-test-",
    settingsKey: "__micStartErrorsSettings",
    mockModules: { "/utils/platform": 'export const getCachedPlatform = () => "win32";' },
  });
  const { getRecordingErrorTitle } = await vite.ssrLoadModule("/utils/recordingErrors.ts");
  const errors = [];
  const cleanups = [];
  const manager = createManager({
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    _streamingStopPromise: null,
    isRecordingAllowedByPolicy: () => true,
    preparedMicCapture: { take: async () => null },
    getAudioConstraints: async () => ({ audio: {} }),
    _startPcmTap: () => null,
    _acquireCaptureStream: async () => {
      throw error;
    },
    _settleStreamingStart() {},
    getStreamingProviderName: () => "openai-realtime",
    cleanupStreaming: async () => cleanups.push("cleanupStreaming"),
    onStateChange() {},
    // Like the pill, which titles every report; a numeric `code` made this throw.
    onError: (report) => {
      getRecordingErrorTitle(report, (key) => key);
      errors.push(report);
    },
  });
  return { manager, errors, cleanups };
}

// Chromium's rejection, whose legacy numeric `code` (0) must not reach the pill.
const deviceInUse = () => new DOMException("Device in use", "NotReadableError");

test("a batch start on a microphone another app holds reports MIC_IN_USE", async (t) => {
  const { manager, errors } = await managerWhoseMicFails(t, deviceInUse());

  assert.equal(await manager.startRecording(), false);

  assert.deepEqual(errors, [
    {
      code: "MIC_IN_USE",
      title: "Microphone In Use",
      messageKey: "hooks.audioRecording.errorDescriptions.micInUseWindows",
    },
  ]);
});

test("a streaming start on a microphone another app holds reports MIC_IN_USE too", async (t) => {
  const { manager, errors, cleanups } = await managerWhoseMicFails(t, deviceInUse());

  assert.equal(await manager.startStreamingRecording(), false);

  assert.deepEqual(cleanups, ["cleanupStreaming"], "the failed start still cleans up");
  assert.equal(manager.isRecording, false);

  assert.deepEqual(errors, [
    {
      code: "MIC_IN_USE",
      title: "Microphone In Use",
      messageKey: "hooks.audioRecording.errorDescriptions.micInUseWindows",
    },
  ]);
});

test("a batch start that fails for another reason keeps the generic report", async (t) => {
  const { manager, errors } = await managerWhoseMicFails(t, new Error("graph failed"));

  await manager.startRecording();

  assert.deepEqual(errors, [
    { title: "Recording Error", description: "Failed to access microphone: graph failed" },
  ]);
});

test("a streaming start that fails for another reason keeps its own report", async (t) => {
  const failure = Object.assign(new Error("expired"), { code: "AUTH_EXPIRED" });
  const { manager, errors } = await managerWhoseMicFails(t, failure);

  await manager.startStreamingRecording();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "AUTH_EXPIRED");
  assert.equal(errors[0].title, "Sign-in Required");
});
