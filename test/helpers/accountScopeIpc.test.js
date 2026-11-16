const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");

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
  if (parent?.filename === handlersModulePath) {
    // Keep every cleanup target inside this harness's temporary userData.
    if (request === "os") return { ...os, homedir: () => userDataDirectory };
    if (request === "./autoStart") return { setAutoStartEnabled() {} };
    if (request === "./modelDirUtils") {
      return { getModelsDirForService: () => path.join(userDataDirectory, "models") };
    }
    if (request === "./modelManagerBridge") {
      return { default: { deleteAllModels: async () => {} } };
    }
    if (request === "./onnxWorkerClient") return { stop: async () => {} };
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        clear: () => {
          tokenState = { token: null, generation: tokenState.generation + 1 };
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
  fakeThis.productEvents?.dispose?.();
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

// Spies on what a scope pass does beyond moving the scope: the claims, the flushes and the
// connector reset. Main's database follows the scope it is given.
function watchScopeWork(t) {
  const work = [];
  const spied = {
    setActiveAccountId: (accountId) => {
      databaseScopes.push(accountId);
      databaseManager.activeAccountId = accountId;
    },
    claimSignedOutLocalRows: () => work.push("claimSignedOutLocalRows"),
    claimLegacyRowsOfOnlyAccount: () => work.push("claimLegacyRowsOfOnlyAccount"),
  };
  const originals = Object.fromEntries(
    ["setActiveAccountId", "claimSignedOutLocalRows", "claimLegacyRowsOfOnlyAccount"].map(
      (name) => [name, Object.getOwnPropertyDescriptor(databaseManager, name)]
    )
  );
  const originalAccount = databaseManager.activeAccountId;
  const originalThis = {
    _claimSignedOutPrivateNotes: fakeThis._claimSignedOutPrivateNotes,
    metaActivation: fakeThis.metaActivation,
    productEvents: fakeThis.productEvents,
  };
  Object.assign(databaseManager, spied);
  fakeThis._claimSignedOutPrivateNotes = () => work.push("claimSignedOutPrivateNotes");
  fakeThis.metaActivation = { flush: async () => work.push("metaActivation.flush") };
  fakeThis.productEvents = { flush: async () => work.push("productEvents.flush") };
  t.after(() => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(databaseManager, name, descriptor);
      else delete databaseManager[name];
    }
    databaseManager.activeAccountId = originalAccount;
    Object.assign(fakeThis, originalThis);
  });
  const reset = () => {
    work.length = 0;
    broadcasts.length = 0;
    connectorCalls.length = 0;
  };
  return { work, reset };
}

const FULL_PASS = [
  "claimSignedOutLocalRows",
  "claimLegacyRowsOfOnlyAccount",
  "claimSignedOutPrivateNotes",
  "metaActivation.flush",
  "productEvents.flush",
];

test("a scope main already applied is taken again without claims, broadcasts or flushes", async (t) => {
  const { work, reset } = watchScopeWork(t);
  // A relaunch: main restored the account before any window asked.
  tokenState = { token: "repeat-token", generation: 50 };
  databaseManager.activeAccountId = "repeat-account";

  reset();
  assert.deepEqual(await setScope("repeat-account", 50), { success: true });
  // The first pass of this process runs everything, legacy claims included.
  assert.deepEqual(work, FULL_PASS);
  assert.deepEqual(broadcasts, [
    ["active-account-scope-changed", { accountId: "repeat-account", authGeneration: 50 }],
  ]);

  reset();
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await setScope("repeat-account", 50), { success: true });
  }
  // Windows re-ask when a broadcast lands; a repeat that broadcast would feed itself.
  assert.deepEqual(work, []);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(connectorCalls, []);
  assert.deepEqual(await getScope(), { accountId: "repeat-account", authGeneration: 50 });

  // A rotated bearer is a new scope for the same account.
  tokenState = { token: "repeat-token-rotated", generation: 51 };
  reset();
  await setScope("repeat-account", 51);
  assert.deepEqual(work, FULL_PASS);
  assert.deepEqual(broadcasts, [
    ["active-account-scope-changed", { accountId: "repeat-account", authGeneration: 51 }],
  ]);
});

