const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { managedPolicy } = require("./harness/policyFixtures");
const { deferred } = require("./harness/deferred");
const { withDevicePolicy } = require("./harness/devicePolicy");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-model-wiring-"));
process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";

// The policy manager keeps its own clock; this moves it past its freshness
// window and attempt throttle without waiting for them.
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advanceClock = (milliseconds) => {
  clockOffset += milliseconds;
};
const SIX_MINUTES = 6 * 60 * 1000;

// The real constructor wiring (_initLocalModelPolicy), token and scope handlers,
// main policy lookup, policy manager, cache and binding file. Only the network,
// the token store and the native servers are stand-ins.
const handlers = new Map();
let tokenState = { token: null, generation: 0 };
let policyFetch = async () => {
  throw new Error("offline");
};
const fetchedHeaders = [];

const electronStub = {
  app: {
    getPath: () => userDataDirectory,
    getName: () => "test",
    getVersion: () => "1.11.1",
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
    fetch: (url, init) => {
      if (String(url).endsWith("/api/workspace-policy")) {
        fetchedHeaders.push(init.headers);
        return policyFetch(init);
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
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
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        subscribe: () => () => {},
      };
    }
    if (request === "./windowBroadcast") return { broadcastToWindows: () => {} };
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

const settle = async () => {
  for (let turn = 0; turn < 8; turn++) await new Promise((done) => setImmediate(done));
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
const unmanaged = () => json({ data: { managed: false, policy: null, policyUpdatedAt: null } });
const managed = (allowedLocalModels, updatedAt = "2026-11-02T00:00:00.000Z") =>
  json({
    data: {
      managed: true,
      policyUpdatedAt: updatedAt,
      policy: managedPolicy({
        transcription: { allowedModes: ["local"], allowedLocalModels },
        llm: { allowedModes: ["local"], allowedLocalModels },
      }),
    },
  });

const LLM_MODEL = "qwen3.5-0.8b-q4_k_m";

function nativeServer() {
  return {
    stops: 0,
    isRemote: false,
    async stop() {
      this.stops++;
      this.modelPath = null;
      this.modelName = null;
    },
  };
}

function build({ device } = {}) {
  const whisperServer = Object.assign(nativeServer(), { modelPath: "/models/ggml-base.bin" });
  const parakeetServer = Object.assign(nativeServer(), { modelName: "parakeet-tdt-0.6b-v3" });
  const llamaServer = Object.assign(nativeServer(), { modelPath: null });
  const database = {
    activeAccountId: null,
    setActiveAccountId(accountId) {
      this.activeAccountId = accountId;
    },
  };
  const stoppedMeetings = [];
  const target = {
    sessionId: "test-session",
    databaseManager: new Proxy(database, {
      get: (value, property) => (property in value ? value[property] : anything()),
    }),
    whisperManager: {
      serverManager: whisperServer,
      getModelPath: (id) => `/models/ggml-${id}.bin`,
    },
    parakeetManager: {
      serverManager: { wsServer: parakeetServer },
      getModelPath: (id) => `/models/${id}`,
    },
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
    _activeEnterpriseAudioMeeting: false,
    _activeLocalMeetingLease: null,
  };
  const fakeThis = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
  const llmManager = { serverManager: llamaServer, getModelsDir: () => "/llm" };

  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype._initLocalModelPolicy.call(fakeThis, llmManager);
  withDevicePolicy(fakeThis);
  if (device) target.managedDevicePolicy = { getSnapshot: () => device, subscribe: () => () => {} };
  Ctor.prototype.setupHandlers.call(fakeThis);
  target._stopMeetingForPolicy = (reason) => stoppedMeetings.push(reason);
  clearInterval(target._localModelPolicyRefreshTimer);

  const servers = [whisperServer, parakeetServer];
  return {
    target,
    gate: target._localModelPolicy,
    whisperServer,
    parakeetServer,
    llamaServer,
    database,
    stoppedMeetings,
    stops: () => servers.reduce((sum, server) => sum + server.stops, 0),
    tokenChanged: (state) => {
      tokenState = state;
      Ctor.prototype._handleAuthTokenChange.call(fakeThis, state);
    },
    setScope: (accountId) =>
      handlers.get("set-active-account-scope")({}, accountId, tokenState.generation),
    teardown() {
      target.metaActivation?.dispose?.();
    },
  };
}

// Signed in as one account with its verdict held, the way a running app is.
async function signedIn(t, { token = "token-a", generation = 1, account = "account-a", policy }) {
  tokenState = { token: null, generation: generation - 1 };
  fetchedHeaders.length = 0;
  fs.rmSync(path.join(userDataDirectory, "workspace-policy.json"), { force: true });
  const app = build();
  t.after(() => app.teardown());
  policyFetch = async () => policy();
  tokenState = { token, generation };
  assert.deepEqual(await app.setScope(account), { success: true });
  await settle();
  await app.gate.resolve();
  await settle();
  app.stoppedMeetings.length = 0;
  return app;
}

test.after(() => {
  Date.now = realNow;
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

for (const [label, policy] of [
  ["an unmanaged user", unmanaged],
  ["a managed user whose model is approved", () => managed(["base", "parakeet-tdt-0.6b-v3"])],
]) {
  test(`token rotation stops and aborts nothing for ${label}`, async (t) => {
    const app = await signedIn(t, { policy });
    const job = await app.gate.authorize("transcription", "base");
    app.target._activeLocalMeetingLease = await app.gate.authorize("transcription", "base");
    const answer = deferred();
    policyFetch = () => answer.promise;

    app.tokenChanged({ token: "token-rotated", generation: 2 });
    await app.setScope("account-a");
    await settle();

    assert.equal(job.signal.aborted, false);
    assert.doesNotThrow(() => app.gate.assertCurrent(job));
    assert.equal(app.stops(), 0);
    assert.deepEqual(app.stoppedMeetings, []);
    // New work waits for the rotated credential's verdict.
    assert.equal(app.gate.failure("transcription", "base").code, "POLICY_UNRESOLVABLE");

    answer.resolve(policy());
    await settle();
    assert.equal(app.gate.failure("transcription", "base"), null);
    assert.equal(job.signal.aborted, false);
    assert.equal(app.stops(), 0);
    assert.deepEqual(app.stoppedMeetings, []);
  });
}

test("a denial from the rotated credential's re-resolve aborts work and stops the server", async (t) => {
  const app = await signedIn(t, { policy: unmanaged });
  const job = await app.gate.authorize("transcription", "base");
  app.target._activeLocalMeetingLease = await app.gate.authorize("transcription", "base");
  const answer = deferred();
  policyFetch = () => answer.promise;

  app.tokenChanged({ token: "token-rotated", generation: 2 });
  await settle();
  assert.equal(app.stops(), 0);

  answer.resolve(managed([]));
  await settle();

  assert.equal(job.signal.reason?.code, "POLICY_MODEL_BLOCKED");
  assert.equal(app.whisperServer.stops, 1);
  assert.equal(app.parakeetServer.stops, 1);
  assert.equal(app.stoppedMeetings[0], "POLICY_MODEL_BLOCKED");
});

test("an unresolved verdict never stops a server, even with none ever held", async (t) => {
  fs.rmSync(path.join(userDataDirectory, "workspace-policy.json"), { force: true });
  tokenState = { token: "token-a", generation: 1 };
  const app = build();
  t.after(() => app.teardown());
  policyFetch = async () => {
    throw new Error("offline");
  };

  await assert.rejects(app.gate.resolve(), { code: "POLICY_UNRESOLVABLE" });
  app.tokenChanged({ token: "token-b", generation: 2 });
  await settle();

  assert.equal(app.stops(), 0);
  assert.equal(app.gate.failure("transcription", "base").code, "POLICY_UNRESOLVABLE");
});

test("switching accounts cancels old-account work before the new verdict, which then decides", async (t) => {
  const app = await signedIn(t, { policy: unmanaged });
  const oldAccountJob = await app.gate.authorize("transcription", "base");
  const delayedOldAnswer = deferred();
  policyFetch = () => delayedOldAnswer.promise;
  advanceClock(SIX_MINUTES);
  void app.gate.resolve();
  await settle();

  const newAnswer = deferred();
  policyFetch = () => newAnswer.promise;
  app.tokenChanged({ token: "token-of-b", generation: 2 });
  await settle();
  assert.equal(oldAccountJob.signal.aborted, false, "a new bearer alone isn't a known switch");

  await app.setScope("account-b");
  assert.equal(oldAccountJob.signal.reason?.code, "POLICY_UNRESOLVABLE");
  assert.equal(app.stops(), 0, "nothing is known about account B yet");

  // Account A's answer, arriving late, can't authorize account B.
  delayedOldAnswer.resolve(unmanaged());
  await settle();
  assert.equal(app.gate.failure("transcription", "base").code, "POLICY_UNRESOLVABLE");

  newAnswer.resolve(managed([]));
  await settle();
  assert.equal(app.gate.failure("transcription", "base").code, "POLICY_MODEL_BLOCKED");
  assert.equal(app.whisperServer.stops, 1);
});

test("clearing a session that never existed leaves a guest's running work alone", async (t) => {
  tokenState = { token: null, generation: 40 };
  const app = build();
  t.after(() => app.teardown());
  await settle();
  const job = await app.gate.authorize("transcription", "base");

  app.tokenChanged({ token: null, generation: 41 });

  assert.equal(job.signal.aborted, false);
  assert.equal(app.gate.failure("transcription", "base"), null);
  assert.deepEqual(app.stoppedMeetings, [], "a guest's meeting keeps recording");
  app.gate.release(job);
});

test("signing out cancels running work; the guest it leaves can start new work", async (t) => {
  const app = await signedIn(t, {
    policy: () => managed(["base", "parakeet-tdt-0.6b-v3"]),
  });
  const job = await app.gate.authorize("transcription", "base");
  app.target._activeLocalMeetingLease = await app.gate.authorize("transcription", "base");
  policyFetch = async () => {
    throw new Error("a guest makes no policy request");
  };
  await settle();
  fetchedHeaders.length = 0;

  app.tokenChanged({ token: null, generation: 2 });

  assert.equal(job.signal.reason?.code, "POLICY_UNRESOLVABLE");
  assert.deepEqual(app.stoppedMeetings, ["accountChanged"]);
  assert.equal(app.stops(), 0);
  assert.equal(app.gate.failure("transcription", "small"), null);
  await settle();
  assert.equal(fetchedHeaders.length, 0);
});

test("a guest signing in keeps running work until the account's verdict decides it", async (t) => {
  tokenState = { token: null, generation: 0 };
  fs.rmSync(path.join(userDataDirectory, "workspace-policy.json"), { force: true });
  const app = build();
  t.after(() => app.teardown());
  await app.gate.resolve();
  const guestJob = await app.gate.authorize("transcription", "base");
  const answer = deferred();
  policyFetch = () => answer.promise;

  app.tokenChanged({ token: "token-a", generation: 1 });
  await app.setScope("account-a");
  await settle();
  assert.equal(guestJob.signal.aborted, false);
  assert.equal(app.stops(), 0);
  assert.deepEqual(app.stoppedMeetings, [], "a guest's meeting keeps recording");

  answer.resolve(managed([]));
  await settle();
  assert.equal(guestJob.signal.reason?.code, "POLICY_MODEL_BLOCKED");
  assert.equal(app.whisperServer.stops, 1);
});

test("a blackholed network answers from the held verdict; the refresh's denial still lands", async (t) => {
  const app = await signedIn(t, { policy: unmanaged });
  const job = await app.gate.authorize("transcription", "base");
  const answer = deferred();
  let requests = 0;
  policyFetch = () => {
    requests++;
    return answer.promise;
  };

  advanceClock(SIX_MINUTES);
  const startedAt = performance.now();
  app.gate.release(await app.gate.authorize("transcription", "base"));
  app.gate.release(await app.gate.authorize("transcription", "base"));
  assert.ok(performance.now() - startedAt < 100);
  await settle();
  assert.equal(requests, 1);
  assert.equal(job.signal.aborted, false);

  answer.resolve(managed([]));
  await settle();
  assert.equal(job.signal.reason?.code, "POLICY_MODEL_BLOCKED");
  assert.equal(app.whisperServer.stops, 1);
});

test("offline, a rotated token keeps its account's verdict; another account gets nothing", async (t) => {
  const app = await signedIn(t, { policy: () => managed(["base"]) });
  policyFetch = async () => {
    throw new Error("offline");
  };

  app.tokenChanged({ token: "token-rotated", generation: 2 });
  await app.setScope("account-a");
  await settle();
  app.gate.release(await app.gate.authorize("transcription", "base"));
  await assert.rejects(app.gate.authorize("transcription", "small"), {
    code: "POLICY_MODEL_BLOCKED",
  });

  app.tokenChanged({ token: "token-of-b", generation: 3 });
  await app.setScope("account-b");
  await settle();
  await assert.rejects(app.gate.authorize("transcription", "base"), {
    code: "POLICY_UNRESOLVABLE",
  });
});

test("the periodic refresh fetches when signed in and makes no request for a proven guest", async (t) => {
  const app = await signedIn(t, { policy: unmanaged });
  fetchedHeaders.length = 0;
  // Past the attempt throttle, but well inside the five-minute freshness window.
  advanceClock(60_000);
  await app.gate.resolve({ refresh: true });
  assert.equal(fetchedHeaders.length, 1);

  tokenState = { token: null, generation: 10 };
  const guest = build();
  t.after(() => guest.teardown());
  fetchedHeaders.length = 0;
  await guest.gate.resolve({ refresh: true });
  await guest.gate.resolve({ refresh: true });
  assert.equal(fetchedHeaders.length, 0);
  assert.equal(guest.gate.failure("transcription", "base"), null);
});

test("no first policy answer is taken while registering handlers", async (t) => {
  tokenState = { token: null, generation: 20 };
  const app = build();
  t.after(() => app.teardown());
  await settle();
  assert.equal(
    app.gate.failure("transcription", "base").code,
    "POLICY_UNRESOLVABLE",
    "a session waiting for its bearer migration isn't a proven guest yet"
  );
});

test("with no window, a cookie session in the default session isn't a proven guest", async (t) => {
  electronStub.session.defaultSession = {
    cookies: { get: async () => [{ name: "openwhispr.session_token", value: "legacy" }] },
  };
  t.after(() => {
    delete electronStub.session.defaultSession;
  });
  tokenState = { token: null, generation: 30 };
  const app = build();
  t.after(() => app.teardown());
  policyFetch = async () => managed([]);
  fetchedHeaders.length = 0;

  const IPCHandlers = require(handlersModulePath);
  (IPCHandlers.default || IPCHandlers).prototype.loadLocalModelPolicy.call(app.target);
  await settle();

  assert.equal(fetchedHeaders[0]?.Cookie, "openwhispr.session_token=legacy");
  assert.equal(app.gate.failure("transcription", "base").code, "POLICY_MODEL_BLOCKED");
});

test("cookies with no session in them prove a guest, without asking the API", async (t) => {
  electronStub.session.defaultSession = {
    cookies: { get: async () => [{ name: "stray", value: "x" }] },
  };
  t.after(() => {
    delete electronStub.session.defaultSession;
  });
  tokenState = { token: null, generation: 31 };
  const app = build();
  t.after(() => app.teardown());
  policyFetch = async () => {
    throw new Error("offline");
  };
  fetchedHeaders.length = 0;

  const IPCHandlers = require(handlersModulePath);
  (IPCHandlers.default || IPCHandlers).prototype.loadLocalModelPolicy.call(app.target);
  await settle();

  assert.equal(app.gate.failure("transcription", "base"), null);
  assert.equal(fetchedHeaders.length, 0);
});

test("a session cookie the API rejects is over, so that guest keeps local models", async (t) => {
  electronStub.session.defaultSession = {
    cookies: { get: async () => [{ name: "openwhispr.session_token", value: "expired" }] },
  };
  t.after(() => {
    delete electronStub.session.defaultSession;
  });
  tokenState = { token: null, generation: 33 };
  const app = build();
  t.after(() => app.teardown());
  policyFetch = async () => json({ error: "No session" }, 401);

  const IPCHandlers = require(handlersModulePath);
  (IPCHandlers.default || IPCHandlers).prototype.loadLocalModelPolicy.call(app.target);
  await settle();

  assert.equal(app.gate.failure("transcription", "base"), null);
});

test("other lookup failures don't prove a session cookie holder is a guest", async (t) => {
  electronStub.session.defaultSession = {
    cookies: { get: async () => [{ name: "openwhispr.session_token", value: "unreachable" }] },
  };
  t.after(() => {
    delete electronStub.session.defaultSession;
  });
  tokenState = { token: null, generation: 32 };
  const app = build();
  t.after(() => app.teardown());
  policyFetch = async () => json({}, 503);

  const IPCHandlers = require(handlersModulePath);
  (IPCHandlers.default || IPCHandlers).prototype.loadLocalModelPolicy.call(app.target);
  await settle();

  assert.equal(app.gate.failure("transcription", "base").code, "POLICY_UNRESOLVABLE");
});

test("a device policy's local model allow-list applies to a guest", async (t) => {
  const { normalizeDeviceValues } = require("../../src/helpers/managedDevicePolicy");
  tokenState = { token: null, generation: 50 };
  const policy = managedPolicy({
    transcription: { allowedModes: ["local"], allowedLocalModels: ["small"] },
    llm: { allowedModes: ["local"] },
  });
  const app = build({
    device: normalizeDeviceValues({ Policy: JSON.stringify(policy), RequireSignIn: false }),
  });
  t.after(() => app.teardown());

  await assert.rejects(app.gate.authorize("transcription", "base"), {
    code: "POLICY_MODEL_BLOCKED",
  });
  app.gate.release(await app.gate.authorize("transcription", "small"));
});

test("startup loads the policy after the bearer migration", () => {
  const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const migration = main.indexOf("await migrateCookieToBearerToken();");
  const load = main.indexOf("ipcHandlers.loadLocalModelPolicy();");
  assert.ok(migration >= 0 && load > migration);
  assert.ok(load < main.indexOf("whisperManager.initializeAtStartup"));
});
