const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { once } = require("node:events");
const { execFileSync, spawnSync } = require("node:child_process");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Registers the real handlers against a fake `this` with the enterprise identity
// manager replaced, so scope, meeting and token-exchange wiring is observable.
const handlers = new Map();
const fetches = [];
let identityOptions;
let configSnapshot;
const unmanagedWorkspace = ({ accountId, expectedAuthGeneration }) => ({
  success: true,
  managed: false,
  accountId,
  authGeneration: expectedAuthGeneration,
});

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
          getPolicy: unmanagedWorkspace,
          getCachedPolicy: unmanagedWorkspace,
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
let audioCredentials;
let stops = 0;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const target = {};
  fakeThis = new Proxy(target, { get: (t, prop) => (prop in t ? t[prop] : anything()) });
  Ctor.prototype.setupHandlers.call(withDevicePolicy(fakeThis));
  audioCredentials = fakeThis.enterpriseAudioCredentials;
  fakeThis.effectivePolicyManager.updateWorkspace({
    success: true,
    managed: false,
    accountId: "account-a",
    authGeneration: 1,
  });
  target._stopMeetingForPolicy = () => stops++;
  target._audioFeaturePolicy = {
    update: () => {},
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

test(
  "managed dictation uploads follow native transcription policy",
  {
    skip: spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0,
    timeout: 15_000,
  },
  async (t) => {
    const { normalizeDeviceValues } = require("../../src/helpers/managedDevicePolicy");
    const Ctor = require(handlersModulePath);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "managed-upload-tls-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const key = path.join(directory, "key.pem");
    const certificate = path.join(directory, "certificate.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        certificate,
      ],
      { stdio: "ignore" }
    );
    const cert = fs.readFileSync(certificate, "utf8");
    for (const name of [
      "_stopRemoteProductWork",
      "_retireDisallowedProductWork",
      "_startRemoteProductWork",
    ])
      fakeThis[name] = Ctor.prototype[name].bind(fakeThis);
    fakeThis._remoteCalendarsReady = false;
    fakeThis.enterpriseAudioCredentials = audioCredentials;
    audioCredentials.read = async () => "synthetic-test-key";
    const transportRequest = fakeThis.enterpriseAudioTransport.request;
    for (const change of ["local-only", "provider-removed", "allowed", "llm-only"]) {
      await t.test(change, async (t) => {
        let received = 0;
        let incoming, requestSignal, closedBeforeEnd;
        let { promise: started, resolve: firstData } = Promise.withResolvers();
        const { promise: closed, resolve: requestClosed } = Promise.withResolvers();
        const server = https.createServer({ key: fs.readFileSync(key), cert }, (req, res) => {
          incoming = req;
          req.on("data", (chunk) => {
            received += chunk.length;
            if (firstData) {
              req.pause();
              firstData();
              firstData = null;
            }
          });
          req.on("end", () => res.end(JSON.stringify({ text: "synthetic transcript" })));
          req.on("close", () => {
            closedBeforeEnd = !req.complete;
            requestClosed();
          });
          req.on("error", () => {});
        });
        t.after(() => {
          server.closeAllConnections();
          return new Promise((resolve) => server.close(resolve));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        let device = normalizeDeviceValues({ RequireSignIn: true });
        fakeThis.managedDevicePolicy.getSnapshot = () => device;
        fakeThis.effectivePolicyManager.getCurrent();
        fakeThis._enterpriseAudioScopeRevision = 0;
        fakeThis._enterpriseAudioBinding = {
          accountId: "account-a",
          workspaceId: "workspace-a",
          authGeneration: 1,
          generation: 1,
        };
        fakeThis.enterpriseIdentityManager.resolveProvider = async () => ({
          managed: true,
          provider: "openai-compatible",
          generation: 1,
          version: 1,
          identity: { accountId: "account-a", workspaceId: "workspace-a" },
          certificateBundles: [{ id: "test-ca", pem: cert }],
          config: {
            generation: 1,
            batch: {
              endpoint: `https://127.0.0.1:${server.address().port}/transcribe`,
              defaultDeployment: "speech",
              maxUploadBytes: 32 * 1024 * 1024,
              authentication: { type: "bearer", credentialSlot: "synthetic-key" },
            },
            network: { caBundleId: "test-ca", proxy: { mode: "direct" }, httpTimeoutMs: 10_000 },
          },
        });
        fakeThis.enterpriseAudioTransport.request = (url, init) => {
          requestSignal = init.signal;
          return transportRequest(url, init);
        };
        const audioBuffer = Buffer.alloc(16 * 1024 * 1024, 97);
        const pending = handlers.get("managed-transcribe")(event, {
          audioBuffer,
          fileName: "audio.wav",
          mimeType: "audio/wav",
          managed: {
            provider: "openai-compatible",
            context: {
              accountId: "account-a",
              workspaceId: "workspace-a",
              authGeneration: 1,
              generation: 1,
              provider: "openai-compatible",
              providerVersion: 1,
              inferenceScope: "transcription",
            },
          },
        });
        await started;
        const bytesBefore = received;
        if (change === "local-only") device = normalizeDeviceValues({ RequireSignIn: false });
        if (change === "provider-removed")
          device.policy.transcription.allowedEnterpriseProviders = [];
        if (change === "llm-only") device.policy.llm.allowedEnterpriseProviders = [];
        fakeThis.effectivePolicyManager.getCurrent();
        await new Promise((resolve) => setTimeout(resolve, 50));
        incoming.resume();
        const [result] = await Promise.all([pending, closed]);
        t.diagnostic(
          JSON.stringify({
            change,
            bytesBefore,
            received,
            aborted: requestSignal.aborted,
            closedBeforeEnd,
            result,
          })
        );
        const revoked = ["local-only", "provider-removed"].includes(change);
        assert.equal(requestSignal.aborted, revoked);
        assert.equal(closedBeforeEnd, revoked);
        if (revoked) {
          assert.ok(received < audioBuffer.length, "connection closes before the full upload");
          assert.equal(result.code, "DEVICE_POLICY_BLOCKED");
          assert.equal(result.text, undefined);
        } else {
          assert.ok(received > audioBuffer.length, "the complete multipart upload arrives");
          assert.deepEqual(result, { text: "synthetic transcript" });
        }
      });
    }
  }
);
