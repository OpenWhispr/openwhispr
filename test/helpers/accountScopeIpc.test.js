const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Registers the real handler closures against a fake `this` (the scaffolding
// from windowIpcSenders.test.js) with the bearer state under test control
// and the binding file in a temporary userData directory, so the scope
// handlers run against the real accountScopeBinding.
const handlers = new Map();
const eventHandlers = new Map();
const broadcasts = [];
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-scope-ipc-"));
let tokenState = { token: null, generation: 0 };

const electronStub = {
  app: {
    getPath: () => userDataDirectory,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => eventHandlers.set(channel, fn),
    removeHandler: () => {},
  },
  net: {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { managed: false, policy: null, policyUpdatedAt: null } }),
      text: async () => "{}",
    }),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "electron-updater") return { autoUpdater: {} };
  if (parent?.filename === handlersModulePath) {
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        clear: () => {
          tokenState = { token: null, generation: tokenState.generation + 1 };
          handleAuthTokenChange(tokenState);
          return { success: true, ...tokenState };
        },
        subscribe: () => () => {},
      };
    }
    if (request === "./windowBroadcast") {
      return {
        broadcastToWindows: (channel, data) => {
          if (channel !== "effective-policy-changed") broadcasts.push([channel, data]);
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

// Each call with the binding file as it stood then: a connect must be stopped
// only once the scope it ran under is gone.
const connectorCalls = [];
const connectorManager = {
  accountChanged: () => connectorCalls.push(["accountChanged", readBinding()?.accountId ?? null]),
  notifyStatusChanged: async () => connectorCalls.push(["notifyStatusChanged"]),
};

function readBinding() {
  return require("../../src/helpers/accountScopeBinding").read();
}

const databaseScopes = [];
const databaseManager = new Proxy(
  {
    activeAccountId: null,
    setActiveAccountId(accountId) {
      this.activeAccountId = accountId;
      databaseScopes.push(accountId);
    },
  },
  { get: (value, property) => (property in value ? value[property] : anything()) }
);

function buildFakeThis() {
  const target = {
    sessionId: "test-session",
    windowManager: new Proxy(
      { controlPanelWindow: null, mainWindow: null },
      { get: (value, property) => (property in value ? value[property] : anything()) }
    ),
    connectorManager,
    databaseManager,
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
    _activeEnterpriseAudioMeeting: false,
  };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

let fakeThis;
let handleAuthTokenChange;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis = buildFakeThis();
  Ctor.prototype.setupHandlers.call(withDevicePolicy(fakeThis));
  handleAuthTokenChange = (state) => {
    tokenState = { ...state };
    return Ctor.prototype._handleAuthTokenChange.call(fakeThis, state);
  };
});

test.after(() => {
  fakeThis.metaActivation?.dispose?.();
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

const getScope = () => handlers.get("get-active-account-scope")();
const setScope = (accountId, generation) =>
  handlers.get("set-active-account-scope")({}, accountId, generation);

test("no scope is readable before a session has been validated", async () => {
  tokenState = { token: "token-a", generation: 1 };
  assert.equal(await getScope(), null);
});

test("a validated scope is readable back and broadcast to every window", async () => {
  tokenState = { token: "token-a", generation: 1 };
  broadcasts.length = 0;
  assert.deepEqual(await setScope("account-a", 1), { success: true });
  assert.deepEqual(await getScope(), { accountId: "account-a", authGeneration: 1 });
  assert.deepEqual(broadcasts, [
    ["active-account-scope-changed", { accountId: "account-a", authGeneration: 1 }],
  ]);
});

test("a rotated bearer hides the scope until the session is validated again", async () => {
  tokenState = { token: "token-b", generation: 2 };
  assert.equal(await getScope(), null);
  await setScope("account-a", 2);
  assert.deepEqual(await getScope(), { accountId: "account-a", authGeneration: 2 });
});

test("a rejected scope request changes nothing and broadcasts nothing", async () => {
  tokenState = { token: "token-b", generation: 3 };
  broadcasts.length = 0;
  const result = await setScope("account-b", 2);
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.deepEqual(broadcasts, []);
});

test("a validated sign-out clears the scope and broadcasts the clearing", async () => {
  tokenState = { token: null, generation: 4 };
  broadcasts.length = 0;
  assert.deepEqual(await setScope(null, 4), { success: true });
  assert.equal(await getScope(), null);
  assert.deepEqual(broadcasts, [["active-account-scope-changed", null]]);
});

test("a scope change stops connects another account started, after the scope moves", async () => {
  tokenState = { token: "token-c", generation: 5 };
  connectorCalls.length = 0;
  await setScope("account-c", 5);
  await setScope(null, 5);
  assert.deepEqual(connectorCalls, [
    ["accountChanged", "account-c"],
    ["notifyStatusChanged"],
    ["accountChanged", null],
    ["notifyStatusChanged"],
  ]);
});

test("a sign-out in main stops connects without waiting for the renderer", async () => {
  tokenState = { token: "token-d", generation: 6 };
  await setScope("account-d", 6);
  connectorCalls.length = 0;

  // A rotated token isn't another account: connects keep running.
  handleAuthTokenChange({ generation: 7, token: "token-e" });
  assert.deepEqual(connectorCalls, [["notifyStatusChanged"]]);

  connectorCalls.length = 0;
  databaseScopes.length = 0;
  broadcasts.length = 0;
  handleAuthTokenChange({ generation: 8, token: null });
  assert.deepEqual(connectorCalls, [["accountChanged", null], ["notifyStatusChanged"]]);
  assert.equal(readBinding(), null);
  assert.deepEqual(databaseScopes, [null]);
  assert.deepEqual(broadcasts, [
    ["active-account-scope-changed", null],
    ["auth-token-state-changed", { generation: 8, hasToken: false }],
  ]);
});

test("meeting prompt retirement precedes scope mutation and skips a true no-op", async () => {
  tokenState = { token: "meeting-test-token", generation: 20 };
  const originalManager = fakeThis.windowManager;
  const calls = [];
  fakeThis.windowManager = {
    retireMeetingNotificationScope: () => calls.push(databaseManager.activeAccountId),
  };
  databaseManager.activeAccountId = "old-account";
  await setScope("meeting-account", 20);
  assert.deepEqual(calls, ["old-account"]);
  databaseManager.activeAccountId = "meeting-account";
  await setScope("meeting-account", 20);
  assert.deepEqual(calls, ["old-account"]);
  handleAuthTokenChange({ token: "rotated", generation: 21 });
  assert.deepEqual(calls, ["old-account", "meeting-account"]);
  handleAuthTokenChange({ token: null, generation: 22 });
  assert.deepEqual(calls, ["old-account", "meeting-account", "meeting-account"]);
  fakeThis.windowManager = originalManager;
});

test("a sign-out or account switch stops the meeting as an account change, not a policy refusal", async (t) => {
  const originalStop = fakeThis._stopMeetingForPolicy;
  const reasons = [];
  fakeThis._stopMeetingForPolicy = (reason) => reasons.push(reason);
  t.after(() => {
    fakeThis._stopMeetingForPolicy = originalStop;
  });
  tokenState = { token: "switch-token", generation: 40 };
  databaseManager.activeAccountId = "first-account";
  await setScope("second-account", 40);
  handleAuthTokenChange({ token: "rotated", generation: 41 });
  handleAuthTokenChange({ token: null, generation: 42 });
  assert.deepEqual(reasons, ["accountChanged", "accountChanged"]);
});

test("activation storage failure cannot prevent clearing the local bearer", async () => {
  const manager = fakeThis.metaActivation;
  fakeThis.metaActivation = {
    close: async () => {
      throw new Error("disk full");
    },
  };
  tokenState = { token: "must-clear", generation: 30 };
  try {
    const result = await handlers.get("auth-clear-session")({ sender: {} });
    assert.equal(result.success, true);
    assert.equal(tokenState.token, null);
    assert.equal(tokenState.generation, 31);
  } finally {
    fakeThis.metaActivation = manager;
  }
});

// Restores what an updater test changes on the fake handler `this`.
function restoreUpdaterState(t) {
  const previous = {
    updateManager: fakeThis.updateManager,
    databaseManager: fakeThis.databaseManager,
    windowManager: fakeThis.windowManager,
    metaActivation: fakeThis.metaActivation,
  };
  const previousTokenState = tokenState;
  t.after(() => {
    fakeThis.updateManager.cleanup();
    Object.assign(fakeThis, previous);
    tokenState = previousTokenState;
  });
}

function scopedDatabase(activeAccountId) {
  return new Proxy(
    {
      activeAccountId,
      setActiveAccountId(accountId) {
        this.activeAccountId = accountId;
      },
    },
    { get: (value, property) => (property in value ? value[property] : anything()) }
  );
}

// Development mode keeps electron-updater out; the policy runs for real.
function createUpdater() {
  const previousEnvironment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const UpdateManager = require("../../src/updater");
    return new UpdateManager({ getPolicy: (options) => fakeThis.getUpdatePolicy(options) });
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
}

const TEST_API_URL = "https://api.openwhispr.test";

function useTestApi(t) {
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = TEST_API_URL;
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });
}

function managedPolicy(mode) {
  return {
    managed: true,
    policy: {
      version: 1,
      transcription: { allowedModes: [], allowedByokProviders: [] },
      llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
      features: { agentEnabled: false, webSearchEnabled: false },
      sharing: { externalLinkSharing: "disabled" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: false,
      },
      minAppVersion: null,
      updates: { mode },
    },
    policyUpdatedAt: "2026-11-03T00:00:00.000Z",
  };
}

// The verdict an earlier run left on disk for this bearer.
function cachePolicyForBearer(token, data) {
  const crypto = require("node:crypto");
  const { writeWorkspacePolicyCache } = require("../../src/helpers/workspacePolicyCache");
  const credentialHash = crypto
    .createHash("sha256")
    .update(JSON.stringify([["Authorization", `Bearer ${token}`]]))
    .digest("hex");
  writeWorkspacePolicyCache(
    path.join(userDataDirectory, "workspace-policy.json"),
    { apiOrigin: TEST_API_URL, credentialHash, accountId: null },
    data
  );
}

async function signOutUpdater(t, generation) {
  restoreUpdaterState(t);
  tokenState = { token: `sign-out-token-${generation}`, generation };
  fakeThis.databaseManager = scopedDatabase("departing-account");
  const win = {
    isDestroyed: () => false,
    webContents: { session: { cookies: { get: async () => [] } } },
  };
  fakeThis.windowManager = { controlPanelWindow: win, retireMeetingNotificationScope() {} };
  await setScope("departing-account", generation);
  fakeThis.metaActivation = { close: async () => {} };
  fakeThis.updateManager = createUpdater();
  fakeThis.updateManager.updatePolicy({
    success: true,
    managed: true,
    policy: { updates: { mode: "it_managed" } },
  });
  return { manager: fakeThis.updateManager, win };
}

test("local sign-out restores guest updater readiness without a server or renderer response", async (t) => {
  const { manager } = await signOutUpdater(t, 100);
  let requests = 0;
  t.mock.method(electronStub.net, "fetch", async () => {
    requests++;
    throw new Error("offline");
  });
  const result = await handlers.get("auth-clear-session")({ sender: {} });
  await new Promise(setImmediate);

  assert.equal(result.success, true);
  assert.equal(readBinding(), null);
  assert.equal(fakeThis.databaseManager.activeAccountId, null);
  assert.equal((await manager.getUpdateStatus()).policyReady, true);
  assert.equal((await manager.getUpdateStatus()).updateMode, "user_choice");
  assert.equal(requests, 0);
});

test("completed cookie sign-out discards a pending cookie-authorized updater policy", async (t) => {
  const { deferred } = require("./harness/deferred");
  const { manager, win } = await signOutUpdater(t, 102);
  tokenState = { token: null, generation: 102 };
  const clearing = deferred();
  const cleared = deferred();
  const requested = deferred();
  const reply = deferred();
  let cookie = "departing-cookie";
  win.webContents.session.cookies.get = async () =>
    cookie ? [{ name: "__Secure-openwhispr.session_token", value: cookie }] : [];
  win.webContents.session.clearStorageData = async (options) => {
    assert.deepEqual(options, { storages: ["cookies"] });
    clearing.resolve();
    await cleared.promise;
    cookie = null;
  };
  t.mock.method(electronStub.BrowserWindow, "fromWebContents", () => win);
  t.mock.method(electronStub.net, "fetch", async (_url, init) => {
    assert.equal(init.headers.Cookie, "__Secure-openwhispr.session_token=departing-cookie");
    requested.resolve();
    return reply.promise;
  });
  useTestApi(t);
  const response = {
    ok: true,
    status: 200,
    json: async () => ({ data: managedPolicy("it_managed") }),
  };
  t.after(() => {
    cleared.resolve();
    reply.resolve(response);
  });
  broadcasts.length = 0;
  const signOut = handlers.get("auth-clear-session")({ sender: {} });
  await clearing.promise;
  const policy = manager.refreshPolicy();
  await requested.promise;
  cleared.resolve();
  assert.equal((await signOut).success, true);
  await new Promise(setImmediate);
  assert.equal((await manager.getUpdateStatus()).policyReady, true);
  assert.equal((await manager.getUpdateStatus()).updateMode, "user_choice");

  reply.resolve(response);
  await policy;
  assert.equal((await manager.getUpdateStatus()).policyReady, true);
  assert.equal((await manager.getUpdateStatus()).updateMode, "user_choice");
});

test("a bearer the API refuses with nothing held updates as a guest, while a held IT verdict stands", async (t) => {
  restoreUpdaterState(t);
  useTestApi(t);
  let refusals = 0;
  t.mock.method(electronStub.net, "fetch", async () => {
    refusals++;
    return { ok: false, status: 401, json: async () => ({}) };
  });
  // A 401 leaves the renderer's account scope in place. Seeded directly, as
  // set-active-account-scope's own policy lookups would throttle the updater's.
  tokenState = { token: "expired-bearer", generation: 110 };
  fakeThis.databaseManager = scopedDatabase("expired-account");
  fakeThis.windowManager = { retireMeetingNotificationScope() {} };
  require("../../src/helpers/accountScopeBinding").persist("expired-account", "expired-bearer");
  fakeThis.updateManager = createUpdater();
  await fakeThis.updateManager.refreshPolicy();
  let status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, true);
  assert.equal(status.updateMode, "user_choice");

  cachePolicyForBearer("expired-managed-bearer", managedPolicy("it_managed"));
  tokenState = { token: "expired-managed-bearer", generation: 111 };
  fakeThis.updateManager.invalidatePolicy();
  const refusalsBefore = refusals;
  await fakeThis.updateManager.refreshPolicy();
  await new Promise(setImmediate);
  assert.equal(refusals, refusalsBefore + 1);
  status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.updateMode, "it_managed");
});

