const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const listeners = new Map();
  const invocations = [];
  const sends = [];
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return undefined;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: (...args) => sends.push(args),
    sendSync: () => undefined,
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposedApi = api;
      },
    },
    ipcRenderer,
    webUtils: {},
  };
  const source = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (specifier) => {
      if (specifier === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  return { api: exposedApi, invocations, listeners, sends };
}

test("auth token-state listener strips the Electron event object", () => {
  const { api, listeners } = loadPreloadApi();
  const payload = { generation: 7, hasToken: true };
  let received;
  const unsubscribe = api.onAuthTokenStateChanged((state) => {
    received = state;
  });

  listeners.get("auth-token-state-changed")?.({ sender: "ipc" }, payload);

  assert.equal(received, payload);
  unsubscribe();
  assert.equal(listeners.has("auth-token-state-changed"), false);
});

test("meeting stop forwards the optional expected recording session ID", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.meetingTranscriptionStop("meeting-2");

  assert.deepEqual(invocations, [["meeting-transcription-stop", "meeting-2"]]);
});

test("meeting system-audio availability forwards the scoped session", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.meetingTranscriptionSetSystemAudioAvailable("meeting-2", true);

  assert.deepEqual(invocations, [
    ["meeting-transcription-set-system-audio-available", "meeting-2", true],
  ]);
});

test("meeting auto-end listener strips the event and can unsubscribe", () => {
  const { api, listeners } = loadPreloadApi();
  const payload = { sessionId: "meeting-2" };
  let received;
  const unsubscribe = api.onMeetingAutoEndRequested((request) => {
    received = request;
  });

  listeners.get("meeting-auto-end-requested")?.({ sender: "ipc" }, payload);

  assert.equal(received, payload);
  unsubscribe();
  assert.equal(listeners.has("meeting-auto-end-requested"), false);
});

test("meeting auto-end keep forwards the recording session ID", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.meetingAutoEndKeep("meeting-2");

  assert.deepEqual(invocations, [["meeting-auto-end-keep", "meeting-2"]]);
});

test("assistant busy state is forwarded to the main-process hotkey guard", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.setAssistantPanelBusy(true);

  assert.deepEqual(invocations, [["set-assistant-panel-busy", true]]);
});

test("agent streaming forwards correlated start and cancel messages", () => {
  const { api, sends } = loadPreloadApi();
  const messages = [{ role: "user", content: "hello" }];
  const options = { systemPrompt: "Answer clearly." };

  api.startAgentStream("request-a", messages, options);
  api.cancelAgentStream("request-a");

  assert.deepEqual(sends, [
    ["cloud-agent-stream-start", "request-a", messages, options],
    ["cloud-agent-stream-cancel", "request-a"],
  ]);
});

test("cloud reasoning cancellation is forwarded to the main process", () => {
  const { api, sends } = loadPreloadApi();

  api.cancelCloudReason();

  assert.deepEqual(sends, [["cloud-reason-cancel"]]);
});

test("reasoning claims are appended only to reasoning start APIs", async (t) => {
  const claim = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    configGeneration: 11,
    managed: true,
    provider: "qwen",
    model: "qwen3.5-4b-q4_k_m",
  };
  const config = {
    provider: "qwen",
    inferenceScope: "chatIntelligence",
    setupMode: "auto",
  };
  const invokeRows = [
    [
      "authorizeReasoningStart",
      "authorize-reasoning-start",
      [
        {
          provider: "qwen",
          model: "qwen3.5-4b-q4_k_m",
          inferenceScope: "chatIntelligence",
          setupMode: "auto",
        },
      ],
    ],
    ["processLocalReasoning", "process-local-reasoning", ["hello", claim.model, null, config]],
    [
      "processAnthropicReasoning",
      "process-anthropic-reasoning",
      ["hello", "claude-sonnet-4", null, { ...config, provider: "anthropic" }],
    ],
    [
      "processEnterpriseReasoning",
      "process-enterprise-reasoning",
      ["hello", "deployment-a", null, { ...config, provider: "azure" }],
    ],
    ["cloudReason", "cloud-reason", ["hello", { inferenceScope: "dictationCleanup" }]],
  ];

  for (const [method, channel, args] of invokeRows) {
    await t.test(method, async () => {
      const { api, invocations } = loadPreloadApi();
      await api[method](...args, claim);
      assert.deepEqual(invocations, [[channel, ...args, claim]]);
    });
  }

  await t.test("enterpriseStreamStart uses the claim captured in call settings", async () => {
    const { api, invocations } = loadPreloadApi();
    const payload = {
      streamId: "stream-a",
      provider: "azure",
      modelId: "deployment-a",
      config: { ...config, reasoningStartClaim: claim },
      options: {},
    };
    await api.enterpriseStreamStart(payload);
    assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
      ["enterprise-stream-start", { ...payload, config: { ...config } }, claim],
    ]);
  });

  await t.test("agent stream start carries a claim but cancel remains claim-free", () => {
    const { api, sends } = loadPreloadApi();
    const messages = [{ role: "user", content: "hello" }];
    const options = { systemPrompt: "Answer.", inferenceScope: "chatIntelligence" };
    api.startAgentStream("request-a", messages, options, claim);
    api.cancelAgentStream("request-a", claim);
    assert.deepEqual(sends, [
      ["cloud-agent-stream-start", "request-a", messages, options, claim],
      ["cloud-agent-stream-cancel", "request-a"],
    ]);
  });
});

