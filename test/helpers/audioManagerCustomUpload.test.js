const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

async function loadCustomManager(t, decode) {
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    decodeAudioData() {
      return decode();
    }
  };
  t.after(() => {
    if (originalContext === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = originalContext;
  });
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-custom-upload-test-",
    settingsKey: "__customUploadSettings",
    settings: {
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
      cloudTranscriptionModel: "whisper-1",
      allowLocalFallback: false,
    },
  });
  return createManager({
    isProcessing: true,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _localSpeechGateState: null,
    getEffectiveSttLanguage: () => "auto",
    getTranscriptionModel: () => "whisper-1",
    getAPIKey: async () => "test-key",
    getTranscriptionEndpoint: () => "https://stt.example.com/v1/audio/transcriptions",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
    onStateChange() {},
  });
}

function decodedAudio(frameCount = 8) {
  const samples = new Float32Array(frameCount);
  return { sampleRate: 16000, numberOfChannels: 1, getChannelData: () => samples };
}

test("custom dictation preserves the original when WAV would exceed the upload limit", async (t) => {
  const originalAudio = new Blob(["original recording"], { type: "audio/webm" });
  for (const { wavBytes, expectedType } of [
    { wavBytes: 60, expectedType: "audio/wav" },
    { wavBytes: 25 * 1024 * 1024, expectedType: "audio/wav" },
    { wavBytes: 25 * 1024 * 1024 + 2, expectedType: "audio/webm" },
  ]) {
    await t.test(`${wavBytes} byte WAV uploads as ${expectedType}`, async (t) => {
      const manager = await loadCustomManager(t, async () => decodedAudio((wavBytes - 44) / 2));
      let uploadedPart;
      t.mock.method(globalThis, "fetch", async (_url, init) => {
        uploadedPart = init.body.get("file");
        return new Response(JSON.stringify({ text: "transcribed" }), { status: 200 });
      });

      const result = await manager.processWithOpenAIAPI(originalAudio);

      assert.equal(result.text, "transcribed");
      assert.equal(uploadedPart.type, expectedType);
      assert.equal(uploadedPart.name, expectedType === "audio/wav" ? "audio.wav" : "audio.webm");
      if (expectedType === "audio/webm") {
        assert.deepEqual(await uploadedPart.arrayBuffer(), await originalAudio.arrayBuffer());
      } else {
        assert.equal(uploadedPart.size, wavBytes);
        assert.equal(await uploadedPart.slice(0, 4).text(), "RIFF");
      }
    });
  }
});

for (const conversionFails of [false, true]) {
  test(`cancelled conversion cannot upload or replace a newer request (${conversionFails ? "failure" : "success"})`, async (t) => {
    const conversionStarted = deferred();
    const finishConversion = deferred();
    let decodeCalls = 0;
    const manager = await loadCustomManager(t, async () => {
      if (++decodeCalls === 1) {
        conversionStarted.resolve();
        await finishConversion.promise;
        if (conversionFails) throw new Error("Cannot decode recording");
      }
      return decodedAudio();
    });
    const requestStarted = deferred();
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests.push(init);
      requestStarted.resolve();
      if (requests.length > 1) {
        return new Response(JSON.stringify({ text: "cancelled recording" }), { status: 200 });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("Cancelled", "AbortError"))
        );
      });
    });
    const firstRun = manager.processAudio(new Blob(["first"], { type: "audio/webm" }));
    await conversionStarted.promise;
    assert.equal(manager.cancelProcessing(), true);
    manager.isProcessing = true;
    const secondRun = manager.processAudio(new Blob(["second"], { type: "audio/webm" }));
    await requestStarted.promise;
    const secondController = manager._activeTranscriptionAbortController;

    finishConversion.resolve();
    await firstRun;
    const requestCount = requests.length;
    const currentController = manager._activeTranscriptionAbortController;
    manager.cancelProcessing();
    const secondRequestAborted = requests[0].signal.aborted;
    secondController.abort();
    await Promise.all([firstRun, secondRun]);

    assert.equal(requestCount, 1, "cancelled audio must not be uploaded");
    assert.equal(
      currentController,
      secondController,
      "the newer request must retain cancellation ownership"
    );
    assert.equal(secondRequestAborted, true);
  });
}