test("a refused bearer the server called unresolvable stays fail-closed, not a guest", async (t) => {
  restoreUpdaterState(t);
  useTestApi(t);
  t.mock.method(electronStub.net, "fetch", async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
  }));
  // The fail-closed marker an earlier POLICY_UNRESOLVABLE left on disk.
  cachePolicyForBearer("unresolved-bearer", {
    managed: false,
    policy: null,
    policyUpdatedAt: null,
    requiresManagedPolicy: true,
  });
  tokenState = { token: "unresolved-bearer", generation: 115 };
  fakeThis.databaseManager = scopedDatabase(null);
  fakeThis.windowManager = { retireMeetingNotificationScope() {} };
  fakeThis.updateManager = createUpdater();
  await fakeThis.updateManager.refreshPolicy();
  const status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, false);
  assert.equal(status.updateMode, null);
});

test("under a device policy, an outage with nothing held leaves updates unavailable once it fails", async (t) => {
  const {
    defaultDevicePolicy,
    normalizeDeviceValues,
  } = require("../../src/helpers/managedDevicePolicy");
  restoreUpdaterState(t);
  useTestApi(t);
  const deviceSnapshot = fakeThis.managedDevicePolicy.getSnapshot;
  const device = normalizeDeviceValues({ Policy: JSON.stringify(defaultDevicePolicy()) });
  fakeThis.managedDevicePolicy.getSnapshot = () => device;
  t.after(() => {
    fakeThis.managedDevicePolicy.getSnapshot = deviceSnapshot;
  });
  let goOffline;
  t.mock.method(
    electronStub.net,
    "fetch",
    () => new Promise((_resolve, reject) => (goOffline = reject))
  );
  tokenState = { token: "device-managed-bearer", generation: 117 };
  fakeThis.databaseManager = scopedDatabase(null);
  fakeThis.windowManager = { retireMeetingNotificationScope() {} };
  fakeThis.updateManager = createUpdater();
  const lookup = fakeThis.updateManager.refreshPolicy();
  await new Promise(setImmediate);
  // A verdict still on its way is pending, not unavailable.
  let status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, false);
  assert.equal(status.policyUnavailable, false);

  goOffline(new Error("offline"));
  await lookup;
  status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, false);
  assert.equal(status.policyUnavailable, true);
  assert.equal(status.updateMode, null);
});

test("a stray cookie leaves a signed-out member a guest without reaching the API", async (t) => {
  restoreUpdaterState(t);
  useTestApi(t);
  const requests = [];
  t.mock.method(electronStub.net, "fetch", async (_url, init) => {
    requests.push(init.headers);
    throw new Error("offline");
  });
  tokenState = { token: null, generation: 120 };
  fakeThis.databaseManager = scopedDatabase(null);
  fakeThis.windowManager = {
    controlPanelWindow: {
      isDestroyed: () => false,
      webContents: {
        session: { cookies: { get: async () => [{ name: "_ga", value: "GA1.1.123" }] } },
      },
    },
    retireMeetingNotificationScope() {},
  };
  fakeThis.updateManager = createUpdater();
  await fakeThis.updateManager.refreshPolicy();
  const status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, true);
  assert.equal(status.updateMode, "user_choice");
  assert.deepEqual(requests, []);
});

test("a stray cookie never reaches the API for an account with no session to send", async (t) => {
  restoreUpdaterState(t);
  useTestApi(t);
  const requests = [];
  t.mock.method(electronStub.net, "fetch", async (_url, init) => {
    requests.push(init.headers);
    throw new Error("offline");
  });
  tokenState = { token: null, generation: 125 };
  fakeThis.databaseManager = scopedDatabase("stray-cookie-account");
  fakeThis.windowManager = {
    controlPanelWindow: {
      isDestroyed: () => false,
      webContents: {
        session: { cookies: { get: async () => [{ name: "_ga", value: "GA1.1.123" }] } },
      },
    },
    retireMeetingNotificationScope() {},
  };
  fakeThis.updateManager = createUpdater();
  await fakeThis.updateManager.refreshPolicy();
  assert.deepEqual(requests, []);
});

test("an offline restart adopts the cached verdict without waiting for the network", async (t) => {
  restoreUpdaterState(t);
  useTestApi(t);
  let goOffline;
  t.mock.method(
    electronStub.net,
    "fetch",
    () => new Promise((_resolve, reject) => (goOffline = reject))
  );
  t.after(() => goOffline?.(new Error("offline")));
  cachePolicyForBearer("restarted-bearer", managedPolicy("always_on"));
  tokenState = { token: "restarted-bearer", generation: 130 };
  fakeThis.databaseManager = scopedDatabase(null);
  fakeThis.windowManager = { retireMeetingNotificationScope() {} };
  fakeThis.updateManager = createUpdater();
  await Promise.race([fakeThis.updateManager.refreshPolicy(), new Promise(setImmediate)]);
  const status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, true);
  assert.equal(status.updateMode, "always_on");
});

