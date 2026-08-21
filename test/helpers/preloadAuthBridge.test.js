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
