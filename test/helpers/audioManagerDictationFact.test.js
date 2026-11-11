const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");

// The dashboard's dictation_completed fact as the dictation pipeline reports
// it: the original words of a finished dictation, with the capture id its
// completion carries.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOCAL_SETTINGS = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  cloudTranscriptionMode: "byok",
  isSignedIn: false,
};

const STREAMING_SETTINGS = {
  useLocalWhisper: false,
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "openai",
};

async function load(t, settings = LOCAL_SETTINGS) {
  return loadAudioManager(t, {
    cachePrefix: "openwhispr-dictation-fact-test-",
    settingsKey: "__dictationFactSettings",
    settings,
  });
}

function recordFacts(window) {
  const facts = [];
  window.electronAPI.recordDictationCompleted = async (fact) => {
    facts.push(fact);
  };
  return facts;
}

function batchManager(AudioManager, transcription, completions) {
  return Object.assign(Object.create(AudioManager.prototype), {
    isProcessing: true,
    _localSpeechGateState: null,
    _processingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: {},
    processWithLocalWhisper: () => transcription.promise,
    onStateChange() {},
    onNoAudio() {},
    onError() {},
    onTranscriptionComplete: (result) => completions.push(result),
    saveFailedTranscription() {},
    _requestStreamingCancellation() {
      this._streamingCancellationGeneration += 1;
    },
  });
}

// As in audioManagerStreamingFinalization.test.js: a stream about to finalize.
function streamingManager(AudioManager, completions) {
  return Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now(),
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 7,
    _activeStreamingSessionId: 7,
    _streamingMicSwapPromise: null,
    streamingFinalText: "",
    streamingPartialText: "",
    streamingTextBump: null,
    streamingTextDebounce: null,
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingAnalyser: null,
    streamingAudioContext: null,
    streamingStream: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      async stop() {
        return { success: true };
      },
    }),
    getEffectiveSttLanguage: () => "auto",
    getStreamingProviderName: () => "openai",
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    finalizeChineseScript: async (text) => text,
    onStateChange() {},
    onTranscriptionComplete: (result) => completions.push(result),
  });
}

test("a dictation reports its original words before cleanup, with its capture and mode", async (t) => {
  const { window, createManager } = await load(t);
  const facts = recordFacts(window);
  const manager = createManager({ lastAudioMetadata: { provider: "local" } });

  manager._recordDictationCompleted({
    success: true,
    rawText: "one two three",
    // Cleanup, or an agent answering in the dictation's place, can paste far more.
    text: "expanded ".repeat(300),
    clientTranscriptionId: "capture-1",
  });
  manager._recordDictationCompleted({
    success: true,
    rawText: "我今天很高兴",
    clientTranscriptionId: "capture-2",
  });

  assert.deepEqual(facts, [
    { captureId: "capture-1", words: 3, mode: "local" },
    { captureId: "capture-2", words: 4, mode: "local" },
  ]);
});

test("an assistant command, a selection edit, a failure or an empty transcript reports nothing", async (t) => {
  const { window, createManager } = await load(t);
  const facts = recordFacts(window);
  const manager = createManager({ lastAudioMetadata: { provider: "local" } });

  for (const result of [
    {
      success: true,
      rawText: "draft a reply",
      assistantConversation: {},
      clientTranscriptionId: "a",
    },
    {
      success: true,
      rawText: "make it formal",
      selectionEdit: { sessionId: 1 },
      clientTranscriptionId: "b",
    },
    { success: false, rawText: "never delivered", clientTranscriptionId: "c" },
    { success: true, rawText: "   ", clientTranscriptionId: "d" },
    { success: true, rawText: "no capture" },
  ]) {
    manager._recordDictationCompleted(result);
  }

  assert.deepEqual(facts, []);
});

test("a failing or missing bridge never reaches the dictation", async (t) => {
  const { window, createManager } = await load(t);
  const manager = createManager({ lastAudioMetadata: null });
  const result = { success: true, rawText: "hello there", clientTranscriptionId: "capture-1" };

  window.electronAPI.recordDictationCompleted = async () => {
    throw new Error("main process busy");
  };
  assert.equal(manager._recordDictationCompleted(result), undefined);
  window.electronAPI.recordDictationCompleted = () => {
    throw new Error("bridge gone");
  };
  assert.equal(manager._recordDictationCompleted(result), undefined);
  delete window.electronAPI.recordDictationCompleted;
  assert.equal(manager._recordDictationCompleted(result), undefined);
  // The rejected IPC was handled, not left to crash the renderer.
  await new Promise(setImmediate);
});

test("a batch recording gets one capture id, shared by its fact and its completion", async (t) => {
  const { AudioManager, window } = await load(t);
  const facts = recordFacts(window);
  const transcription = deferred();
  const completions = [];
  const manager = batchManager(AudioManager, transcription, completions);

  const run = manager.processAudio(new Blob(["audio"]), {});
  transcription.resolve({
    success: true,
    text: "One, two, three, four. Cleaned and expanded.",
    rawText: "one two three four",
    source: "local",
    timings: {},
  });
  await run;

  assert.equal(completions.length, 1);
  assert.match(completions[0].clientTranscriptionId, UUID);
  assert.deepEqual(facts, [
    { captureId: completions[0].clientTranscriptionId, words: 4, mode: "local" },
  ]);
});