test("a relaunch with a staged macOS update restarts into it whatever the update policy", async (t) => {
  restoreUpdaterState(t);
  const calls = [];
  fakeThis.updateManager = {
    hasStagedUpdate: () => true,
    restartIntoStagedUpdate: async () => {
      calls.push("restart");
      return { success: true };
    },
    installUpdate: async () => ({ success: false, code: "UPDATES_MANAGED_BY_ORG" }),
    deferInstallOnQuit: () => calls.push("defer"),
    cleanup() {},
  };
  Object.assign(electronStub.app, {
    quit: () => calls.push("quit"),
    relaunch: () => calls.push("relaunch"),
  });
  t.after(() => {
    delete electronStub.app.quit;
    delete electronStub.app.relaunch;
  });
  await handlers.get("relaunch-app")();
  assert.deepEqual(calls, ["restart"]);
});

test("cookie storage failure still clears the local bearer and reports the failure", async (t) => {
  const { win } = await signOutUpdater(t, 104);
  win.webContents.session.clearStorageData = async () => {
    throw new Error("cookie storage unavailable");
  };
  t.mock.method(electronStub.BrowserWindow, "fromWebContents", () => win);
  const result = await handlers.get("auth-clear-session")({ sender: {} });

  assert.deepEqual(result, { success: false, error: "cookie storage unavailable" });
  assert.deepEqual(tokenState, { token: null, generation: 105 });
  assert.equal(readBinding(), null);
  assert.equal(fakeThis.databaseManager.activeAccountId, null);
});

test("signed-out transitions restore guest meeting detection without granting a replacement bearer guest permissions", async (t) => {
  const { createAudioFeaturePolicy } = require("../../src/helpers/audioFeaturePolicy");
  const originalManager = fakeThis.windowManager;
  const originalEngine = fakeThis.meetingDetectionEngine;
  const originalPolicy = fakeThis._audioFeaturePolicy;
  const originalAccount = databaseManager.activeAccountId;
  const originalTokenState = tokenState;
  t.after(() => {
    fakeThis.windowManager = originalManager;
    fakeThis.meetingDetectionEngine = originalEngine;
    fakeThis._audioFeaturePolicy = originalPolicy;
    databaseManager.activeAccountId = originalAccount;
    tokenState = originalTokenState;
  });
  const applied = [];
  fakeThis.windowManager = { notificationPrefs: {}, retireMeetingNotificationScope() {} };
  fakeThis.meetingDetectionEngine = { setPreferences: (prefs) => applied.push(prefs) };
  fakeThis._audioFeaturePolicy = createAudioFeaturePolicy({
    getPolicy: async () => ({ success: false }),
    onChange: () => fakeThis._syncMeetingDetectorPolicy(),
  });
  fakeThis._audioFeaturePolicy.update({
    success: true,
    managed: true,
    policy: { features: { meetingRecordingEnabled: false } },
  });
  await handlers.get("sync-notification-preferences")(
    {},
    {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      meetingProcessDetection: true,
    }
  );
  assert.deepEqual(applied.at(-1), { audioDetection: false, processDetection: false });

  tokenState = { token: null, generation: 40 };
  handleAuthTokenChange(tokenState);
  assert.equal(fakeThis._audioFeaturePolicy.failure("meeting"), null);
  assert.deepEqual(applied.at(-1), { audioDetection: true, processDetection: true });

  tokenState = { token: "replacement-bearer", generation: 41 };
  handleAuthTokenChange(tokenState);
  assert.equal(fakeThis._audioFeaturePolicy.failure("meeting").code, "POLICY_UNRESOLVABLE");
  await setScope(null, 41);
  assert.equal(fakeThis._audioFeaturePolicy.failure("meeting").code, "POLICY_UNRESOLVABLE");

  tokenState = { token: null, generation: 42 };
  databaseManager.activeAccountId = "departing-account";
  await setScope(null, 42);
  assert.equal(fakeThis._audioFeaturePolicy.failure("meeting"), null);
  assert.deepEqual(applied.at(-1), { audioDetection: true, processDetection: true });
});

test("senderless audio policy uses the current bearer or a live app window's cookies, while renderer auth stays scoped", async (t) => {
  const originalManager = fakeThis.windowManager;
  const originalAccount = databaseManager.activeAccountId;
  const originalTokenState = tokenState;
  const originalApiUrl = process.env.OPENWHISPR_API_URL;
  t.after(() => {
    fakeThis.windowManager = originalManager;
    databaseManager.activeAccountId = originalAccount;
    tokenState = originalTokenState;
    if (originalApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = originalApiUrl;
  });
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  const requests = [];
  t.mock.method(electronStub.net, "fetch", async (_url, init) => {
    requests.push(init.headers);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { managed: false, policy: null, policyUpdatedAt: null } }),
    };
  });
  const windowWithCookie = (value, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: {
      session: {
        cookies: { get: async () => (value ? [{ name: "openwhispr.session_token", value }] : []) },
      },
    },
  });
  const renderer = windowWithCookie("renderer-session");
  t.mock.method(electronStub.BrowserWindow, "fromWebContents", () => renderer);
  for (const [token, controlPanel, main, event, expected] of [
    ["cli-bearer", null, null, {}, { Authorization: "Bearer cli-bearer" }],
    [
      null,
      windowWithCookie("control-session"),
      null,
      {},
      { Cookie: "openwhispr.session_token=control-session" },
    ],
    [
      null,
      windowWithCookie("stale", true),
      windowWithCookie("main-session"),
      {},
      { Cookie: "openwhispr.session_token=main-session" },
    ],
    [
      null,
      windowWithCookie("control-session"),
      null,
      { sender: {} },
      { Cookie: "openwhispr.session_token=renderer-session" },
    ],
    [null, windowWithCookie(""), null, {}, null],
  ]) {
    tokenState = { token, generation: tokenState.generation + 1 };
    databaseManager.activeAccountId = expected ? "cli-account" : null;
    fakeThis.windowManager = { controlPanelWindow: controlPanel, mainWindow: main };
    const before = requests.length;
    assert.deepEqual(
      await fakeThis._audioFeaturePolicy.run(event, "upload", () => ({ success: true })),
      { success: true }
    );
    // With a verdict already held, the lookup runs behind the answer.
    for (let turn = 0; expected && turn < 50 && requests.length === before; turn++) {
      await new Promise(setImmediate);
    }
    assert.equal(requests.length - before, expected ? 1 : 0);
    if (expected) {
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(requests.at(-1)[key], value);
      }
    }
  }
});

test("a token rotation keeps the account's running jobs and meeting; another account ends them", async (t) => {
  const { createAudioFeaturePolicy } = require("../../src/helpers/audioFeaturePolicy");
  const { deferred } = require("./harness/deferred");
  const originalPolicy = fakeThis._audioFeaturePolicy;
  const originalRefresh = fakeThis.refreshEffectivePolicy;
  const originalStop = fakeThis._stopMeetingForPolicy;
  const originalAccount = databaseManager.activeAccountId;
  const originalTokenState = tokenState;
  t.after(() => {
    fakeThis._audioFeaturePolicy = originalPolicy;
    fakeThis.refreshEffectivePolicy = originalRefresh;
    fakeThis._stopMeetingForPolicy = originalStop;
    databaseManager.activeAccountId = originalAccount;
    tokenState = originalTokenState;
  });
  const allowed = { success: true, managed: true, policy: { features: {} } };
  const stops = [];
  fakeThis._stopMeetingForPolicy = (reason) => stops.push(reason);

  for (const [nextAccount, accountChanged] of [
    ["rotation-account", false],
    ["other-account", true],
  ]) {
    stops.length = 0;
    let lookup = deferred();
    fakeThis.refreshEffectivePolicy = () => lookup.promise;
    fakeThis._audioFeaturePolicy = createAudioFeaturePolicy({ getPolicy: () => lookup.promise });
    tokenState = { token: "rotation-token-a", generation: 60 };
    databaseManager.activeAccountId = "rotation-account";
    await setScope("rotation-account", 60);
    fakeThis._audioFeaturePolicy.update(allowed);

    const entered = deferred();
    const finish = deferred();
    const upload = fakeThis._audioFeaturePolicy.run({}, "upload", async () => {
      entered.resolve();
      await finish.promise;
      return { success: true };
    });
    await entered.promise;
    lookup = deferred();

    tokenState = { token: "rotation-token-b", generation: 61 };
    handleAuthTokenChange(tokenState);
    await setScope(nextAccount, 61);
    // The same account's live meeting keeps transcribing until the new verdict
    // arrives; nothing keeps the previous account's verdict.
    assert.equal(
      fakeThis._audioFeaturePolicy.activeFailure("meeting")?.code ?? null,
      accountChanged ? "POLICY_UNRESOLVABLE" : null
    );
    assert.equal(fakeThis._audioFeaturePolicy.failure("meeting").code, "POLICY_UNRESOLVABLE");
    finish.resolve();

    assert.deepEqual(stops, accountChanged ? ["accountChanged"] : []);
    assert.equal((await upload).success, !accountChanged);
    lookup.resolve(allowed);
    await new Promise(setImmediate);
    assert.equal(fakeThis._audioFeaturePolicy.failure("meeting"), null);
  }
});

