const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Registers the real handlers against a fake `this` with the enterprise identity
// manager replaced, so scope, meeting and token-exchange wiring is observable.
const handlers = new Map();
const fetches = [];
let identityOptions;
let configSnapshot;

const electronStub = {
  app: {
    getPath: () => "/tmp",
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
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      throw new Error("offline");
    },
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
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeSendHeaders: () => {} },
      fetch: (url, init) => electronStub.net.fetch(url, init),
      closeAllConnections: async () => {},
    }),
  },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    const real = () => originalLoad.call(this, request, parent, isMain);
    if (request === "./tokenStore")
      return {
        ...real(),
        get: () => "test-token",
        getState: () => ({ token: "test-token", generation: 1 }),
      };
    if (request === "./accountScopeBinding")
      return {
        ...real(),
        read: () => null,
        resolveActiveAccountScope: () => ({ accountId: "account-a", authGeneration: 1 }),
      };
    if (request === "./enterpriseIdentityManager")
      return {
        createEnterpriseIdentityManager: (options) => {
          identityOptions = options;
          return {
            getConfig: async (input) => ({ ...configSnapshot(input) }),
            resolveProvider: async () => ({ managed: false }),
            clear: () => {},
          };
        },
      };
    if (request === "./workspacePolicyManager")
      return {
        ...real(),
        createWorkspacePolicyManager: () => ({
          getPolicy: async () => ({ success: true, managed: false }),
        }),
      };
    if (request === "./windowBroadcast") return { broadcastToWindows: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

let fakeThis;
let stops = 0;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const target = {};
  fakeThis = new Proxy(target, { get: (t, prop) => (prop in t ? t[prop] : anything()) });
  Ctor.prototype.setupHandlers.call(fakeThis);
  target._stopMeetingForPolicy = () => stops++;
  target._audioFeaturePolicy = {
    run: (_event, _purpose, fn) => fn(new AbortController().signal),
    failure: () => null,
    activeFailure: () => null,
  };
});

test.after(() => {
  Module._load = originalLoad;
});

const event = { sender: {} };
const snapshotFor =
  (providers = []) =>
  ({ accountId, workspaceId, expectedAuthGeneration }) => ({
    success: true,
    status: "current",
    accountId,
    workspaceId,
    authGeneration: expectedAuthGeneration,
    config: { generation: 1, providers },
  });
const enforcedAudio = [
  {
    provider: "azure",
    mode: "managed_required",
    allowManualSetup: false,
    config: {
      transcription: { defaultDeployment: "speech" },
      realtime: { defaultDeployment: "speech-rt" },
    },
  },
];
// Required batch audio never claimed meetings, so it leaves a personal one alone.
const enforcedBatchOnly = [
  { ...enforcedAudio[0], config: { transcription: { defaultDeployment: "speech" } } },
];
const selectWorkspace = (workspaceId) =>
  handlers.get("get-managed-enterprise-config")(event, "account-a", workspaceId, 1);

test("a workspace switch stops only an enterprise meeting unless the new scope enforces audio", async () => {
  configSnapshot = snapshotFor();
  stops = 0;
  fakeThis._activeEnterpriseAudioMeeting = false;
  await selectWorkspace("workspace-a");
  await selectWorkspace("workspace-b");
  assert.equal(stops, 0, "a personal meeting survives workspace switches");

  fakeThis._activeEnterpriseAudioMeeting = true;
  await selectWorkspace("workspace-c");
  assert.equal(stops, 1, "an enterprise meeting from the old scope stops");

  fakeThis._activeEnterpriseAudioMeeting = false;
  configSnapshot = snapshotFor(enforcedBatchOnly);
  await selectWorkspace("workspace-e");
  assert.equal(stops, 1, "a required batch-only envelope leaves a personal meeting running");

  configSnapshot = snapshotFor(enforcedAudio);
  await selectWorkspace("workspace-d");
  assert.equal(stops, 2, "a cached enforced envelope still stops a personal meeting");
  await selectWorkspace("workspace-d");
  assert.equal(stops, 2, "re-reading the same scope does not stop again");
});

test("a signed-in local meeting without a managed context needs no workspace lookup", async () => {
  fakeThis._enterpriseAudioBinding = null;
  fetches.length = 0;
  const result = await handlers.get("meeting-transcription-prepare")(event, {
    provider: "local",
    enterpriseIdentity: { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1 },
  });
  assert.deepEqual(result, { success: true });
  assert.deepEqual(fetches, []);
});

test("token exchanges read proxy credentials for the requesting identity, not the audio binding", async () => {
  fakeThis._enterpriseAudioBinding = null;
  const reads = [];
  fakeThis.enterpriseAudioCredentials = {
    read: async (...args) => {
      reads.push(args);
      throw Object.assign(new Error("credential read stopped"), { code: "TEST_STOP" });
    },
  };
  await assert.rejects(
    identityOptions.enterpriseFetch(
      "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      { method: "POST" },
      { proxy: { mode: "fixed", url: "http://proxy.test:8080", credentialSlot: "proxy" } },
      [],
      { accountId: "account-b", workspaceId: "workspace-b" }
    ),
    { code: "TEST_STOP" }
  );
  assert.deepEqual(reads, [["account-b", "workspace-b", "proxy"]]);
});

test("token exchanges whose network Electron can express stay on Electron's stack", async () => {
  fetches.length = 0;
  await assert.rejects(
    identityOptions.enterpriseFetch(
      "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      { method: "POST" },
      { sessionMaxMs: 600000 },
      [],
      { accountId: "account-a", workspaceId: "workspace-a" }
    ),
    /offline/
  );
  assert.deepEqual(
    fetches.map(({ url }) => url),
    ["https://login.microsoftonline.com/tenant/oauth2/v2.0/token"]
  );
});
