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
const broadcasts = [];
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-scope-ipc-"));
let tokenState = { token: null, generation: 0 };
const autoUpdater = { checkForUpdates: async () => null };

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
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
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
  if (request === "electron-updater") return { autoUpdater };
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
      return { broadcastToWindows: (channel, data) => broadcasts.push([channel, data]) };
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
  { setActiveAccountId: (accountId) => databaseScopes.push(accountId) },
  { get: (value, property) => (property in value ? value[property] : anything()) }
);

function buildFakeThis() {
  const target = {
    sessionId: "test-session",
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
  Ctor.prototype.setupHandlers.call(fakeThis);
  handleAuthTokenChange = (state) => Ctor.prototype._handleAuthTokenChange.call(fakeThis, state);
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

// Skip native updater setup; an AppImage keeps policy checks supported on Linux.
function createUpdater() {
  const previousEnvironment = process.env.NODE_ENV;
  const previousAppImage = process.env.APPIMAGE;
  try {
    process.env.NODE_ENV = "development";
    if (process.platform === "linux") process.env.APPIMAGE = "/tmp/OpenWhispr.AppImage";
    const UpdateManager = require("../../src/updater");
    return new UpdateManager({ getPolicy: (options) => fakeThis.getUpdatePolicy(options) });
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
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

// The verdict an earlier run left on disk for this credential.
function cachePolicyForHeaders(authHeaders, data) {
  const crypto = require("node:crypto");
  const { writeWorkspacePolicyCache } = require("../../src/helpers/workspacePolicyCache");
  const credentialHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(Object.entries(authHeaders)))
    .digest("hex");
  const identity = { apiOrigin: TEST_API_URL, credentialHash, accountId: null };
  writeWorkspacePolicyCache(path.join(userDataDirectory, "workspace-policy.json"), identity, data);
  return identity;
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
  assert.equal(
    broadcasts.some(([channel]) => channel === "workspace-policy-changed"),
    false
  );
});

test("an earlier consumer's bearer 401 permits guest updates while a held IT verdict stands", async (t) => {
  restoreUpdaterState(t);
  useTestApi(t);
  let refusals = 0;
  t.mock.method(electronStub.net, "fetch", async () => {
    refusals++;
    return { ok: false, status: 401, json: async () => ({}) };
  });
  // A 401 leaves the renderer's account scope in place, and another consumer
  // can receive it before the updater's first lookup.
  tokenState = { token: "expired-bearer", generation: 110 };
  fakeThis.databaseManager = scopedDatabase("expired-account");
  fakeThis.windowManager = { retireMeetingNotificationScope() {} };
  require("../../src/helpers/accountScopeBinding").persist("expired-account", "expired-bearer");
  fakeThis.updateManager = createUpdater();
  fakeThis.updateManager.httpExecutor = { resumeRequests() {}, abortRequests() {} };
  let checks = 0;
  t.mock.method(autoUpdater, "checkForUpdates", async () => {
    checks++;
    return null;
  });
  const earlier = await handlers.get("get-workspace-policy")({}, "expired-account", 110);
  assert.equal(earlier.httpStatus, 401);
  assert.equal(earlier.success, false);
  await fakeThis.updateManager.refreshPolicy();
  let status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, true);
  assert.equal(status.updateMode, "user_choice");
  fakeThis.updateManager._autoCheckForUpdates("Periodic");
  await new Promise(setImmediate);
  assert.equal(checks, 1);
  fakeThis.updateManager._autoCheckForUpdates("Periodic");
  await new Promise(setImmediate);
  assert.equal(checks, 2);
  assert.equal((await fakeThis.updateManager.getUpdateStatus()).policyReady, true);
  assert.equal(refusals, 1);

  cachePolicyForHeaders(
    { Authorization: "Bearer expired-managed-bearer" },
    managedPolicy("it_managed")
  );
  tokenState = { token: "expired-managed-bearer", generation: 111 };
  fakeThis.updateManager.invalidatePolicy();
  const refusalsBefore = refusals;
  await fakeThis.updateManager.refreshPolicy();
  await new Promise(setImmediate);
  assert.equal(refusals, refusalsBefore + 1);
  status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, true);
  assert.equal(status.updateMode, "it_managed");
});