for (const outcome of [
  "allowed",
  "revoked",
  "revoked then restored",
  "signed out",
  "account switched",
]) {
  test(`dictation finishing during token rotation: ${outcome}`, async (t) => {
    const { deferred } = require("./harness/deferred");
    const IPCHandlers = require(handlersModulePath);
    const previous = {
      whisperManager: fakeThis.whisperManager,
      refreshEffectivePolicy: fakeThis.refreshEffectivePolicy,
      _stopRemoteProductWork: fakeThis._stopRemoteProductWork,
      _retireDisallowedProductWork: fakeThis._retireDisallowedProductWork,
      _stopMeetingForPolicy: fakeThis._stopMeetingForPolicy,
      _meetingMicStreaming: fakeThis._meetingMicStreaming,
    };
    const previousTokenState = tokenState;
    const previousAccount = databaseManager.activeAccountId;
    const previousApiUrl = process.env.OPENWHISPR_API_URL;
    const entered = deferred();
    const finish = deferred();
    const refreshed = deferred();
    let pending;
    t.after(async () => {
      finish.resolve({ success: true, text: "completed dictation" });
      refreshed.resolve();
      await pending;
      Object.assign(fakeThis, previous);
      tokenState = previousTokenState;
      databaseManager.activeAccountId = previousAccount;
      if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
      else process.env.OPENWHISPR_API_URL = previousApiUrl;
      await fakeThis.refreshEffectivePolicy();
    });

    process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
    const generation = tokenState.generation + 1;
    tokenState = { token: `completion-token-${generation}`, generation };
    await setScope("completion-account", generation);
    await fakeThis.refreshEffectivePolicy();
    fakeThis.refreshEffectivePolicy = () => refreshed.promise;
    fakeThis._stopRemoteProductWork = IPCHandlers.prototype._stopRemoteProductWork.bind(fakeThis);
    fakeThis._retireDisallowedProductWork =
      IPCHandlers.prototype._retireDisallowedProductWork.bind(fakeThis);
    const stops = [];
    fakeThis._stopMeetingForPolicy = (reason) => {
      stops.push(reason);
      fakeThis._meetingMicStreaming = null;
    };
    const meeting = { disconnect: async () => {} };
    fakeThis._meetingMicStreaming = meeting;
    fakeThis.whisperManager = {
      transcribeLocalWhisper: async () => {
        entered.resolve();
        return finish.promise;
      },
    };
    pending = handlers.get("transcribe-local-whisper")({ sender: {} }, new Uint8Array([1]));
    await entered.promise;
    handleAuthTokenChange({
      token: `completion-token-${generation + 1}`,
      generation: generation + 1,
    });
    await setScope("completion-account", generation + 1);
    finish.resolve({ success: true, text: "completed dictation" });
    await new Promise(setImmediate);
    assert.deepEqual(stops, []);
    assert.equal(fakeThis._meetingMicStreaming, meeting);

    if (outcome === "signed out") {
      handleAuthTokenChange({ token: null, generation: generation + 2 });
    } else {
      if (outcome === "account switched") {
        await setScope("replacement-account", generation + 1);
        fakeThis._meetingMicStreaming = meeting;
      }
      const snapshot = {
        success: true,
        managed: false,
        accountId: databaseManager.activeAccountId,
        authGeneration: generation + 1,
      };
      if (outcome.startsWith("revoked")) {
        const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
        policy.transcription.allowedModes = ["providers"];
        fakeThis.effectivePolicyManager.updateWorkspace({ ...snapshot, managed: true, policy });
      }
      if (outcome !== "revoked") fakeThis.effectivePolicyManager.updateWorkspace(snapshot);
    }
    refreshed.resolve();
    const result = await pending;
    if (outcome === "allowed") assert.equal(result.text, "completed dictation");
    else
      assert.equal(
        result.code,
        ["signed out", "account switched"].includes(outcome)
          ? "AUTH_CONTEXT_CHANGED"
          : "DEVICE_POLICY_BLOCKED"
      );
    assert.deepEqual(
      stops,
      ["signed out", "account switched"].includes(outcome) ? ["accountChanged"] : []
    );
    if (outcome === "allowed" || outcome === "account switched")
      assert.equal(fakeThis._meetingMicStreaming, meeting);
  });
}