test("a repeated sign-out is taken once, and an account after it runs every claim", async (t) => {
  const { work, reset } = watchScopeWork(t);
  tokenState = { token: "signed-in-token", generation: 60 };
  await setScope("leaving-account", 60);

  // Main clears the account itself; the renderer's sign-out pass follows.
  handleAuthTokenChange({ token: null, generation: 61 });
  tokenState = { token: null, generation: 61 };
  reset();
  await setScope(null, 61);
  assert.deepEqual(work, FULL_PASS);
  assert.deepEqual(broadcasts, [["active-account-scope-changed", null]]);

  reset();
  await setScope(null, 61);
  await setScope(null, 61);
  assert.deepEqual(work, []);
  assert.deepEqual(broadcasts, []);

  // The next sign-in claims what was written signed out, even with the generation unchanged
  // since the sign-out pass.
  tokenState = { token: "next-token", generation: 62 };
  reset();
  await setScope("next-account", 62);
  assert.deepEqual(work, FULL_PASS);
  assert.deepEqual(databaseManager.activeAccountId, "next-account");
});

test("a repeat runs in full once anything else moved main's account or binding", async (t) => {
  const { work, reset } = watchScopeWork(t);
  tokenState = { token: "moved-token", generation: 70 };
  await setScope("moved-account", 70);

  // The database's account was moved by another path.
  databaseManager.activeAccountId = null;
  reset();
  await setScope("moved-account", 70);
  assert.deepEqual(work, FULL_PASS);
  assert.equal(databaseManager.activeAccountId, "moved-account");

  // The binding no longer vouches for this bearer.
  require("../../src/helpers/accountScopeBinding").clear();
  reset();
  await setScope("moved-account", 70);
  assert.deepEqual(work, FULL_PASS);
  assert.deepEqual(await getScope(), { accountId: "moved-account", authGeneration: 70 });
});