test("earlier non-401 policy failures never permit guest updates", async (t) => {
  restoreUpdaterState(t);
  useTestApi(t);
  fakeThis.databaseManager = scopedDatabase("unavailable-account");
  fakeThis.windowManager = { retireMeetingNotificationScope() {} };
  let requests = 0;
  let httpStatus;
  t.mock.method(electronStub.net, "fetch", async () => {
    requests++;
    if (httpStatus === undefined) throw new Error("offline");
    return { ok: false, status: httpStatus, json: async () => ({}) };
  });
  for (const [index, status] of [403, 503, undefined].entries()) {
    httpStatus = status;
    tokenState = { token: `unavailable-bearer-${index}`, generation: 112 + index };
    fakeThis.updateManager = createUpdater();
    const earlier = await handlers.get("get-workspace-policy")(
      {},
      "unavailable-account",
      tokenState.generation
    );
    assert.equal(earlier.success, false);
    assert.equal(
      (await fakeThis.updateManager.checkForUpdates()).code,
      "UPDATE_POLICY_UNAVAILABLE"
    );
    const updateStatus = await fakeThis.updateManager.getUpdateStatus();
    assert.equal(updateStatus.policyReady, false);
    assert.equal(updateStatus.updateMode, null);
    fakeThis.updateManager.cleanup();
  }
  assert.equal(requests, 3);
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
  cachePolicyForHeaders(
    { Authorization: "Bearer unresolved-bearer" },
    {
      managed: false,
      policy: null,
      policyUpdatedAt: null,
      requiresManagedPolicy: true,
    }
  );
  tokenState = { token: "unresolved-bearer", generation: 115 };
  fakeThis.databaseManager = scopedDatabase(null);
  fakeThis.windowManager = { retireMeetingNotificationScope() {} };
  fakeThis.updateManager = createUpdater();
  await fakeThis.updateManager.refreshPolicy();
  const status = await fakeThis.updateManager.getUpdateStatus();
  assert.equal(status.policyReady, false);
  assert.equal(status.updateMode, null);
});

for (const [index, { name, data, mode }] of [
  {
    name: "unresolved",
    data: {
      managed: false,
      policy: null,
      policyUpdatedAt: null,
      requiresManagedPolicy: true,
    },
    mode: null,
  },
  { name: "IT-managed", data: managedPolicy("it_managed"), mode: "it_managed" },
  { name: "always-on", data: managedPolicy("always_on"), mode: "always_on" },
  { name: "unmanaged", data: null, mode: "user_choice" },
].entries()) {
  test(`cookie expiry preserves ${name} policy in main and updater lookups`, async (t) => {
    restoreUpdaterState(t);
    useTestApi(t);
    const { readWorkspacePolicyCache } = require("../../src/helpers/workspacePolicyCache");
    tokenState = { token: null, generation: 140 + index };
    fakeThis.databaseManager = scopedDatabase(null);
    let cookieValue;
    const cookieName = "__Secure-openwhispr.session_token";
    fakeThis.windowManager = {
      controlPanelWindow: {
        isDestroyed: () => false,
        webContents: {
          session: { cookies: { get: async () => [{ name: cookieName, value: cookieValue }] } },
        },
      },
      retireMeetingNotificationScope() {},
    };
    let requests = 0;
    t.mock.method(electronStub.net, "fetch", async (_url, init) => {
      requests++;
      assert.equal(init.headers.Cookie, `${cookieName}=${cookieValue}`);
      return { ok: false, status: 401, json: async () => ({}) };
    });
    fakeThis.updateManager = createUpdater();
    fakeThis.updateManager.setAutoUpdatesEnabled(false);
    for (const consumer of ["main", "updater"]) {
      cookieValue = `expired-${name}-${consumer}`;
      const identity =
        data && cachePolicyForHeaders({ Cookie: `${cookieName}=${cookieValue}` }, data);
      if (consumer === "main") {
        const snapshot = await fakeThis._getMainModelPolicy({});
        assert.equal(snapshot.success, mode !== null);
        if (mode === null) assert.equal(snapshot.code, "POLICY_UNRESOLVABLE");
        else assert.equal(snapshot.managed, data !== null);
      } else {
        await fakeThis.updateManager.refreshPolicy();
        const status = await fakeThis.updateManager.getUpdateStatus();
        assert.equal(status.policyReady, mode !== null);
        assert.equal(status.updateMode, mode);
        assert.equal(status.effectiveAutoUpdatesEnabled, mode === "always_on");
        if (mode === null) {
          assert.equal(
            (await fakeThis.updateManager.checkForUpdates()).code,
            "UPDATE_POLICY_UNAVAILABLE"
          );
        }
        await new Promise(setImmediate);
      }
      if (data?.requiresManagedPolicy) {
        assert.equal(
          readWorkspacePolicyCache(path.join(userDataDirectory, "workspace-policy.json"), identity)
            .requiresManagedPolicy,
          true
        );
      }
    }
    assert.equal(requests, 2);
  });
}

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
  cachePolicyForHeaders({ Authorization: "Bearer restarted-bearer" }, managedPolicy("always_on"));
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
  const originalStop = fakeThis._stopMeetingForPolicy;
  const originalAccount = databaseManager.activeAccountId;
  const originalTokenState = tokenState;
  t.after(() => {
    fakeThis._audioFeaturePolicy = originalPolicy;
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