for (const provider of ["whisper", "parakeet"]) {
  for (const outcome of [
    "permitted",
    "denied",
    "pending permitted",
    "pending denied",
    "second account",
    "sign-out",
  ]) {
    test(`guest local dictation follows its first account: ${provider}, ${outcome}`, async (t) => {
      const { deferred } = require("./harness/deferred");
      const IPCHandlers = require(handlersModulePath);
      const entered = deferred(),
        finish = deferred(),
        policyReady = deferred();
      const previous = {
        whisperManager: Object.getOwnPropertyDescriptor(fakeThis, "whisperManager"),
        parakeetManager: Object.getOwnPropertyDescriptor(fakeThis, "parakeetManager"),
        retire: fakeThis._retireDisallowedProductWork,
        tokenState,
        account: databaseManager.activeAccountId,
      };
      const apiUrl = process.env.OPENWHISPR_API_URL;
      process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
      let pending;
      t.after(async () => {
        finish.resolve({ success: true, text: "guest dictation" });
        policyReady.resolve();
        await pending;
        for (const property of ["whisperManager", "parakeetManager"])
          if (previous[property]) Object.defineProperty(fakeThis, property, previous[property]);
          else delete fakeThis[property];
        fakeThis._retireDisallowedProductWork = previous.retire;
        tokenState = previous.tokenState;
        databaseManager.activeAccountId = previous.account;
        if (apiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
        else process.env.OPENWHISPR_API_URL = apiUrl;
        await fakeThis.refreshEffectivePolicy();
      });
      const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
      if (outcome.includes("denied")) policy.transcription.allowedModes = ["providers"];
      t.mock.method(electronStub.net, "fetch", async (url) => {
        assert.ok(url.endsWith("/api/workspace-policy"));
        if (outcome.startsWith("pending")) await policyReady.promise;
        return Response.json({
          data: { managed: true, policy, policyUpdatedAt: "2026-11-12T00:00:00.000Z" },
        });
      });
      const generation = tokenState.generation + 1;
      handleAuthTokenChange({ token: null, generation });
      await fakeThis.refreshEffectivePolicy();
      fakeThis._retireDisallowedProductWork =
        IPCHandlers.prototype._retireDisallowedProductWork.bind(fakeThis);
      let decoderSignal;
      fakeThis[`${provider}Manager`] = {
        [`transcribeLocal${provider === "whisper" ? "Whisper" : "Parakeet"}`]: async (
          _audio,
          { signal }
        ) => {
          decoderSignal = signal;
          entered.resolve();
          return finish.promise;
        },
      };
      pending = handlers.get(`transcribe-local-${provider}`)({ sender: {} }, new Uint8Array([1]));
      await entered.promise;
      const accountId = `first-${provider}-${outcome}`;
      handleAuthTokenChange({ token: `token-${accountId}`, generation: generation + 1 });
      await setScope(accountId, generation + 1);
      if (!outcome.startsWith("pending")) await fakeThis.refreshEffectivePolicy();
      if (outcome === "second account") {
        handleAuthTokenChange({ token: `second-${accountId}`, generation: generation + 2 });
        await setScope(`second-${accountId}`, generation + 2);
        await fakeThis.refreshEffectivePolicy();
      } else if (outcome === "sign-out") {
        handleAuthTokenChange({ token: null, generation: generation + 2 });
        await fakeThis.refreshEffectivePolicy();
      }
      finish.resolve({ success: true, text: "guest dictation" });
      if (outcome.startsWith("pending")) {
        let result;
        void pending.then((value) => (result = value));
        await new Promise(setImmediate);
        assert.equal(result, undefined, "the new account's verdict must decide completion");
        policyReady.resolve();
      }
      const result = await pending;
      if (outcome.includes("denied")) {
        assert.equal(result.code, "DEVICE_POLICY_BLOCKED");
        assert.equal(decoderSignal.aborted, true);
      } else if (["second account", "sign-out"].includes(outcome)) {
        assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
        assert.equal(result.text, undefined);
      } else {
        assert.deepEqual(result, { success: true, text: "guest dictation" });
        assert.equal(decoderSignal.aborted, false);
      }
    });
  }
}

// Runs an enterprise meeting under `workspace-a`, owned by main, and reports every stop.
async function enterpriseMeeting(t, generation) {
  const originalStop = fakeThis._stopMeetingForPolicy;
  const originalManager = fakeThis.enterpriseIdentityManager;
  const originalAccount = databaseManager.activeAccountId;
  const originalTokenState = tokenState;
  t.after(() => {
    fakeThis._stopMeetingForPolicy = originalStop;
    fakeThis.enterpriseIdentityManager = originalManager;
    fakeThis._activeEnterpriseAudioMeeting = false;
    databaseManager.activeAccountId = originalAccount;
    tokenState = originalTokenState;
  });
  const stops = [];
  fakeThis._stopMeetingForPolicy = (reason) => {
    stops.push(reason);
    fakeThis._activeEnterpriseAudioMeeting = false;
  };
  fakeThis.enterpriseIdentityManager = {
    getConfig: async ({ accountId, workspaceId, expectedAuthGeneration }) => ({
      success: true,
      accountId,
      workspaceId,
      authGeneration: expectedAuthGeneration,
      config: { generation: 1, providers: [] },
    }),
    clear: () => {},
  };
  const loadConfig = (accountId, workspaceId, authGeneration) =>
    handlers.get("get-managed-enterprise-config")({}, accountId, workspaceId, authGeneration);
  const clear = (options) => handlers.get("clear-managed-enterprise-identity")({}, options);
  const next = (accountId, workspaceId) => ({ next: { accountId, workspaceId } });
  const rotate = (generation) => {
    tokenState = { token: `enterprise-token-${generation}`, generation };
    handleAuthTokenChange(tokenState);
  };

  rotate(generation);
  await setScope("enterprise-account", generation);
  databaseManager.activeAccountId = "enterprise-account";
  await loadConfig("enterprise-account", "workspace-a", generation);
  fakeThis._activeEnterpriseAudioMeeting = true;
  stops.length = 0;
  return { stops, loadConfig, clear, next, rotate };
}

test("an enterprise meeting outlives a token rotation and any clear that names no scope", async (t) => {
  const { stops, loadConfig, clear, next, rotate } = await enterpriseMeeting(t, 70);
  rotate(71);
  // A window booting mid-rotation reads no scope yet and clears without one.
  await clear();
  await clear(next("enterprise-account", "workspace-a"));
  await setScope("enterprise-account", 71);
  await loadConfig("enterprise-account", "workspace-a", 71);
  assert.deepEqual(stops, [], "a same-account token rotation keeps the meeting");
});

test("an enterprise meeting stops as soon as the renderer moves to another workspace, even before the scope resolves", async (t) => {
  const { stops, loadConfig, clear, next, rotate } = await enterpriseMeeting(t, 72);
  rotate(73);
  await clear(next("enterprise-account", "workspace-b"));
  assert.deepEqual(stops, ["workspaceChanged"]);
  // The config request that would otherwise have noticed is refused meanwhile.
  await assert.rejects(loadConfig("enterprise-account", "workspace-b", 73), {
    code: "AUTH_CONTEXT_CHANGED",
  });
});

test("an enterprise meeting stops when the workspace is cleared with no config to follow", async (t) => {
  const { stops, clear, next } = await enterpriseMeeting(t, 74);
  await clear({ next: { accountId: "enterprise-account", workspaceId: 7 } });
  assert.deepEqual(stops, [], "a malformed scope is ignored");
  await clear(next("enterprise-account", null));
  assert.deepEqual(stops, ["workspaceChanged"]);
});

test("an enterprise meeting stops for another account once main learns it, not on the renderer's clear", async (t) => {
  const { stops, clear, rotate } = await enterpriseMeeting(t, 76);
  rotate(77);
  await clear();
  assert.deepEqual(stops, []);
  await setScope("other-account", 77);
  // The account scope change stops any meeting as well; every stop names the account.
  assert.ok(stops.length > 0 && stops.every((reason) => reason === "accountChanged"), stops);
});

test("account deletion still deletes the note mirrors when the enterprise vault won't clear", async (t) => {
  const originalTokenState = tokenState;
  const originals = {
    enterpriseAudioCredentials: fakeThis.enterpriseAudioCredentials,
    metaActivation: fakeThis.metaActivation,
    _asyncMirrorDelete: fakeThis._asyncMirrorDelete,
  };
  t.after(() => {
    Object.assign(fakeThis, originals);
    delete connectorManager.disconnectAll;
    delete databaseManager.deleteAccountData;
    tokenState = originalTokenState;
  });
  const mirrored = [];
  tokenState = { token: "delete-token", generation: 90 };
  connectorManager.disconnectAll = async () => {};
  databaseManager.deleteAccountData = () => ({ deletedNoteIds: [11, 12] });
  fakeThis.metaActivation = { purge: () => {} };
  fakeThis._asyncMirrorDelete = (noteId) => mirrored.push(noteId);
  fakeThis.enterpriseAudioCredentials = {
    removeAccount: async () => {
      throw new Error("vault locked");
    },
  };

  const result = await handlers.get("delete-account-data")({}, "deleted-account", 90);
  assert.equal(result.success, true);
  assert.deepEqual(mirrored, [11, 12]);
});

test("repeated validated account scope preserves its settled policy while refreshing", async (t) => {
  tokenState = { token: "stable-policy-token", generation: 80 };
  await setScope("stable-policy-account", 80);
  await new Promise((resolve) => setImmediate(resolve));
  const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
  policy.dataRetention.audioRetentionMaxDays = 7;
  const manager = fakeThis.effectivePolicyManager;
  manager.updateWorkspace({
    success: true,
    managed: true,
    accountId: "stable-policy-account",
    authGeneration: 80,
    policy,
    policyUpdatedAt: "2026-11-03T10:00:00.000Z",
  });
  const settled = manager.getCurrent();
  assert.equal(settled.status, "managed");
  const refresh = fakeThis.refreshEffectivePolicy;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const refreshes = [];
  fakeThis.refreshEffectivePolicy = () => {
    const work = pending.then(() => refresh());
    refreshes.push(work);
    return work;
  };
  t.after(async () => {
    fakeThis.refreshEffectivePolicy = refresh;
    release();
    await Promise.all(refreshes);
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await setScope("stable-policy-account", 80), { success: true });
    assert.equal(manager.getCurrent().status, "managed");
    assert.equal(manager.getCurrent().revision, settled.revision);
    assert.equal(manager.getCurrent().policy.dataRetention.audioRetentionMaxDays, 7);
  }
  assert.equal(refreshes.length, 3);

  tokenState = { token: "rotated-policy-token", generation: 81 };
  await setScope("stable-policy-account", 81);
  assert.equal(manager.getCurrent().status, "loading");
  assert.equal(manager.getCurrent().authGeneration, 81);
});

test("while a verdict loads, local work runs, new remote work waits for it, and windows aren't held", async (t) => {
  const { deferred } = require("./harness/deferred");
  const answer = deferred();
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  const previous = { whisperManager: fakeThis.whisperManager, tokenState };
  t.after(async () => {
    answer.resolve();
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
    fakeThis.whisperManager = previous.whisperManager;
    tokenState = previous.tokenState;
  });
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  const realFetch = electronStub.net.fetch;
  t.mock.method(electronStub.net, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/workspace-policy")) await answer.promise;
    return realFetch(url, init);
  });
  handleAuthTokenChange({ token: "loading-token", generation: tokenState.generation + 1 });

  const snapshot = await Promise.race([
    handlers.get("get-effective-policy")({ sender: {} }),
    new Promise((resolve) => setTimeout(() => resolve("held"), 200)),
  ]);
  assert.equal(snapshot.status, "loading");
  fakeThis.whisperManager = {
    transcribeLocalWhisper: async () => ({ success: true, text: "local dictation" }),
  };
  const local = await handlers.get("transcribe-local-whisper")({ sender: {} }, new Uint8Array([1]));
  assert.equal(local.text, "local dictation");
  const remote = handlers.get("cloud-health-check")({ sender: {} });
  answer.resolve();
  assert.deepEqual(await remote, { ok: true, status: 200 });
});

test("new remote work doesn't start on a verdict that never settles", async (t) => {
  const { POLICY_TIMEOUT_MS } = require("../../src/helpers/connectors/connectorIpc");
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  const previousTokenState = tokenState;
  const lookups = [];
  t.after(() => {
    for (const lookup of lookups) lookup.resolve();
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
    tokenState = previousTokenState;
  });
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  const realFetch = electronStub.net.fetch;
  t.mock.method(electronStub.net, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/workspace-policy")) {
      const lookup = require("./harness/deferred").deferred();
      lookups.push(lookup);
      await lookup.promise;
    }
    return realFetch(url, init);
  });
  handleAuthTokenChange({ token: "unsettled-token", generation: tokenState.generation + 1 });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let result;
  const remote = handlers
    .get("cloud-health-check")({ sender: {} })
    .then((value) => {
      result = value;
    });
  for (let turn = 0; turn < 20 && !result; turn++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(POLICY_TIMEOUT_MS);
  }
  await remote;
  assert.equal(result.code, "DEVICE_POLICY_BLOCKED");
});

test("an account change during a streaming start closes the socket the start opened", async (t) => {
  const previous = {
    geminiStreaming: fakeThis.geminiStreaming,
    account: databaseManager.activeAccountId,
    tokenState,
  };
  t.after(() => {
    fakeThis.geminiStreaming = previous.geminiStreaming;
    databaseManager.activeAccountId = previous.account;
    tokenState = previous.tokenState;
  });
  tokenState = { token: "stream-token", generation: tokenState.generation + 1 };
  databaseManager.activeAccountId = "stream-account";
  await fakeThis.refreshEffectivePolicy();
  const disconnects = [];
  fakeThis.geminiStreaming = {
    // The account changes while the start is opening its socket.
    get isConnected() {
      databaseManager.activeAccountId = "other-account";
      return true;
    },
    cleanupWarmConnection() {},
    disconnect: async (options) => disconnects.push(options),
  };

  const result = await handlers.get("gemini-streaming-warmup")({ sender: {} }, {});

  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.deepEqual(disconnects, [{ commit: false }]);
  assert.equal(fakeThis.geminiStreaming, null);
});

for (const boundary of ["sign-out", "account switch"]) {
  test(`a connected stream survives token rotation and ends on ${boundary}`, async (t) => {
    const previous = {
      stream: fakeThis.geminiStreaming,
      account: databaseManager.activeAccountId,
      tokenState,
    };
    t.after(() => {
      fakeThis.geminiStreaming = previous.stream;
      databaseManager.activeAccountId = previous.account;
      tokenState = previous.tokenState;
    });
    tokenState = { token: "stream-owner-token", generation: tokenState.generation + 1 };
    await setScope("stream-owner", tokenState.generation);
    await fakeThis.refreshEffectivePolicy();
    const disconnects = [];
    const streaming = {
      isConnected: true,
      cleanupWarmConnection() {},
      disconnect: async (options) => disconnects.push(options),
    };
    fakeThis.geminiStreaming = streaming;
    assert.equal((await handlers.get("gemini-streaming-warmup")({ sender: {} }, {})).success, true);
    handleAuthTokenChange({ token: "rotated-owner-token", generation: tokenState.generation + 1 });
    await setScope("stream-owner", tokenState.generation);
    assert.equal(fakeThis.geminiStreaming, streaming);
    assert.equal(disconnects.length, 0);
    if (boundary === "sign-out") {
      handleAuthTokenChange({ token: null, generation: tokenState.generation + 1 });
    } else {
      handleAuthTokenChange({
        token: "other-account-token",
        generation: tokenState.generation + 1,
      });
      await setScope("other-account", tokenState.generation);
    }
    assert.equal(fakeThis.geminiStreaming, null);
    assert.deepEqual(disconnects, [{ commit: false }]);
  });
}

