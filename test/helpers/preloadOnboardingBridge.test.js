const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const invocations = [];
  const sends = [];
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
    send: (channel, ...args) => sends.push([channel, ...args]),
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

test("permission guide bridge uses narrow channels and strips IPC events", async () => {
  const { api, invocations, listeners, sends } = loadPreloadApi();
  const state = { sessionId: "guide-1", permission: "accessibility" };
  await api.openPermissionGuide(state);
  await api.getPermissionGuideState();
  await api.closePermissionGuide();
  const action = { ...state, action: "check" };
  api.permissionGuideAction(action);
  api.startPermissionGuideDrag(state);
  assert.deepEqual(invocations, [
    ["permission-guide-open", state],
    ["permission-guide-state"],
    ["permission-guide-close"],
  ]);
  assert.deepEqual(sends, [
    ["permission-guide-action", action],
    ["permission-guide-drag", state],
  ]);
  let received;
  const stop = api.onPermissionGuideState((payload) => {
    received = payload;
  });
  listeners.get("permission-guide-state-changed")({ sender: "native" }, state);
  assert.equal(received, state);
  stop();
  assert.equal(api.updatePermissionGuide, undefined);
  assert.equal(listeners.has("permission-guide-state-changed"), false);
});

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

test("macOS accessibility readiness forwards an optional account scope", () => {
  const { api, sends } = loadPreloadApi();
  const expectedAccountScope = { accountId: "account-a", authGeneration: 3 };

  api.markMacAccessibilityFeaturesReady();
  api.markMacAccessibilityFeaturesReady(expectedAccountScope);

  assert.deepEqual(sends, [
    ["mac-accessibility-features-ready"],
    ["mac-accessibility-features-ready", expectedAccountScope],
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