test("cloud transcription cancellation is forwarded to the main process", () => {
  const { api, sends } = loadPreloadApi();

  api.cancelCloudTranscription();

  assert.deepEqual(sends, [["cloud-transcribe-cancel"]]);
});

test("inference claims are appended only to start APIs", async (t) => {
  const claim = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    configGeneration: 11,
    managed: true,
    provider: "whisper",
    model: "small",
  };
  const rows = [
    [
      "authorizeTranscriptionStart",
      "authorize-transcription-start",
      [{ provider: "openai", model: "whisper-1" }],
    ],
    ["transcribeAudioFile", "transcribe-audio-file", ["/tmp/audio.webm", { language: "en" }]],
    [
      "transcribeLocalWhisper",
      "transcribe-local-whisper",
      [new ArrayBuffer(4), { model: "small" }],
    ],
    [
      "transcribeLocalParakeet",
      "transcribe-local-parakeet",
      [new ArrayBuffer(4), { model: "base" }],
    ],
    ["proxyXaiTranscription", "proxy-xai-transcription", [{ audio: "data" }]],
    ["proxyMistralTranscription", "proxy-mistral-transcription", [{ audio: "data" }]],
    ["proxyCortiTranscription", "proxy-corti-transcription", [{ audio: "data" }]],
    ["proxyTinfoilTranscription", "proxy-tinfoil-transcription", [{ audio: "data" }]],
    ["cloudTranscribe", "cloud-transcribe", [new ArrayBuffer(4), { language: "en" }]],
    [
      "transcribeAudioFileCloud",
      "transcribe-audio-file-cloud",
      ["/tmp/audio.webm", { language: "en" }],
    ],
    ["transcribeAudioFileByok", "transcribe-audio-file-byok", [{ filePath: "/tmp/audio.webm" }]],
    ["retryTranscription", "retry-transcription", [7, { transcriptionMode: "local" }]],
    ["assemblyAiStreamingWarmup", "assemblyai-streaming-warmup", [{ language: "en" }]],
    ["assemblyAiStreamingStart", "assemblyai-streaming-start", [{ language: "en" }]],
    ["deepgramStreamingWarmup", "deepgram-streaming-warmup", [{ language: "en" }]],
    ["deepgramStreamingStart", "deepgram-streaming-start", [{ language: "en" }]],
    ["cortiStreamingWarmup", "corti-streaming-warmup", [{ language: "en" }]],
    ["cortiStreamingStart", "corti-streaming-start", [{ language: "en" }]],
    ["dictationRealtimeWarmup", "dictation-realtime-warmup", [{ provider: "openai-realtime" }]],
    ["dictationRealtimeStart", "dictation-realtime-start", [{ provider: "openai-realtime" }]],
    ["startDictationPreview", "start-dictation-preview", [{ provider: "whisper" }]],
    ["meetingTranscriptionPrepare", "meeting-transcription-prepare", [{ provider: "local" }]],
    ["meetingTranscriptionStart", "meeting-transcription-start", [{ provider: "local" }]],
  ];

  for (const [method, channel, args] of rows) {
    await t.test(method, async () => {
      const { api, invocations } = loadPreloadApi();
      await api[method](...args, claim);
      assert.deepEqual(invocations, [[channel, ...args, claim]]);
    });
  }

  const negativeRows = [
    [
      "meetingTranscriptionStop",
      ["meeting-2"],
      "invoke",
      ["meeting-transcription-stop", "meeting-2"],
    ],
    ["meetingTranscriptionCancel", [], "invoke", ["meeting-transcription-cancel"]],
    [
      "meetingTranscriptionSend",
      [new ArrayBuffer(2), "mic"],
      "send",
      ["meeting-transcription-send", new ArrayBuffer(2), "mic"],
    ],
    [
      "cancelUploadTranscription",
      ["request-1"],
      "invoke",
      ["cancel-upload-transcription", "request-1"],
    ],
    [
      "assemblyAiStreamingSend",
      [new ArrayBuffer(2)],
      "send",
      ["assemblyai-streaming-send", new ArrayBuffer(2)],
    ],
    ["assemblyAiStreamingStop", [], "invoke", ["assemblyai-streaming-stop"]],
    [
      "deepgramStreamingSend",
      [new ArrayBuffer(2)],
      "send",
      ["deepgram-streaming-send", new ArrayBuffer(2)],
    ],
    ["deepgramStreamingFinalize", [], "send", ["deepgram-streaming-finalize"]],
    ["deepgramStreamingStop", [], "invoke", ["deepgram-streaming-stop"]],
    [
      "cortiStreamingSend",
      [new ArrayBuffer(2)],
      "send",
      ["corti-streaming-send", new ArrayBuffer(2)],
    ],
    ["cortiStreamingFinalize", [], "send", ["corti-streaming-finalize"]],
    ["cortiStreamingStop", [], "invoke", ["corti-streaming-stop"]],
    [
      "dictationRealtimeSend",
      [new ArrayBuffer(2)],
      "send",
      ["dictation-realtime-send", new ArrayBuffer(2)],
    ],
    ["dictationRealtimeStop", [], "invoke", ["dictation-realtime-stop"]],
    [
      "stopDictationPreview",
      [{ reason: "cancel" }],
      "invoke",
      ["stop-dictation-preview", { reason: "cancel" }],
    ],
  ];
  for (const [method, args, transport, expected] of negativeRows) {
    await t.test(`${method} ignores claims`, async () => {
      const { api, invocations, sends } = loadPreloadApi();
      await api[method](...args, claim);
      assert.deepEqual(invocations, transport === "invoke" ? [expected] : []);
      assert.deepEqual(sends, transport === "send" ? [expected] : []);
    });
  }

  const { api, invocations, sends } = loadPreloadApi();
  api.cancelCloudTranscription(claim);
  assert.deepEqual(invocations, []);
  assert.deepEqual(sends, [["cloud-transcribe-cancel"]]);
});

