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

test("account ownership operations forward the account and credential generation", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.setActiveAccountScope("account-a", 7);
  await api.deleteAccountData("account-a", 7);

  assert.deepEqual(invocations, [
    ["set-active-account-scope", "account-a", 7],
    ["delete-account-data", "account-a", 7],
  ]);
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

test("meeting auto-end lifecycle bridges completion, overlay responses, and restart", async () => {
  const { api, invocations, listeners } = loadPreloadApi();
  const restartPayload = { sessionId: "meeting-2" };
  let receivedRestart;
  const unsubscribe = api.onMeetingAutoEndRestartRequested((request) => {
    receivedRestart = request;
  });

  await api.meetingAutoEndCompleted("meeting-2");
  await api.meetingAutoEndRespond("meeting-2", "restart");
  listeners.get("meeting-auto-end-restart-requested")?.({ sender: "ipc" }, restartPayload);

  assert.deepEqual(invocations, [
    ["meeting-auto-end-completed", "meeting-2"],
    ["meeting-auto-end-respond", "meeting-2", "restart"],
  ]);
  assert.equal(receivedRestart, restartPayload);
  unsubscribe();
  assert.equal(listeners.has("meeting-auto-end-restart-requested"), false);
});

test("assistant busy state is forwarded to the main-process hotkey guard", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.setAssistantPanelBusy(true);

  assert.deepEqual(invocations, [["set-assistant-panel-busy", true]]);
});

test("dictation lifecycle and audio levels preserve companion routing metadata", () => {
  const { api, sends } = loadPreloadApi();

  api.dictationLifecycleStateChanged("recording", "assistant");
  api.dictationAudioLevelChanged(0.42);

  assert.deepEqual(sends, [
    ["dictation-lifecycle-state-changed", "recording", "assistant"],
    ["dictation-audio-level-changed", 0.42],
  ]);
});

test("the Agent companion owns only its scoped window bridges", async () => {
  const { api, invocations, sends } = loadPreloadApi();

  await api.resizeAgentDictationPillToContent(240);
  await api.resizeAgentDictationPillToContent(null);
  await api.setAgentDictationPillInteractivity(true);
  await api.cancelAgentPanelDictation();
  api.showAgentDictationFinalTranscript("recovered text");

  assert.deepEqual(invocations, [
    ["resize-agent-dictation-pill-to-content", 240],
    ["resize-agent-dictation-pill-to-content", null],
    ["set-agent-dictation-pill-interactivity", true],
    ["cancel-agent-panel-dictation"],
  ]);
  assert.deepEqual(
    sends.filter(([channel]) => channel === "show-agent-dictation-final-transcript"),
    [["show-agent-dictation-final-transcript", "recovered text"]]
  );
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

test("enterprise reasoning cancellation is forwarded to the main process", () => {
  const { api, sends } = loadPreloadApi();

  api.cancelEnterpriseReasoning();

  assert.deepEqual(sends, [["enterprise-reasoning-cancel"]]);
});

test("cloud transcription cancellation is forwarded to the main process", () => {
  const { api, sends } = loadPreloadApi();

  api.cancelCloudTranscription();

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

test("prepare-dictation forwards the input kind without the Electron event", () => {
  const { api, listeners } = loadPreloadApi();
  const received = [];
  const dispose = api.onPrepareDictation((options) => received.push(options));

  listeners.get("prepare-dictation")?.({ senderId: 1 }, { inputKind: "assistant" });

  dispose();
  assert.deepEqual(received, [{ inputKind: "assistant" }]);
  assert.equal(listeners.has("prepare-dictation"), false);
});