test("sign-out during a connecting stream preserves its late-socket cleanup", async (t) => {
  const { deferred } = require("./harness/deferred");
  const previous = {
    stream: fakeThis.geminiStreaming,
    account: databaseManager.activeAccountId,
    tokenState,
    environment: Object.getOwnPropertyDescriptor(fakeThis, "environmentManager"),
  };
  const entered = deferred(),
    finish = deferred();
  t.after(() => {
    finish.resolve();
    fakeThis.geminiStreaming = previous.stream;
    databaseManager.activeAccountId = previous.account;
    tokenState = previous.tokenState;
    if (previous.environment)
      Object.defineProperty(fakeThis, "environmentManager", previous.environment);
    else delete fakeThis.environmentManager;
  });
  tokenState = { token: "connecting-token", generation: tokenState.generation + 1 };
  await setScope("connecting-owner", tokenState.generation);
  await fakeThis.refreshEffectivePolicy();
  fakeThis.environmentManager = { getGeminiKey: () => "saved-key" };
  let connected = false;
  const streaming = {
    isConnected: false,
    beginConnecting() {},
    cleanupWarmConnection() {},
    connect: async () => {
      entered.resolve();
      await finish.promise;
      connected = true;
    },
    disconnect: async () => {
      connected = false;
    },
  };
  fakeThis.geminiStreaming = streaming;
  const pending = handlers.get("gemini-streaming-warmup")({ sender: {} }, { mode: "byok" });
  await entered.promise;
  handleAuthTokenChange({ token: null, generation: tokenState.generation + 1 });
  finish.resolve();
  assert.equal((await pending).code, "AUTH_CONTEXT_CHANGED");
  assert.equal(connected, false);
  assert.equal(fakeThis.geminiStreaming, null);
});

for (const overlap of ["before account switch", "after account switch"]) {
  test(
    `a rejected overlapping start ${overlap} cannot retain the old account's real socket`,
    { timeout: 5000 },
    async (t) => {
      const { WebSocketServer } = require("ws");
      const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");
      const { deferred } = require("./harness/deferred");
      const previous = {
        stream: fakeThis.assemblyAiStreaming,
        account: databaseManager.activeAccountId,
        tokenState,
        api: process.env.OPENWHISPR_API_URL,
      };
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise((resolve) => server.once("listening", resolve));
      const connected = deferred();
      const closed = deferred();
      const frames = [];
      let peer;
      server.once("connection", (socket) => {
        peer = socket;
        socket.on("message", (data, binary) =>
          frames.push(binary ? "audio" : JSON.parse(data.toString()))
        );
        socket.once("close", closed.resolve);
        connected.resolve();
      });
      const streaming = new AssemblyAiStreaming();
      streaming.cacheToken("loopback-test-token");
      streaming.buildWebSocketUrl = () => `ws://127.0.0.1:${server.address().port}`;
      const disconnect = t.mock.method(streaming, "disconnect");
      let first;
      t.after(async () => {
        streaming.cleanupAll();
        for (const client of server.clients) client.terminate();
        await new Promise((resolve) => server.close(resolve));
        await first;
        fakeThis.assemblyAiStreaming = previous.stream;
        databaseManager.activeAccountId = previous.account;
        tokenState = previous.tokenState;
        fakeThis._remoteStreamPolicies.delete("assemblyAiStreaming");
        if (previous.api === undefined) delete process.env.OPENWHISPR_API_URL;
        else process.env.OPENWHISPR_API_URL = previous.api;
      });
      process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
      tokenState = { token: "socket-owner-token", generation: tokenState.generation + 1 };
      await setScope("socket-owner", tokenState.generation);
      await fakeThis.refreshEffectivePolicy();
      fakeThis.assemblyAiStreaming = streaming;
      first = handlers.get("assemblyai-streaming-start")({ sender: {} }, {});
      streaming.sendAudio(Buffer.alloc(3200, 1));
      assert.equal(streaming.pendingAudioBytes, 3200);
      await connected.promise;
      if (streaming.ws.readyState !== streaming.ws.OPEN)
        await new Promise((resolve) => streaming.ws.once("open", resolve));
      assert.equal(streaming.pendingAudioBytes, 3200);
      const duplicate = () => handlers.get("assemblyai-streaming-start")({ sender: {} }, {});
      if (overlap === "before account switch")
        assert.deepEqual(await duplicate(), { success: false, error: "Operation in progress" });
      handleAuthTokenChange({ token: "next-owner-token", generation: tokenState.generation + 1 });
      await setScope("next-owner", tokenState.generation);
      await fakeThis.refreshEffectivePolicy();
      assert.equal(
        streaming.pendingAudioBytes,
        0,
        "account retirement drops held audio immediately"
      );
      if (overlap === "after account switch")
        assert.deepEqual(await duplicate(), { success: false, error: "Operation in progress" });
      if (peer.readyState === peer.OPEN)
        peer.send(JSON.stringify({ type: "Begin", id: "old-owner-session" }));
      assert.equal((await first).code, "AUTH_CONTEXT_CHANGED");
      assert.equal(streaming.isConnected, false);
      await closed.promise;
      assert.ok(disconnect.mock.callCount() > 0);
      assert.ok(disconnect.mock.calls.every((call) => call.arguments[0].commit === false));
      assert.equal(frames.includes("audio"), false, "held audio cannot leave after its account");
      assert.equal(
        frames.some((frame) => frame.type === "Terminate"),
        false
      );
      assert.equal(streaming.onPartialTranscript, null);
      assert.equal(streaming.onFinalTranscript, null);
      assert.equal(streaming.onError, null);
      assert.equal(streaming.onSessionEnd, null);
      assert.equal(fakeThis.assemblyAiStreaming, null);
    }
  );
}

for (const replaced of [false, true]) {
  test(`overlapping warmup and start retain account ownership${replaced ? " without retiring a replacement" : ""}`, async (t) => {
    const { deferred } = require("./harness/deferred");
    const previous = {
      stream: fakeThis.geminiStreaming,
      account: databaseManager.activeAccountId,
      tokenState,
      environment: Object.getOwnPropertyDescriptor(fakeThis, "environmentManager"),
    };
    const entered = deferred();
    const finish = deferred();
    const disconnects = [];
    const pending = [];
    const streaming = {
      isConnected: false,
      beginConnecting() {},
      cleanupWarmConnection() {},
      connect: async () => {
        entered.resolve();
        await finish.promise;
        streaming.isConnected = true;
      },
      disconnect: async (options) => {
        disconnects.push(options);
        streaming.isConnected = false;
      },
      sendAudio() {},
    };
    const replacement = { isConnected: true };
    t.after(async () => {
      finish.resolve();
      await Promise.allSettled(pending);
      fakeThis.geminiStreaming = previous.stream;
      databaseManager.activeAccountId = previous.account;
      tokenState = previous.tokenState;
      fakeThis._remoteStreamPolicies.delete("geminiStreaming");
      if (previous.environment)
        Object.defineProperty(fakeThis, "environmentManager", previous.environment);
      else delete fakeThis.environmentManager;
    });
    tokenState = { token: "warmup-owner-token", generation: tokenState.generation + 1 };
    await setScope("warmup-owner", tokenState.generation);
    await fakeThis.refreshEffectivePolicy();
    fakeThis.environmentManager = { getGeminiKey: () => "saved-key" };
    fakeThis.geminiStreaming = streaming;
    const warmup = handlers.get("gemini-streaming-warmup")({ sender: {} }, { mode: "byok" });
    pending.push(warmup);
    await entered.promise;
    const start = handlers.get("gemini-streaming-start")({ sender: {} }, { mode: "byok" });
    pending.push(start);
    await new Promise(setImmediate);
    assert.equal(streaming.isConnected, false, "same-account promotion waits for its warmup");
    handleAuthTokenChange({ token: "next-warmup-token", generation: tokenState.generation + 1 });
    await setScope("next-warmup-owner", tokenState.generation);
    await fakeThis.refreshEffectivePolicy();
    const overlap = handlers.get("gemini-streaming-warmup")({ sender: {} }, { mode: "byok" });
    pending.push(overlap);
    assert.deepEqual(await Promise.race([overlap, new Promise(setImmediate)]), {
      success: false,
      error: "Operation in progress",
    });
    if (replaced) {
      fakeThis.geminiStreaming = replacement;
      fakeThis._remoteStreamPolicies.set("geminiStreaming", {
        channel: "gemini-streaming-start",
        args: [{ mode: "byok" }],
        accountId: "next-warmup-owner",
      });
    }
    finish.resolve();
    assert.equal((await warmup).code, "AUTH_CONTEXT_CHANGED");
    assert.equal((await start).code, "AUTH_CONTEXT_CHANGED");
    assert.equal(streaming.isConnected, false);
    assert.ok(disconnects.length > 0);
    assert.ok(disconnects.every((options) => options.commit === false));
    assert.equal(fakeThis.geminiStreaming, replaced ? replacement : null);
  });
}