test("agent streaming listeners strip Electron events and preserve correlation", () => {
  const { api, listeners } = loadPreloadApi();
  const received = {};
  const cleanups = [
    api.onAgentStreamChunk((payload) => {
      received.chunk = payload;
    }),
    api.onAgentStreamError((payload) => {
      received.error = payload;
    }),
    api.onAgentStreamEnd((payload) => {
      received.end = payload;
    }),
  ];
  const chunk = { requestId: "request-a", chunk: { type: "content", text: "hello" } };
  const error = { requestId: "request-b", error: "failed", code: "SERVER_ERROR" };
  const end = { requestId: "request-c" };

  listeners.get("cloud-agent-stream-chunk")?.({ sender: "ipc" }, chunk);
  listeners.get("cloud-agent-stream-error")?.({ sender: "ipc" }, error);
  listeners.get("cloud-agent-stream-end")?.({ sender: "ipc" }, end);

  assert.equal(received.chunk, chunk);
  assert.equal(received.error, error);
  assert.equal(received.end, end);

  for (const cleanup of cleanups) cleanup();
  assert.equal(listeners.has("cloud-agent-stream-chunk"), false);
  assert.equal(listeners.has("cloud-agent-stream-error"), false);
  assert.equal(listeners.has("cloud-agent-stream-end"), false);
});
