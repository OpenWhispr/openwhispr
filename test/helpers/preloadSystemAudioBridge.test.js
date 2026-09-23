const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const invocations = [];
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      invocations.push([channel, ...args]);
      return true;
    },
    on() {},
    removeListener() {},
    send() {},
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
  return { api: exposedApi, invocations };
}

// #1546: the renderer's access check and main's start plan must see the same
// System Audio Source, so the bridge has to carry it on both calls.
test("the system audio check and meeting start carry the source to main", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.checkSystemAudioAccess({ systemAudioSource: "default-device" });
  await api.checkSystemAudioAccess();
  await api.meetingTranscriptionStart({ sessionId: "s1", systemAudioSource: "default-device" });

  assert.deepEqual(invocations, [
    ["check-system-audio-access", { systemAudioSource: "default-device" }],
    ["check-system-audio-access", undefined],
    ["meeting-transcription-start", { sessionId: "s1", systemAudioSource: "default-device" }],
  ]);
});
