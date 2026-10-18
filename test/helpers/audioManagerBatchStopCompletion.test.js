const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function setup(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-batch-stop-completion-",
    settingsKey: "__batchStopCompletionSettings",
  });
  const finalized = [];
  const stream = { getTracks: () => [] };
  const recorder = {
    state: "recording",
    mimeType: "audio/webm",
    stopCalls: 0,
    stop() {
      this.stopCalls++;
      this.state = "inactive";
    },
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isStreaming: false,
    _batchSegments: [],
    micRecovery: {
      started: true,
      stop() {
        this.started = false;
      },
    },
    _markCaptureStreamReleased() {},
    finalizeBatchRecording: async (segment) => finalized.push(segment),
  });
  manager.createBatchRecorder(stream, { recorder, chunks: [] });
  return { manager, recorder, finalized };
}

test("overlapping batch stops finalize once, after the recorder's final data event", async (t) => {
  const { manager, recorder, finalized } = await setup(t);
  recorder.ondataavailable({ data: new Blob(["opening "]) });
  assert.equal(manager.stopRecording(), true);
  assert.equal(recorder.state, "inactive");
  assert.equal(manager.stopRecording(), true);
  assert.equal(finalized.length, 0, "inactive is not confirmation that the audio has drained");
  recorder.ondataavailable({ data: new Blob(["tail"]) });
  await recorder.onstop();
  assert.equal(recorder.stopCalls, 1);
  assert.equal(finalized.length, 1);
  assert.equal(await finalized[0].text(), "opening tail");
});

test("cancel after stop waits for the final data before retaining the discarded recording", async (t) => {
  const { manager, recorder, finalized } = await setup(t);
  const discarded = [];
  Object.assign(manager, {
    _cancelActivationCapture() {},
    _takeActivationCapture: () => null,
    teardownSpeechGate() {},
    cleanupPreview() {},
    persistDiscardedBatchRecording: (snapshot) => discarded.push(snapshot),
  });
  recorder.stream = { getTracks: () => [] };
  recorder.ondataavailable({ data: new Blob(["opening "]) });
  manager.stopRecording();
  assert.equal(manager.cancelRecording(), true);
  assert.equal(discarded.length, 0, "retention must wait for the final recorder data");
  recorder.ondataavailable({ data: new Blob(["tail"]) });
  await recorder.onstop();
  assert.equal(finalized.length, 0, "cancel must not start a transcription");
  assert.equal(discarded.length, 1);
  assert.equal(await new Blob(discarded[0].chunks).text(), "opening tail");
  assert.equal(recorder.stopCalls, 1);
});

test("stop still finalizes a recorder whose recovery stop event already banked its segment", async (t) => {
  const { manager, recorder, finalized } = await setup(t);
  manager.micRecovery.recover = () => {};
  recorder.state = "inactive";
  recorder.ondataavailable({ data: new Blob(["banked audio"]) });
  await recorder.onstop();
  assert.equal(manager._batchSegments.length, 1);
  assert.equal(finalized.length, 0);
  assert.equal(manager.stopRecording(), true);
  assert.deepEqual(finalized, [null]);
});
