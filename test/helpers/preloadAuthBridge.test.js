const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const listeners = new Map();
  const invocations = [];
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return undefined;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: () => undefined,
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
  return { api: exposedApi, invocations, listeners };
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