test("a successful cloud-to-local fallback reports its raw words before cleanup", async (t) => {
  const { AudioManager, window } = await load(t, {
    ...STREAMING_SETTINGS,
    allowLocalFallback: true,
  });
  const facts = recordFacts(window);
  const completions = [];
  const rawText = "one two three four";
  const cleanedText = "expanded ".repeat(20).trim();
  window.electronAPI.transcribeLocalWhisper = async () => ({ success: true, text: rawText });
  const manager = Object.assign(batchManager(AudioManager, deferred(), completions), {
    getEffectiveSttLanguage: () => "auto",
    getTranscriptionModel: () => "whisper-1",
    getAPIKey: async () => {
      throw new Error("cloud unavailable");
    },
    processTranscription: async () => cleanedText,
  });

  await manager.processAudio(new Blob(["audio"], { type: "audio/webm" }), {});

  assert.equal(completions.length, 1);
  assert.equal(completions[0].success, true);
  assert.equal(completions[0].text, cleanedText);
  assert.equal(completions[0].source, "local-fallback");
  assert.match(completions[0].clientTranscriptionId, UUID);
  assert.deepEqual(facts, [
    { captureId: completions[0].clientTranscriptionId, words: 4, mode: "local" },
  ]);
  assert.equal(completions[0].rawText, rawText);
});

test("a cloud batch recording keeps the capture id it was uploaded under", async (t) => {
  const { AudioManager, window } = await load(t);
  const facts = recordFacts(window);
  const transcription = deferred();
  const completions = [];
  const manager = batchManager(AudioManager, transcription, completions);
  const uploadedAs = "11111111-2222-4333-8444-555555555555";

  const run = manager.processAudio(new Blob(["audio"]), {});
  transcription.resolve({
    success: true,
    text: "two words",
    rawText: "two words",
    source: "local",
    clientTranscriptionId: uploadedAs,
    timings: {},
  });
  await run;

  assert.equal(completions[0].clientTranscriptionId, uploadedAs);
  assert.deepEqual(
    facts.map((fact) => fact.captureId),
    [uploadedAs]
  );
});

test("a batch recording cancelled before it finishes reports nothing", async (t) => {
  const { AudioManager, window } = await load(t);
  const facts = recordFacts(window);
  const transcription = deferred();
  const completions = [];
  const manager = batchManager(AudioManager, transcription, completions);

  const run = manager.processAudio(new Blob(["audio"], { type: "audio/webm" }), {});
  assert.equal(manager.cancelProcessing(), true);
  transcription.resolve({ success: true, text: "late", rawText: "late", source: "local" });
  await run;

  assert.deepEqual(completions, []);
  assert.deepEqual(facts, []);
});

test("a batch recording cancelled while its activation capture settles reports nothing", async (t) => {
  const { AudioManager, window } = await load(t);
  const facts = recordFacts(window);
  const transcription = deferred();
  const reached = deferred();
  const settling = deferred();
  const completions = [];
  const manager = batchManager(AudioManager, transcription, completions);
  manager._completeActivationCapture = () => {
    reached.resolve();
    return settling.promise;
  };

  const run = manager.processAudio(new Blob(["audio"], { type: "audio/webm" }), {});
  transcription.resolve({
    success: true,
    text: "two words",
    rawText: "two words",
    source: "local",
    timings: {},
  });
  await reached.promise;
  assert.equal(manager.cancelProcessing(), true);
  settling.resolve();
  await run;

  assert.deepEqual(completions, []);
  assert.deepEqual(facts, []);
});

test("a streamed recording reports under the capture id its completion carries", async (t) => {
  const { AudioManager, window } = await load(t, STREAMING_SETTINGS);
  const facts = recordFacts(window);
  globalThis.window.dispatchEvent = () => true;
  const completions = [];
  const manager = streamingManager(AudioManager, completions);
  manager.streamingFinalText = "same event";

  await manager.stopStreamingRecording();

  assert.match(completions[0].clientTranscriptionId, UUID);
  assert.deepEqual(facts, [
    { captureId: completions[0].clientTranscriptionId, words: 2, mode: "byok" },
  ]);
});

test("a streamed assistant command reports nothing", async (t) => {
  const { AudioManager, window } = await load(t, STREAMING_SETTINGS);
  const facts = recordFacts(window);
  globalThis.window.dispatchEvent = () => true;
  const completions = [];
  const manager = streamingManager(AudioManager, completions);
  manager.streamingFinalText = "summarize my unread email";
  manager.pendingAssistantConversation = { transcript: "summarize my unread email" };

  await manager.stopStreamingRecording();

  assert.equal(completions.length, 1);
  assert.deepEqual(facts, []);
});
