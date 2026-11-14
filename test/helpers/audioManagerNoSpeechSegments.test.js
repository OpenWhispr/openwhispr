const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadManager(t, { provider, model, ...settings }) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-no-speech-segments-test-",
    settingsKey: "__noSpeechSegmentsSettings",
    settings: {
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: provider,
      cloudTranscriptionModel: model,
      allowLocalFallback: false,
      ...settings,
    },
  });
  return createManager({
    isProcessing: true,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _localSpeechGateState: null,
    getEffectiveSttLanguage: () => "en",
    getTranscriptionModel: () => model,
    getAPIKey: async () => "test-key",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
    onStateChange() {},
  });
}

function mockTranscription(t, body) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, fields: Object.fromEntries(init.body.entries()) });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return requests;
}

// Speech, then ~10 s of silence that Whisper filled with a training-data outro (#462).
const trailingHallucination = {
  text: " Send the report to Dana by Friday. Thank you for watching!",
  segments: [
    {
      id: 0,
      start: 0,
      end: 2.4,
      text: " Send the report to Dana by Friday.",
      avg_logprob: -0.21,
      no_speech_prob: 0.02,
      compression_ratio: 1.1,
    },
    {
      id: 1,
      start: 2.4,
      end: 12.0,
      text: " Thank you for watching!",
      avg_logprob: -1.32,
      no_speech_prob: 0.93,
      compression_ratio: 0.8,
    },
  ],
};

const audio = () => new Blob(["x"], { type: "audio/webm" });

for (const { provider, model } of [
  { provider: "groq", model: "whisper-large-v3" },
  { provider: "groq", model: "whisper-large-v3-turbo" },
  { provider: "openai", model: "whisper-1" },
]) {
  test(`${provider} ${model} dictation drops a trailing no-speech segment`, async (t) => {
    const manager = await loadManager(t, { provider, model });
    const requests = mockTranscription(t, trailingHallucination);

    const result = await manager.processWithOpenAIAPI(audio());

    assert.equal(requests.length, 1);
    assert.equal(requests[0].fields.response_format, "verbose_json");
    assert.equal(result.text, "Send the report to Dana by Friday.");
    assert.equal(result.rawText, "Send the report to Dana by Friday.");
  });
}

test("a segment the decoder was confident in is kept despite its no_speech_prob", async (t) => {
  const manager = await loadManager(t, { provider: "groq", model: "whisper-large-v3" });
  const body = {
    text: " Remind me to call mom.",
    segments: [
      {
        start: 0,
        end: 1.8,
        text: " Remind me to call mom.",
        avg_logprob: -0.45,
        no_speech_prob: 0.72,
      },
    ],
  };
  mockTranscription(t, body);

  const result = await manager.processWithOpenAIAPI(audio());

  assert.equal(result.text, body.text);
});

test("a transcript of only no-speech segments fails like an empty transcript", async (t) => {
  const manager = await loadManager(t, { provider: "groq", model: "whisper-large-v3" });
  const responses = [
    { text: "" },
    {
      text: " Thank you for watching!",
      segments: [
        {
          start: 0,
          end: 9.6,
          text: " Thank you for watching!",
          avg_logprob: -1.2,
          no_speech_prob: 0.97,
        },
      ],
    },
  ];
  const errors = [];
  for (const body of responses) {
    t.mock.restoreAll();
    mockTranscription(t, body);
    errors.push(
      await manager.processWithOpenAIAPI(audio()).then(
        (result) => result,
        (error) => error.message
      )
    );
  }

  assert.match(errors[0], /^No text transcribed/);
  assert.equal(errors[1], errors[0]);
});

for (const { label, settings } of [
  {
    label: "gpt-4o-transcribe",
    settings: { provider: "openai", model: "gpt-4o-transcribe" },
  },
  {
    label: "a custom endpoint",
    settings: {
      provider: "custom",
      model: "whisper-1",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
    },
  },
]) {
  test(`${label} keeps the plain-text request and the provider's text`, async (t) => {
    const manager = await loadManager(t, settings);
    const requests = mockTranscription(t, trailingHallucination);

    const result = await manager.processWithOpenAIAPI(audio());

    assert.equal(requests.length, 1);
    assert.equal(requests[0].fields.response_format, undefined);
    assert.equal(result.text, trailingHallucination.text);
  });
}
