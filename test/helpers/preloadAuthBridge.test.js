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

test("sync writes forward the sign-in that read them and the account a chat was sent as", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.upsertTranscriptionFromCloud({ id: "t" }, 7);
  await api.upsertDictionaryFromCloud({ id: "d" }, 7);
  await api.getSnippetForCloudMerge({ id: "s" }, 7);
  await api.upsertSnippetFromCloud({ id: "s" }, 7);
  await api.hardDeleteSnippet(1, 7);
  await api.hardDeleteConversation(1, 7);
  await api.hardDeleteTranscription(1, 7);
  await api.hardDeleteDictionary(1, 7);
  await api.claimConversationFromCloud({ id: "c" }, 7);
  await api.upsertConversationFromCloud({ id: "c" }, [], null, 7);
  await api.markTranscriptionSynced(1, "t", 7);
  await api.markDictionarySynced(1, "d", "now", "word", "manual", "manual", null, 7);
  await api.markSnippetSynced(1, "s", "now", "addr", "home", 7);
  await api.acknowledgeConversationCreate(1, { title: "Chat" }, "c", "account-a", 7);
  await api.markConversationSynced(1, "c", { title: "Chat" }, "now", "account-a", 7);
  await api.replaceConversationClientId(1, "client", "account-a", 7);

  assert.deepEqual(invocations, [
    ["db-upsert-transcription-from-cloud", { id: "t" }, 7],
    ["db-upsert-dictionary-from-cloud", { id: "d" }, 7],
    ["db-get-snippet-for-cloud-merge", { id: "s" }, 7],
    ["db-upsert-snippet-from-cloud", { id: "s" }, 7],
    ["db-hard-delete-snippet", 1, 7],
    ["db-hard-delete-conversation", 1, 7],
    ["db-hard-delete-transcription", 1, 7],
    ["db-hard-delete-dictionary", 1, 7],
    ["db-claim-conversation-from-cloud", { id: "c" }, 7],
    ["db-upsert-conversation-from-cloud", { id: "c" }, [], null, 7],
    ["db-mark-transcription-synced", 1, "t", 7],
    ["db-mark-dictionary-synced", 1, "d", "now", "word", "manual", "manual", null, 7],
    ["db-mark-snippet-synced", 1, "s", "now", "addr", "home", 7],
    ["db-acknowledge-conversation-create", 1, { title: "Chat" }, "c", "account-a", 7],
    ["db-mark-conversation-synced", 1, "c", { title: "Chat" }, "now", "account-a", 7],
    ["db-replace-conversation-client-id", 1, "client", "account-a", 7],
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

test("dictionary deltas forward their account owner, including the signed-out scope", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.applyDictionaryChanges({ add: ["Word"] }, "account-a");
  await api.applyDictionaryChanges({ remove: ["Word"] }, null);

  assert.deepEqual(invocations, [
    ["db-apply-dictionary-changes", { add: ["Word"] }, "account-a"],
    ["db-apply-dictionary-changes", { remove: ["Word"] }, null],
  ]);
});

test("private-space workspace calls reach their channels", async () => {
  const { api, invocations } = loadPreloadApi();
  const scope = { activeWorkspaceId: "w2", defaultWorkspaceId: "w1", accountId: "account-a" };

  await api.setActiveWorkspaceScope(scope);
  await api.getPrivateSpaceId("w2");
  await api.getPrivateSpaceId();
  await api.bindDefaultPrivateSpace("w1", "account-a");
  await api.claimSignedOutPrivateNotes();
  await api.copyNoteToSpace(7, 3, 12);
  await api.copyNoteToSpace(7, 3);
  await api.relocatePrivateSpace("w2", null, "account-a");

  assert.deepEqual(invocations, [
    ["set-active-workspace-scope", scope],
    ["get-private-space-id", "w2"],
    ["get-private-space-id", undefined],
    ["bind-default-private-space", "w1", "account-a"],
    ["claim-signed-out-private-notes"],
    ["copy-note-to-space", 7, 3, 12],
    ["copy-note-to-space", 7, 3, undefined],
    ["relocate-private-space", "w2", null, "account-a"],
  ]);
});
