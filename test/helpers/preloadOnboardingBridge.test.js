const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const invocations = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      invocations.push([channel, ...args]);
      return true;
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

test("onboarding demo bridge invokes only its allowlisted channels", async () => {
  const { api, invocations } = loadPreloadApi();
  const session = { id: "demo-7", kind: "dictation" };
  const event = { kind: "dictation", status: "success", text: "Hello" };

  await api.beginOnboardingDemo(session);
  await api.publishOnboardingDemoEvent(event);
  await api.stopOnboardingDemo(session.id);
  await api.endOnboardingDemo(session.id);

  assert.deepEqual(invocations, [
    ["onboarding-demo-begin", session],
    ["onboarding-demo-publish", event],
    ["onboarding-demo-stop", session.id],
    ["onboarding-demo-end", session.id],
  ]);
});

test("onboarding active bridge invokes only its allowlisted channel", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.setOnboardingActive(true);
  await api.setOnboardingActive(false);

  assert.deepEqual(invocations, [
    ["onboarding-set-active", true],
    ["onboarding-set-active", false],
  ]);
});

test("onboarding demo listener strips the Electron event and disposes cleanly", () => {
  const { api, listeners } = loadPreloadApi();
  const payload = {
    demoId: "demo-7",
    kind: "dictation",
    status: "partial",
    text: "Hello",
  };
  let received;
  const unsubscribe = api.onOnboardingDemoEvent((event) => {
    received = event;
  });

  listeners.get("onboarding-demo-event")?.({ sender: "ipc" }, payload);

  assert.equal(received, payload);
  unsubscribe();
  assert.equal(listeners.has("onboarding-demo-event"), false);
});