function useProductLifecycle(t) {
  const prototype = require(handlersModulePath).prototype;
  const methods = new Map();
  for (const method of [
    "_stopRemoteProductWork",
    "_retireDisallowedProductWork",
    "_startRemoteProductWork",
  ]) {
    methods.set(method, Object.getOwnPropertyDescriptor(fakeThis, method));
    fakeThis[method] = prototype[method];
  }
  const previous = { databaseManager: fakeThis.databaseManager, tokenState };
  fakeThis.databaseManager = scopedDatabase(null);
  t.after(() => {
    for (const [method, descriptor] of methods) {
      if (descriptor) Object.defineProperty(fakeThis, method, descriptor);
      else delete fakeThis[method];
    }
    fakeThis.databaseManager = previous.databaseManager;
    tokenState = previous.tokenState;
  });
  useTestApi(t);
  return prototype;
}

for (const stage of ["admission", "streaming"]) {
  for (const boundary of [
    "another account",
    "away and back",
    "same-account rotation",
    "user cancellation",
  ]) {
    test(`cloud agent ${stage} retains ownership across ${boundary}`, async (t) => {
      useProductLifecycle(t);
      const { deferred } = require("./harness/deferred");
      const verdict = deferred(),
        entered = deferred();
      const pending = [],
        sent = [],
        outputs = [],
        messages = [];
      const originalToken = `agent-${stage}-${boundary}-first`;
      const owner = `agent-${stage}-${boundary}-owner`;
      const sender = new (require("node:events").EventEmitter)();
      sender.id = 101;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => messages.push([channel, payload]);
      t.mock.method(electronStub.net, "fetch", async (url, init) => {
        if (String(url).endsWith("/api/agent/stream")) {
          sent.push({
            authorization: init.headers.Authorization,
            signal: init.signal,
          });
          const output = { cancelled: false, closed: false };
          const response =
            stage === "admission"
              ? new Response("")
              : new Response(
                  new ReadableStream({
                    start(controller) {
                      output.controller = controller;
                      outputs.push(output);
                    },
                    cancel() {
                      output.cancelled = true;
                    },
                  })
                );
          if (sent.length === 2) entered.resolve();
          return response;
        }
        if (stage === "admission" && init.headers.Authorization === `Bearer ${originalToken}`)
          await verdict.promise;
        return Response.json({ data: { managed: false, policy: null, policyUpdatedAt: null } });
      });
      t.after(async () => {
        verdict.resolve();
        for (const output of outputs)
          if (!output.cancelled && !output.closed) output.controller.close();
        await Promise.allSettled(pending);
      });
      handleAuthTokenChange({ token: originalToken, generation: tokenState.generation + 1 });
      await setScope(owner, tokenState.generation);
      if (stage === "streaming") await fakeThis.refreshEffectivePolicy();
      for (const requestId of ["first-agent", "second-agent"])
        pending.push(
          eventHandlers.get("cloud-agent-stream-start")({ sender }, requestId, [
            { role: "user", content: requestId },
          ])
        );
      if (stage === "streaming") await entered.promise;
      await new Promise(setImmediate);
      if (stage === "admission") assert.deepEqual(sent, []);
      if (boundary === "user cancellation") {
        for (const requestId of ["first-agent", "second-agent"])
          eventHandlers.get("cloud-agent-stream-cancel")({ sender }, requestId);
      } else {
        handleAuthTokenChange({
          token: `agent-${stage}-${boundary}-next`,
          generation: tokenState.generation + 1,
        });
        await setScope(
          boundary === "same-account rotation" ? owner : "agent-replacement",
          tokenState.generation
        );
        if (boundary === "away and back") {
          handleAuthTokenChange({
            token: `agent-${stage}-${boundary}-return`,
            generation: tokenState.generation + 1,
          });
          await setScope(owner, tokenState.generation);
        }
        await fakeThis.refreshEffectivePolicy();
      }
      const permitted = boundary === "same-account rotation";
      if (stage === "streaming")
        for (const request of sent) assert.equal(request.signal.aborted, !permitted);
      verdict.resolve();
      for (const output of outputs) {
        output.controller.enqueue(
          new TextEncoder().encode('{"type":"text","text":"late owner output"}\n')
        );
        if (permitted) {
          output.controller.close();
          output.closed = true;
        }
      }
      await Promise.all(pending);
      assert.equal(sent.length, stage === "streaming" || permitted ? 2 : 0);
      if (stage === "admission" && permitted)
        assert.ok(sent.every((request) => request.authorization === `Bearer ${tokenState.token}`));
      assert.equal(
        messages.filter(([channel]) => channel === "cloud-agent-stream-chunk").length,
        stage === "streaming" && permitted ? 2 : 0
      );
      if (stage === "streaming")
        assert.ok(outputs.every((output) => output.cancelled === !permitted));
      assert.equal(sender.listenerCount("destroyed"), 0);
      assert.equal(fakeThis._productRequests.size, 0);
      assert.equal(fakeThis._agentStreamRequests.requestsBySender.size, 0);
    });
  }
}

test("cloud agent admission preserves typed API failures and releases ownership", async (t) => {
  useProductLifecycle(t);
  const messages = [];
  t.mock.method(electronStub.net, "fetch", async (url) =>
    String(url).endsWith("/api/agent/stream")
      ? Response.json({}, { status: 401 })
      : Response.json({ data: { managed: false, policy: null, policyUpdatedAt: null } })
  );
  handleAuthTokenChange({ token: "agent-error-token", generation: tokenState.generation + 1 });
  await setScope("agent-error-owner", tokenState.generation);
  await fakeThis.refreshEffectivePolicy();
  const sender = new (require("node:events").EventEmitter)();
  sender.id = 102;
  sender.isDestroyed = () => false;
  sender.send = (channel, payload) => messages.push([channel, payload]);
  await eventHandlers.get("cloud-agent-stream-start")({ sender }, "failed-agent", []);
  assert.equal(messages[0][0], "cloud-agent-stream-error");
  assert.equal(messages[0][1].code, "AUTH_EXPIRED");
  assert.equal(sender.listenerCount("destroyed"), 0);
  assert.equal(fakeThis._productRequests.size, 0);
  assert.equal(fakeThis._agentStreamRequests.requestsBySender.size, 0);
});

for (const boundary of ["another account", "away and back", "same-account rotation"]) {
  test(`pending product admissions retain their original owner across ${boundary}`, async (t) => {
    useProductLifecycle(t);
    const { deferred } = require("./harness/deferred");
    const answer = deferred();
    const pending = [];
    const sent = [];
    const firstToken = `admission-${boundary}-first`;
    const firstAccount = `admission-owner-${boundary}`;
    const policyResponse = () =>
      Response.json({ data: { managed: false, policy: null, policyUpdatedAt: null } });
    t.mock.method(electronStub.net, "fetch", async (url, init) => {
      if (String(url).endsWith("/api/reason")) {
        sent.push({ authorization: init.headers.Authorization, text: JSON.parse(init.body).text });
        return Response.json({ text: "permitted answer" });
      }
      if (init.headers.Authorization === `Bearer ${firstToken}`) await answer.promise;
      return policyResponse();
    });
    t.after(async () => {
      answer.resolve();
      await Promise.allSettled(pending);
    });
    handleAuthTokenChange({ token: firstToken, generation: tokenState.generation + 1 });
    await setScope(firstAccount, tokenState.generation);
    for (const text of ["first owner's private input", "another pending private input"]) {
      const sender = new (require("node:events").EventEmitter)();
      sender.id = pending.length + 1;
      pending.push(handlers.get("cloud-reason")({ sender }, text));
    }
    await new Promise(setImmediate);
    assert.equal(fakeThis.effectivePolicyManager.getCurrent().status, "loading");
    assert.deepEqual(sent, []);
    const sameAccount = boundary === "same-account rotation";
    handleAuthTokenChange({
      token: `admission-${boundary}-next`,
      generation: tokenState.generation + 1,
    });
    await setScope(sameAccount ? firstAccount : "replacement-owner", tokenState.generation);
    if (boundary === "away and back") {
      handleAuthTokenChange({
        token: `admission-${boundary}-return`,
        generation: tokenState.generation + 1,
      });
      await setScope(firstAccount, tokenState.generation);
    }
    await fakeThis.refreshEffectivePolicy();
    answer.resolve();
    const results = await Promise.all(pending);
    assert.equal(
      sent.length,
      sameAccount ? 2 : 0,
      "a waiting request cannot acquire another owner"
    );
    assert.ok(results.every((result) => result.success === sameAccount));
    if (sameAccount)
      assert.ok(sent.every((request) => request.authorization === `Bearer ${tokenState.token}`));
  });
}

