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

test("meeting authorization abort forwards the optional recording session ID", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.meetingTranscriptionAbort("meeting-2");

  assert.deepEqual(invocations, [["meeting-transcription-abort", "meeting-2"]]);
});

test("meeting system-audio availability forwards the scoped session", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.meetingTranscriptionSetSystemAudioAvailable("meeting-2", true);

  assert.deepEqual(invocations, [
    ["meeting-transcription-set-system-audio-available", "meeting-2", true],
  ]);
});

test("audio ingress forwards opaque meeting, dictation, provider, and preview transport IDs", () => {
  const { api, sends } = loadPreloadApi();
  const audio = new ArrayBuffer(4);

  api.meetingTranscriptionSend("meeting-2", audio, "mic");
  api.dictationRealtimeSend("dictation-2", audio);
  api.assemblyAiStreamingSend("assembly-2", audio);
  api.deepgramStreamingSend("deepgram-2", audio);
  api.cortiStreamingSend("corti-2", audio);
  api.sendDictationPreviewAudio("preview-2", audio);

  assert.deepEqual(sends, [
    ["meeting-transcription-send", "meeting-2", audio, "mic"],
    ["dictation-realtime-send", "dictation-2", audio],
    ["assemblyai-streaming-send", "assembly-2", audio],
    ["deepgram-streaming-send", "deepgram-2", audio],
    ["corti-streaming-send", "corti-2", audio],
    ["dictation-preview-audio", "preview-2", audio],
  ]);
});

test("meeting transcript commit forwards its main-issued capability", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.commitMeetingTranscript({
    commitToken: "commit-2",
    noteId: 42,
    transcript: "[]",
    kind: "diarization",
  });

  assert.deepEqual(invocations, [
    [
      "meeting-transcription-commit",
      {
        commitToken: "commit-2",
        noteId: 42,
        transcript: "[]",
        kind: "diarization",
      },
    ],
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

test("cloud transcription cancellation is forwarded to the main process", () => {
  const { api, sends } = loadPreloadApi();

  api.cancelCloudTranscription();

  assert.deepEqual(sends, [["cloud-transcribe-cancel"]]);
});

test("dictation authorization abort invokes the non-finalizing main-process channel", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.dictationStreamingAbort("dictation-2");

  assert.deepEqual(invocations, [["dictation-streaming-abort", "dictation-2"]]);
});

test("provider finalization controls forward the owning transport ID", async () => {
  const { api, invocations, sends } = loadPreloadApi();

  api.assemblyAiStreamingForceEndpoint("assembly-2");
  await api.assemblyAiStreamingStop("assembly-2");
  api.deepgramStreamingFinalize("deepgram-2");
  await api.deepgramStreamingStop("deepgram-2");
  api.cortiStreamingFinalize("corti-2");
  await api.cortiStreamingStop("corti-2");
  await api.dictationRealtimeStop("realtime-2");

  assert.deepEqual(sends, [
    ["assemblyai-streaming-force-endpoint", "assembly-2"],
    ["deepgram-streaming-finalize", "deepgram-2"],
    ["corti-streaming-finalize", "corti-2"],
  ]);
  assert.deepEqual(invocations, [
    ["assemblyai-streaming-stop", "assembly-2"],
    ["deepgram-streaming-stop", "deepgram-2"],
    ["corti-streaming-stop", "corti-2"],
    ["dictation-realtime-stop", "realtime-2"],
  ]);
});

test("history retry forwards request ownership through retry and commit", async () => {
  const { api, invocations } = loadPreloadApi();
  const settings = { transcriptionMode: "providers" };

  await api.retryTranscription(7, settings, "history-retry-1");
  await api.commitRetryTranscription(7, "history-retry-1", "final text", "raw text");

  assert.deepEqual(invocations, [
    ["retry-transcription", 7, settings, "history-retry-1"],
    ["commit-retry-transcription", 7, "history-retry-1", "final text", "raw text"],
  ]);
});

test("transcription starts forward the exact managed runtime authorization context", async () => {
  const { api, invocations } = loadPreloadApi();
  const context = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 4,
    configGeneration: 12,
    category: "transcription",
    provider: "nvidia",
    model: "nvidia-parakeet-tdt-0.6b-v3",
    managed: true,
  };
  const localOptions = { provider: "nvidia", model: context.model };
  const cloudOptions = { requestId: "upload-cloud" };
  const byokOptions = { provider: "openai", model: "whisper-1" };
  const retrySettings = { transcriptionMode: "local" };
  const meetingOptions = { provider: "local", localProvider: "nvidia" };
  const realtimeOptions = { provider: "openai-realtime", model: "gpt-realtime" };
  const previewOptions = { provider: "nvidia", model: context.model, language: "en" };

  await api.transcribeAudioFile("/audio/local.wav", localOptions, context);
  await api.transcribeAudioFileCloud("/audio/cloud.wav", cloudOptions, context);
  await api.transcribeAudioFileByok(byokOptions, context);
  await api.retryTranscription(7, retrySettings, "history-retry-2", context);
  await api.meetingTranscriptionPrepare(meetingOptions, context);
  await api.meetingTranscriptionStart(
    { ...meetingOptions, sessionId: "meeting-3", autoEndEligible: true },
    context
  );
  await api.dictationRealtimeWarmup(realtimeOptions, context);
  await api.dictationRealtimeStart(realtimeOptions, context);
  await api.startDictationPreview(previewOptions, context);
  await api.diarizeAudioFile("/audio/diarize.wav", { requestId: "diarize-1" }, context);

  assert.deepEqual(invocations, [
    ["transcribe-audio-file", "/audio/local.wav", localOptions, context],
    ["transcribe-audio-file-cloud", "/audio/cloud.wav", cloudOptions, context],
    ["transcribe-audio-file-byok", byokOptions, context],
    ["retry-transcription", 7, retrySettings, "history-retry-2", context],
    ["meeting-transcription-prepare", meetingOptions, context],
    [
      "meeting-transcription-start",
      { ...meetingOptions, sessionId: "meeting-3", autoEndEligible: true },
      context,
    ],
    ["dictation-realtime-warmup", realtimeOptions, context],
    ["dictation-realtime-start", realtimeOptions, context],
    ["start-dictation-preview", previewOptions, context],
    ["diarize-audio-file", "/audio/diarize.wav", { requestId: "diarize-1" }, context],
  ]);
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
