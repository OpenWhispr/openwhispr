const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function loadPreloadApi() {
  let exposedApi;
  const listeners = new Map();
  const invocations = [];
  const sends = [];
  const events = new EventEmitter();
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return undefined;
    },
    on: (channel, listener) => {
      events.on(channel, listener);
      listeners.set(channel, listener);
    },
    removeListener: (channel, listener) => {
      events.removeListener(channel, listener);
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

test("conversation release subscribes with a real listener and forwards only its payload", () => {
  const { api, listeners } = loadPreloadApi();
  let received;
  const unsubscribe = api.onAgentConversationReleased((payload) => (received = payload));
  const payload = { conversationId: 42 };
  listeners.get("agent-conversation-released")({ sender: {} }, payload);
  assert.equal(received, payload);
  unsubscribe();
  assert.equal(listeners.has("agent-conversation-released"), false);
});

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
  await api.deleteAccountData("account-a", 7, { erasingDevice: true });

  assert.deepEqual(invocations, [
    ["set-active-account-scope", "account-a", 7],
    // Erasing the device also revokes a Gmail grant shared with a calendar.
    ["delete-account-data", "account-a", 7, { erasingDevice: true }],
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

test("dictation lifecycle reports reach main", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.dictationLifecycleStateChanged("preparing", "take-1");

  assert.deepEqual(invocations, [["dictation-lifecycle-state-changed", "preparing", "take-1"]]);
});

test("the agent window's bridges reach their channels and strip the Electron event", async () => {
  const { api, invocations, listeners, sends } = loadPreloadApi();
  const command = { text: "hi", attachment: null, selectedContext: null };

  api.agentWindowReady();
  await api.agentWindowSetLayout({ layout: "modal", focus: true });
  await api.agentWindowHide();
  await api.agentWindowSetVoiceState("recording", "take-1");
  await api.openAgentWindow();
  await api.submitAgentCommand(command);

  assert.deepEqual(sends, [["agent-window-ready"]]);
  assert.deepEqual(invocations, [
    ["agent-window-set-layout", { layout: "modal", focus: true }],
    ["agent-window-hide"],
    ["agent-window-voice-state", "recording", "take-1"],
    ["open-agent-window"],
    ["agent-window-submit-command", command],
  ]);

  let received;
  const unsubscribe = api.onAgentWindowHotkey((payload) => (received = payload));
  listeners.get("agent-window-hotkey")({ sender: {} }, { external: true });
  assert.deepEqual(received, { external: true });
  unsubscribe();
  assert.equal(listeners.has("agent-window-hotkey"), false);
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

test("prepare-dictation calls back without the Electron event", () => {
  const { api, listeners } = loadPreloadApi();
  const received = [];
  const dispose = api.onPrepareDictation((...args) => received.push(args));

  listeners.get("prepare-dictation")?.({ senderId: 1 });

  dispose();
  assert.deepEqual(received, [[]]);
  assert.equal(listeners.has("prepare-dictation"), false);
});