for (const stage of ["startup", "streaming"]) {
  for (const boundary of ["another account", "away and back", "same-account rotation"]) {
    test(`enterprise product ownership during ${stage}: ${boundary}`, async (t) => {
      useProductLifecycle(t);
      const { deferred } = require("./harness/deferred");
      const entered = deferred();
      const finishSetup = deferred();
      const messages = [];
      let output;
      let providerSignal;
      let providerCalls = 0;
      let cancelled = false;
      const load = Module._load;
      t.mock.method(Module, "_load", function (request, parent, isMain) {
        if (parent?.filename === handlersModulePath && request === "./enterpriseAiProviders")
          return {
            getEnterpriseAIModel: async () => {
              if (stage === "startup") {
                entered.resolve();
                await finishSetup.promise;
              }
              return {
                doStream: async ({ abortSignal }) => {
                  providerCalls++;
                  providerSignal = abortSignal;
                  const stream = new ReadableStream({
                    start(controller) {
                      output = controller;
                    },
                    cancel() {
                      cancelled = true;
                    },
                  });
                  entered.resolve();
                  return { stream };
                },
              };
            },
          };
        return load.call(this, request, parent, isMain);
      });
      handleAuthTokenChange({
        token: `enterprise-${stage}-${boundary}-first`,
        generation: tokenState.generation + 1,
      });
      await setScope("enterprise-owner", tokenState.generation);
      await fakeThis.refreshEffectivePolicy();
      const sender = new (require("node:events").EventEmitter)();
      sender.id = 91;
      sender.isDestroyed = () => false;
      sender.send = (_channel, payload) => messages.push(payload);
      const pending = handlers.get("enterprise-stream-start")(
        { sender },
        {
          streamId: `enterprise-${stage}-${boundary}`,
          provider: "azure",
          modelId: "private-model",
          config: { apiKey: "saved-key", azureEndpoint: "https://company.openai.azure.com" },
          options: { prompt: [] },
        }
      );
      t.after(async () => {
        finishSetup.resolve();
        if (output && !cancelled) output.close();
        await pending;
      });
      await entered.promise;
      const sameAccount = boundary === "same-account rotation";
      handleAuthTokenChange({
        token: `enterprise-${stage}-${boundary}-next`,
        generation: tokenState.generation + 1,
      });
      await setScope(sameAccount ? "enterprise-owner" : "enterprise-next", tokenState.generation);
      if (boundary === "away and back") {
        handleAuthTokenChange({
          token: `enterprise-${stage}-${boundary}-return`,
          generation: tokenState.generation + 1,
        });
        await setScope("enterprise-owner", tokenState.generation);
      }
      await fakeThis.refreshEffectivePolicy();
      finishSetup.resolve();
      await new Promise(setImmediate);
      if (output && !cancelled) {
        output.enqueue({ type: "text-delta", id: "text-1", delta: "buffered owner content" });
        await new Promise(setImmediate);
        if (!cancelled) output.close();
      }
      const result = await pending;
      output = null;
      assert.equal(providerCalls, stage === "startup" && !sameAccount ? 0 : 1);
      assert.equal(
        messages.some((message) => message.part),
        sameAccount
      );
      assert.equal(result.success, sameAccount);
      if (stage === "streaming") {
        assert.equal(providerSignal.aborted, !sameAccount);
        assert.equal(
          cancelled,
          !sameAccount,
          "a retired reader is cancelled despite buffered output"
        );
      }
    });
  }
}

for (const provider of ["google", "microsoft"]) {
  for (const boundary of ["policy revocation", "account departure"]) {
    test(`${provider} calendar authorization cannot revive sync after ${boundary}`, async (t) => {
      useProductLifecycle(t);
      const { deferred } = require("./harness/deferred");
      const {
        defaultDevicePolicy,
        normalizeDeviceValues,
      } = require("../../src/helpers/managedDevicePolicy");
      const Manager = require(`../../src/helpers/${provider}CalendarManager`);
      const property = `${provider}CalendarManager`;
      const previous = fakeThis[property];
      const previousRequests = Object.getOwnPropertyDescriptor(
        fakeThis,
        "_calendarAuthorizationRequests"
      );
      fakeThis._calendarAuthorizationRequests =
        new (require("../../src/helpers/agentStreamRequestRegistry"))();
      const entered = deferred(),
        finish = deferred();
      const manager = provider === "google" ? new Manager({}, {}, {}) : new Manager({}, {});
      let pending,
        signal,
        syncs = 0;
      fakeThis[property] = manager;
      t.after(async () => {
        finish.resolve();
        await pending;
        manager.stop();
        fakeThis[property] = previous;
        if (previousRequests)
          Object.defineProperty(fakeThis, "_calendarAuthorizationRequests", previousRequests);
        else delete fakeThis._calendarAuthorizationRequests;
      });
      t.mock.method(electronStub.net, "fetch", async () =>
        Response.json({ data: { managed: false, policy: null, policyUpdatedAt: null } })
      );
      handleAuthTokenChange({
        token: `${provider}-${boundary}-token`,
        generation: tokenState.generation + 1,
      });
      await setScope(`${provider}-${boundary}-owner`, tokenState.generation);
      await fakeThis.refreshEffectivePolicy();
      manager.oauth.startOAuthFlow = async (options) => {
        signal = options.signal;
        return { success: true, email: "saved-calendar@test" };
      };
      manager.fetchCalendars = async () => {
        entered.resolve();
        await finish.promise;
      };
      manager.syncEvents = async () => syncs++;
      manager.reminderScheduler.scheduleNextMeeting = () => {};
      manager._broadcastAccountsChanged = () => {};
      const sender = new (require("node:events").EventEmitter)();
      sender.id = 103;
      const channel = provider === "google" ? "gcal-start-oauth" : "mcal-start-oauth";
      pending = handlers.get(channel)({ sender }, "late-calendar");
      await entered.promise;
      if (boundary === "policy revocation") {
        const policy = defaultDevicePolicy();
        policy.features.connectorsEnabled = false;
        t.mock.method(fakeThis.managedDevicePolicy, "getSnapshot", () =>
          normalizeDeviceValues({ Policy: JSON.stringify(policy) })
        );
        fakeThis.effectivePolicyManager.getCurrent();
      } else {
        handleAuthTokenChange({
          token: `${provider}-replacement-token`,
          generation: tokenState.generation + 1,
        });
        await setScope(`${provider}-replacement`, tokenState.generation);
        await fakeThis.refreshEffectivePolicy();
      }
      assert.equal(signal.aborted, true);
      finish.resolve();
      const result = await pending;
      assert.equal(
        result.code,
        boundary === "policy revocation" ? "DEVICE_POLICY_BLOCKED" : "AUTH_CONTEXT_CHANGED"
      );
      assert.equal(manager.syncRunner.timer, null);
      assert.equal(syncs, 0);
      assert.equal(sender.listenerCount("destroyed"), 0);
    });
  }
}

test("calendar product retirement blocks focus and wake until policy resumes automatic synchronization", async (t) => {
  const prototype = useProductLifecycle(t);
  const {
    defaultDevicePolicy,
    normalizeDeviceValues,
  } = require("../../src/helpers/managedDevicePolicy");
  const GoogleCalendarManager = require("../../src/helpers/googleCalendarManager");
  const MicrosoftCalendarManager = require("../../src/helpers/microsoftCalendarManager");
  const calendars = [{ id: "saved-calendar", account_email: "saved@example.test" }];
  const accounts = [{ email: "saved@example.test" }];
  const calendarDatabase = new Proxy(
    {
      getSelectedCalendars: () => calendars,
      getSelectedMicrosoftCalendars: () => calendars,
      getGoogleAccounts: () => accounts,
      getMicrosoftAccounts: () => accounts,
      getMicrosoftOwnAddresses: () => [],
    },
    { get: (value, key) => (key in value ? value[key] : () => {}) }
  );
  const scheduler = { scheduleNextMeeting() {} };
  const google = new GoogleCalendarManager(calendarDatabase, {}, scheduler);
  const microsoft = new MicrosoftCalendarManager(calendarDatabase, scheduler);
  const previous = {
    googleCalendarManager: fakeThis.googleCalendarManager,
    microsoftCalendarManager: fakeThis.microsoftCalendarManager,
    _remoteCalendarsReady: fakeThis._remoteCalendarsReady,
    _remoteCalendarsStarted: fakeThis._remoteCalendarsStarted,
  };
  Object.assign(fakeThis, { googleCalendarManager: google, microsoftCalendarManager: microsoft });
  fakeThis._remoteCalendarsReady = false;
  fakeThis._remoteCalendarsStarted = false;
  let device = normalizeDeviceValues({});
  t.mock.method(fakeThis.managedDevicePolicy, "getSnapshot", () => device);
  const requests = [];
  t.mock.method(electronStub.net, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/workspace-policy"))
      return Response.json({ data: { managed: false, policy: null, policyUpdatedAt: null } });
    if (["www.googleapis.com", "graph.microsoft.com"].includes(new URL(url).hostname))
      requests.push({ url, authorization: init.headers.Authorization });
    return Response.json({ items: [], value: [] });
  });
  for (const manager of [google, microsoft]) {
    manager.oauth.getValidAccessToken = async () => "saved-calendar-credential";
    manager.oauth.startOAuthFlow = async () => ({ email: accounts[0].email });
  }
  t.after(() => {
    google.stop();
    microsoft.stop();
    Object.assign(fakeThis, previous);
  });
  handleAuthTokenChange({ token: "calendar-policy-owner", generation: tokenState.generation + 1 });
  await setScope("calendar-policy-owner", tokenState.generation);
  await fakeThis.refreshEffectivePolicy();
  await google.syncEvents();
  await microsoft.syncEvents();
  assert.equal(requests.length, 2, "explicit synchronization does not require a running timer");
  prototype.startPolicyCalendars.call(fakeThis);
  await new Promise(setImmediate);
  assert.ok(requests.length > 2, "saved accounts synchronize on startup");
  const policy = defaultDevicePolicy();
  policy.features.connectorsEnabled = false;
  device = normalizeDeviceValues({ Policy: JSON.stringify(policy) });
  fakeThis.effectivePolicyManager.getCurrent();
  assert.equal(google.syncRunner.timer, null);
  assert.equal(microsoft.syncRunner.timer, null);
  const before = requests.length;
  google.syncOnFocus();
  microsoft.syncOnFocus();
  google.onWakeFromSleep();
  microsoft.onWakeFromSleep();
  await new Promise(setImmediate);
  assert.equal(requests.length, before, "retired calendars cannot send on focus or wake");
  device = normalizeDeviceValues({});
  fakeThis.effectivePolicyManager.getCurrent();
  await new Promise(setImmediate);
  assert.ok(requests.length > before, "policy relaxation resumes automatic synchronization");
  for (const manager of [google, microsoft]) {
    manager.stop();
    const beforeOAuth = requests.length;
    await manager.startOAuth();
    assert.ok(
      requests.length > beforeOAuth,
      "permitted OAuth performs its initial synchronization"
    );
    assert.notEqual(manager.syncRunner.timer, null);
  }
});
