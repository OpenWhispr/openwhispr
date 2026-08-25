const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadManager(t) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-routing-test-",
    settingsKey: "__streamingRoutingSettings",
  });
  return createManager();
}

function setSettings(overrides = {}) {
  globalThis.__streamingRoutingSettings = {
    useLocalWhisper: false,
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    openaiApiKey: "sk-test",
    isSignedIn: true,
    ...overrides,
  };
}

test("managed batch config does not disable BYOK OpenAI realtime transcription", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = { dictation: { mode: "batch" } };
  setSettings();

  assert.equal(manager.shouldUseStreaming(), true);
});

test("every dictation streaming caller passes its exact route claim", async (t) => {
  const manager = await loadManager(t);
  const rows = [
    {
      name: "AssemblyAI",
      settings: { cloudTranscriptionModel: "best" },
      sttConfig: { streamingProvider: "assemblyai" },
      bridgePrefix: "assemblyAiStreaming",
      options: { model: "best", mode: "openwhispr" },
      expectedOptions: { model: "best", mode: "openwhispr" },
      claim: { provider: "assemblyai", model: "best" },
    },
    {
      name: "Deepgram",
      settings: { cloudTranscriptionModel: "nova-3" },
      sttConfig: { streamingProvider: "deepgram" },
      bridgePrefix: "deepgramStreaming",
      options: { model: "nova-3", mode: "openwhispr" },
      expectedOptions: { model: "nova-3", mode: "openwhispr" },
      claim: { provider: "deepgram", model: "nova-3" },
    },
    {
      name: "Corti",
      settings: {
        cloudTranscriptionProvider: "corti",
        cloudTranscriptionModel: "corti-transcribe",
      },
      bridgePrefix: "cortiStreaming",
      options: { model: "corti-transcribe", mode: "byok" },
      expectedOptions: { model: "corti-transcribe", mode: "byok" },
      claim: { provider: "corti", model: "corti-transcribe" },
    },
    {
      name: "OpenAI realtime",
      settings: { cloudTranscriptionModel: "gpt-4o-mini-transcribe" },
      bridgePrefix: "dictationRealtime",
      options: { model: "gpt-4o-mini-transcribe", mode: "byok" },
      expectedOptions: {
        model: "gpt-4o-mini-transcribe",
        mode: "byok",
        provider: "openai-realtime",
      },
      claim: { provider: "openai-realtime", model: "gpt-4o-mini-transcribe" },
    },
    {
      name: "Tinfoil realtime",
      settings: {
        cloudTranscriptionProvider: "tinfoil",
        cloudTranscriptionModel: "",
      },
      bridgePrefix: "dictationRealtime",
      options: { mode: "byok" },
      expectedOptions: {
        mode: "byok",
        provider: "tinfoil-realtime",
        model: "voxtral-mini-4b-realtime",
      },
      claim: { provider: "tinfoil-realtime", model: "voxtral-mini-4b-realtime" },
    },
  ];

  for (const row of rows) {
    await t.test(row.name, async () => {
      setSettings({ isSignedIn: false, ...row.settings });
      manager.sttConfig = row.sttConfig;
      const calls = [];
      globalThis.window.electronAPI[`${row.bridgePrefix}Warmup`] = async (...args) => {
        calls.push(["warmup", ...args]);
        return { success: true };
      };
      globalThis.window.electronAPI[`${row.bridgePrefix}Start`] = async (...args) => {
        calls.push(["start", ...args]);
        return { success: true };
      };

      const provider = manager.getStreamingProvider();
      await provider.warmup(row.options);
      await provider.start(row.options);

      const expectedClaim = {
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        configGeneration: null,
        managed: false,
        ...row.claim,
      };
      assert.deepEqual(calls, [
        ["warmup", row.expectedOptions, expectedClaim],
        ["start", row.expectedOptions, expectedClaim],
      ]);
    });
  }
});

test("the actual audio-manager preview caller passes its exact local claim", async (t) => {
  const manager = await loadManager(t);
  setSettings({
    isSignedIn: false,
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    preferredLanguage: "en-US",
    showTranscriptionPreview: true,
  });

  const originalAudioContext = globalThis.AudioContext;
  const originalAudioWorkletNode = globalThis.AudioWorkletNode;
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.audioWorklet = { addModule: async () => {} };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getByteTimeDomainData(values) {
          values.fill(128);
        },
      };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null };
    }
    connect() {}
  }
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  t.after(() => {
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
    if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
    else globalThis.AudioWorkletNode = originalAudioWorkletNode;
    if (manager._silenceInterval) clearInterval(manager._silenceInterval);
  });

  const track = {
    label: "Test microphone",
    muted: false,
    readyState: "live",
    getSettings: () => ({ deviceId: "test-device", sampleRate: 48_000, channelCount: 1 }),
  };
  const micStream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  Object.assign(manager, {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    mediaRecorder: null,
    voiceAgentRequested: false,
    preparedMicCapture: { take: async () => null },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({ audio: true }),
    _acquireCaptureStream: async () => micStream,
    createBatchRecorder() {},
    getWorkletBlobUrl: () => "blob:test-worklet",
    beginMicRecovery: async () => {},
  });

  const calls = [];
  globalThis.window.electronAPI.startDictationPreview = async (...args) => {
    calls.push(args);
    return { success: true };
  };

  assert.equal(await manager.startRecording(), true);
  assert.deepEqual(calls, [
    [
      {
        provider: "nvidia",
        model: "parakeet-tdt-0.6b-v3",
        language: "en",
        display: true,
      },
      {
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        configGeneration: null,
        managed: false,
        provider: "nvidia",
        model: "parakeet-tdt-0.6b-v3",
      },
    ],
  ]);
});

test("managed OpenWhispr Cloud still respects its batch configuration", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = { dictation: { mode: "batch" } };
  setSettings({
    transcriptionMode: "openwhispr",
    cloudTranscriptionMode: "openwhispr",
  });

  assert.equal(manager.shouldUseStreaming(), false);
});