test("a failed private-note claim can retry before the scope becomes a no-op", async (t) => {
  const { reset } = watchScopeWork(t);
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis._claimSignedOutPrivateNotes = () =>
    Ctor.prototype._claimSignedOutPrivateNotes.call(fakeThis);
  const originalClaim = Object.getOwnPropertyDescriptor(
    databaseManager,
    "claimSignedOutPrivateNotes"
  );
  t.after(() => {
    if (originalClaim) {
      Object.defineProperty(databaseManager, "claimSignedOutPrivateNotes", originalClaim);
    } else delete databaseManager.claimSignedOutPrivateNotes;
  });
  let attempts = 0;
  let claimed = false;
  databaseManager.claimSignedOutPrivateNotes = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary claim failure");
    claimed = true;
    return { notes: 1, folders: 0 };
  };
  tokenState = { token: "claim-retry-token", generation: 80 };

  assert.deepEqual(await setScope("claim-retry-account", 80), { success: true });
  assert.equal(claimed, false);
  assert.deepEqual(await getScope(), { accountId: "claim-retry-account", authGeneration: 80 });

  await setScope("claim-retry-account", 80);
  assert.equal(claimed, true, "the next scope request retries the failed claim");
  assert.equal(attempts, 2);

  reset();
  await setScope("claim-retry-account", 80);
  assert.equal(attempts, 2);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(connectorCalls, []);
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

test("account deletion still clears audio and note mirrors when product-event erasure fails", async (t) => {
  const originalTokenState = tokenState;
  const originals = {
    productEvents: fakeThis.productEvents,
    audioStorageManager: fakeThis.audioStorageManager,
    metaActivation: fakeThis.metaActivation,
    enterpriseAudioCredentials: fakeThis.enterpriseAudioCredentials,
    _asyncMirrorDelete: fakeThis._asyncMirrorDelete,
  };
  t.after(() => {
    Object.assign(fakeThis, originals);
    delete connectorManager.disconnectAll;
    delete databaseManager.deleteAccountData;
    tokenState = originalTokenState;
  });
  const purged = [];
  const audio = [];
  const mirrored = [];
  const credentials = [];
  tokenState = { token: "delete-token", generation: 91 };
  connectorManager.disconnectAll = async () => {};
  databaseManager.deleteAccountData = () => ({
    deletedNoteIds: [11, 12],
    deletedTranscriptionIds: [21, 22],
  });
  fakeThis.productEvents = {
    purge: (accountId) => {
      purged.push(accountId);
      throw new Error("product-event storage unavailable");
    },
  };
  fakeThis.audioStorageManager = {
    deleteAudioForTranscriptions: (ids) => audio.push(...ids),
  };
  fakeThis.metaActivation = { purge: () => {} };
  fakeThis._asyncMirrorDelete = (noteId) => mirrored.push(noteId);
  fakeThis.enterpriseAudioCredentials = {
    removeAccount: async (accountId) => credentials.push(accountId),
  };

  const result = await handlers.get("delete-account-data")({}, "deleted-account", 91);

  assert.deepEqual(result, {
    success: false,
    code: "LOCAL_ACCOUNT_CLEANUP_FAILED",
    error: "product-event storage unavailable",
  });
  assert.deepEqual(purged, ["deleted-account"]);
  assert.deepEqual(audio, [21, 22]);
  assert.deepEqual(mirrored, [11, 12]);
  assert.deepEqual(credentials, ["deleted-account"]);
});

test("a late product event binding cannot recreate the queue for an erased account", async (t) => {
  const originalApiUrl = process.env.OPENWHISPR_API_URL;
  const originalTokenState = tokenState;
  t.after(() => {
    delete connectorManager.disconnectAll;
    delete databaseManager.deleteAccountData;
    tokenState = originalTokenState;
    if (originalApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = originalApiUrl;
  });
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  connectorManager.disconnectAll = async () => {};
  databaseManager.deleteAccountData = () => ({ deletedNoteIds: [] });
  const started = deferred();
  const response = deferred();
  t.mock.method(electronStub.net, "fetch", async (url) => {
    if (url.endsWith("/api/product-events/app-session")) {
      started.resolve();
      return response.promise;
    }
    return { ok: false, status: 401 };
  });
  tokenState = { token: "erase-bearer", generation: 93 };
  await setScope("erased-account", 93);
  const binding = handlers.get("product-events-record-app-session")(
    {},
    {
      accountId: "erased-account",
      authGeneration: 93,
    }
  );
  await started.promise;

  const erased = await handlers.get("delete-account-data")({}, "erased-account", 93);
  response.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      binding_id: "8413c2f3-a18d-4a12-9fe4-8f912f301d78",
      authenticated_at: new Date().toISOString(),
    }),
  });
  await binding;

  assert.equal(erased.success, true);
  const state = JSON.parse(
    fs.readFileSync(path.join(userDataDirectory, "product-events.json"), "utf8")
  );
  assert.ok(!state.events.some((event) => event.account_id === "erased-account"));
});

test("Reset App Data erases the product event store and interrupted writes", async (t) => {
  const originalApiUrl = process.env.OPENWHISPR_API_URL;
  const originalTokenState = tokenState;
  const collector = fakeThis.productEvents;
  t.after(() => {
    collector.dispose();
    delete connectorManager.revokeAllStored;
    tokenState = originalTokenState;
    if (originalApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = originalApiUrl;
  });
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  connectorManager.revokeAllStored = async () => {};
  t.mock.method(electronStub.net, "fetch", async () => ({ ok: false, status: 503 }));
  tokenState = { token: "reset-bearer", generation: 94 };
  await setScope("reset-account", 94);
  await handlers.get("product-events-record-onboarding-completed")(
    {},
    {
      setupMode: "local",
      flowVersion: "desktop-onboarding-1",
    }
  );
  await collector.flush();
  const file = path.join(userDataDirectory, "product-events.json");
  assert.ok(fs.existsSync(file));
  fs.copyFileSync(file, `${file}.111.tmp`);

  tokenState = { token: null, generation: 95 };
  const result = await handlers.get("cleanup-app")({ sender: {} });

  assert.equal(result.success, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.111.tmp`), false);
});
