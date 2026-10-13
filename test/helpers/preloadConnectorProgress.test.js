const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// preload.js in a VM with a recording ipcRenderer, as preloadAuthBridge.test.js does.
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
    send: () => {},
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
  return { api: exposedApi, listeners, invocations };
}

test("connect progress reaches the renderer without the Electron event, until unsubscribed", () => {
  const { api, listeners } = loadPreloadApi();
  const progress = {
    connectorId: "github",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresAt: 1_790_000_000_000,
  };
  const received = [];
  const unsubscribe = api.onConnectorConnectProgress((value) => received.push(value));

  listeners.get("connector-connect-progress")?.({ sender: "ipc" }, progress);

  assert.deepEqual(received, [progress]);
  unsubscribe();
  assert.equal(listeners.has("connector-connect-progress"), false);
});

test("cancelling a connect forwards the connector id to main", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.connectorCancelConnect("github");

  assert.deepEqual(invocations, [["connector-cancel-connect", "github"]]);
});
