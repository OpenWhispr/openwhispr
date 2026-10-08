const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");
const { deferred } = require("./harness/deferred");

const bindings = [
  ...BYOK_API_KEYS.map((key) => ({ ...key, channel: `save-${key.base}-key` })),
  ...[
    ["corti-client-id", "cortiClientId", "saveCortiClientId"],
    ["corti-client-secret", "cortiClientSecret", "saveCortiClientSecret"],
    ["custom-transcription-key", "customTranscriptionApiKey", "saveCustomTranscriptionKey"],
    ["cleanup-custom-key", "cleanupCustomApiKey", "saveCleanupCustomKey"],
    ["bedrock-access-key-id", "bedrockAccessKeyId", "saveBedrockAccessKeyId"],
    ["bedrock-secret-access-key", "bedrockSecretAccessKey", "saveBedrockSecretAccessKey"],
    ["bedrock-session-token", "bedrockSessionToken", "saveBedrockSessionToken"],
    ["azure-api-key", "azureApiKey", "saveAzureApiKey"],
    ["vertex-api-key", "vertexApiKey", "saveVertexApiKey"],
  ].map(([channel, storeKey, save]) => ({
    channel: `save-${channel}`,
    storeKey,
    save,
    get: save.replace(/^save/, "get"),
  })),
];
const handlers = new Map();
const keys = new Map();
const notifications = [];
const editor = { id: 1 };
const windows = [1, 2, 3].map((id) => ({
  isDestroyed: () => id === 3,
  webContents: { id, send: (...args) => notifications.push([id, ...args]) },
}));
const mintToken = async (key) => `token-${key}`;
let fetchToken = mintToken;
const environmentManager = Object.fromEntries(
  bindings.flatMap(({ get, save, storeKey }) => [
    [get, () => keys.get(storeKey) || ""],
    [
      save,
      (key) => {
        keys.set(storeKey, key);
        return { success: true };
      },
    ],
  ])
);

// The warm-socket contract the real clients share: a warmup records its options
// only when it opens the socket (one already open or opening wins), cleanup
// forgets both, and connect rides a warm socket when one is there.
class FakeStreaming {
  warmToken = null;
  warmConnectionOptions = null;
  cachedToken = null;
  isConnected = false;
  rodeWarm = false;
  disconnects = 0;
  adoptMode() {}
  beginConnecting() {}
  setTokenRefreshFn() {}
  getCachedToken() {
    return this.cachedToken;
  }
  cacheToken(token) {
    this.cachedToken = token;
  }
  hasWarmConnection() {
    return this.warmToken !== null;
  }
  cleanupWarmConnection() {
    this.warmToken = null;
    this.warmConnectionOptions = null;
  }
  cleanupAll() {
    this.cleanupWarmConnection();
  }
  async warmup(options) {
    if (this.warmToken !== null) return;
    this.warmToken = options.token;
    this.warmConnectionOptions = options;
  }
  async connect({ token, apiKey }) {
    this.rodeWarm = this.warmToken !== null;
    this.token = this.warmToken || token || apiKey;
    this.warmToken = null;
    this.isConnected = true;
  }
  async disconnect() {
    this.disconnects += 1;
    this.isConnected = false;
    this.warmToken = null;
    return { text: "" };
  }
}
class FakeOrukeet extends FakeStreaming {}

const modulePath = require.resolve("../../src/helpers/ipcHandlers");
// Meetings resolve their streaming clients through this table instead.
const meetingProvidersPath = require.resolve("../../src/helpers/meetingStreamingProviders");
const streamingModules = [
  "./assemblyAiStreaming",
  "./deepgramStreaming",
  "./cortiStreaming",
  "./openaiRealtimeStreaming",
];
const originalLoad = Module._load;
const electron = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    on() {},
    isPackaged: false,
  },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {}, removeHandler() {} },
  BrowserWindow: {
    getAllWindows: () => windows,
    fromWebContents: () => windows[1],
  },
  net: {
    // BYOK mints present the saved key; managed ones present the account session.
    fetch: async (_url, init) => ({
      ok: true,
      json: async () => {
        const token = await fetchToken(init.headers.Authorization);
        return { token, clientSecret: token, clientSecrets: [token, token] };
      },
    }),
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
};
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
  if (parent?.filename === meetingProvidersPath) {
    if (streamingModules.includes(request)) return FakeStreaming;
    if (request === "./tinfoilRealtimeStreaming")
      return { TinfoilRealtimeStreaming: FakeStreaming };
  }
  if (parent?.filename === modulePath) {
    if (streamingModules.includes(request)) return FakeStreaming;
    if (request === "./orukeetStreaming")
      return { OrukeetStreaming: FakeOrukeet, MANAGED_STREAM_OPTIONS: {} };
    if (request === "./geminiLiveStreaming")
      return { GeminiLiveStreaming: FakeStreaming, GEMINI_LIVE_MODEL: "gemini-live" };
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./tokenStore")
      return {
        get: () => "account",
        getState: () => ({ token: "account", generation: 1 }),
        subscribe: () => () => {},
      };
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
});

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}
const target = {
  environmentManager,
  assemblyAiStreaming: null,
  deepgramStreaming: null,
  cortiStreaming: null,
  geminiStreaming: null,
  _dictationStreaming: null,
  _dictationConnectPromise: null,
  _dictationIdleTimer: null,
  _meetingMicStreaming: null,
  _meetingSystemStreaming: null,
  // A system audio tap on every platform, so each meeting opens two streams.
  audioTapManager: { isSupported: () => true, start: async () => {}, stop: async () => {} },
  _mintStoredCortiToken: async () => ({
    token: await fetchToken(environmentManager.getCortiClientSecret()),
    environment: "us",
    tenant: "base",
  }),
};
test.before(() => {
  const IPCHandlers = require(modulePath);
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});
const invoke = (channel, ...args) => handlers.get(channel)({ sender: editor }, ...args);

// Managed starts mint from the account, which needs an API URL.
function withManagedApi(t) {
  const previous = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previous;
  });
}

// Gemini keeps one connection, warm or live, so its start reports the reuse.
const rodeWarm = (provider, property, result) =>
  provider === "gemini" ? result.usedWarmConnection : target[property].rodeWarm;

test("every secret saver notifies peers by name only, including removal", () => {
  for (const { channel, storeKey, get } of bindings) {
    for (const value of ["secret-sentinel", ""]) {
      notifications.length = 0;
      assert.deepEqual(invoke(channel, value), { success: true });
      assert.equal(environmentManager[get](), value);
      assert.deepEqual(notifications, [[2, "api-key-updated", storeKey]]);
      notifications.length = 0;
      assert.deepEqual(invoke(channel, value), { success: true });
      assert.deepEqual(notifications, [], `${storeKey} re-saved unchanged`);
    }
  }
  assert.throws(
    () => invoke("save-custom-transcription-key", { key: "secret-sentinel" }),
    TypeError
  );
});

// provider, the instance it keeps, the saver of the key it reads, and the session
// token that key mints.
const STREAMING = [
  ["assemblyai", "assemblyAiStreaming", "save-assemblyai-key", (key) => `token-${key}`],
  ["deepgram", "deepgramStreaming", "save-deepgram-key", (key) => key],
  ["corti", "cortiStreaming", "save-corti-client-secret", (key) => `token-${key}`],
  ["gemini", "geminiStreaming", "save-gemini-key", (key) => key],
];

for (const [provider, property, saveChannel, tokenFor] of STREAMING) {
  test(`${provider}: a BYOK start rides the socket its warmup opened`, async () => {
    target[property] = null;
    invoke(saveChannel, "A");
    assert.deepEqual(await invoke(`${provider}-streaming-warmup`, { mode: "byok" }), {
      success: true,
    });
    const result = await invoke(`${provider}-streaming-start`, { mode: "byok" });
    assert.equal(result.success, true);
    assert.equal(rodeWarm(provider, property, result), true);
    assert.equal(target[property].token, tokenFor("A"));
  });

  test(`${provider}: a key saved after the warmup reaches the next start`, async () => {
    target[property] = null;
    invoke(saveChannel, "A");
    await invoke(`${provider}-streaming-warmup`, { mode: "byok" });
    invoke(saveChannel, "B");
    const result = await invoke(`${provider}-streaming-start`, { mode: "byok" });
    assert.equal(result.success, true);
    assert.equal(rodeWarm(provider, property, result), false);
    assert.equal(target[property].token, tokenFor("B"));
  });

  test(`${provider}: a warmup after a key save does not vouch for the socket it finds`, async () => {
    target[property] = null;
    invoke(saveChannel, "A");
    await invoke(`${provider}-streaming-warmup`, { mode: "byok" });
    invoke(saveChannel, "B");
    const warmup = await invoke(`${provider}-streaming-warmup`, { mode: "byok" });
    const result = await invoke(`${provider}-streaming-start`, { mode: "byok" });
    assert.equal(target[property].token, tokenFor("B"));
    // Gemini's warm connection is also its live one, so only a start replaces it.
    if (provider === "gemini") {
      assert.equal(warmup.alreadyWarm, true);
      assert.equal(rodeWarm(provider, property, result), false);
    } else {
      assert.deepEqual(warmup, { success: true });
      assert.equal(rodeWarm(provider, property, result), true);
    }
  });

  test(`${provider}: re-saving the unchanged key keeps the warm socket`, async () => {
    target[property] = null;
    invoke(saveChannel, "A");
    await invoke(`${provider}-streaming-warmup`, { mode: "byok" });
    invoke(saveChannel, "A");
    const result = await invoke(`${provider}-streaming-start`, { mode: "byok" });
    assert.equal(rodeWarm(provider, property, result), true);
    assert.equal(target[property].token, tokenFor("A"));
  });

  test(`${provider}: a key saved mid-session leaves the live session alone`, async () => {
    target[property] = null;
    invoke(saveChannel, "A");
    await invoke(`${provider}-streaming-warmup`, { mode: "byok" });
    await invoke(`${provider}-streaming-start`, { mode: "byok" });
    const live = target[property];
    invoke(saveChannel, "B");
    assert.equal(target[property], live);
    assert.equal(live.isConnected, true);
    assert.equal(live.disconnects, 0);
  });
}

for (const [provider, property, saveChannel] of STREAMING.filter(([name]) => name !== "corti")) {
  test(`${provider}: a key save leaves a managed warm socket in place`, async (t) => {
    withManagedApi(t);
    target[property] = null;
    assert.deepEqual(await invoke(`${provider}-streaming-warmup`, { mode: "openwhispr" }), {
      success: true,
    });
    invoke(saveChannel, "B");
    const result = await invoke(`${provider}-streaming-start`, { mode: "openwhispr" });
    assert.equal(result.success, true);
    assert.equal(rodeWarm(provider, property, result), true);
  });
}

for (const [provider, property, saveChannel] of STREAMING.filter(([name]) =>
  ["assemblyai", "corti"].includes(name)
)) {
  test(`${provider}: a key saved while the warmup mints is not ridden by the next start`, async (t) => {
    t.after(() => (fetchToken = mintToken));
    target[property] = null;
    invoke(saveChannel, "A");
    const minted = deferred();
    fetchToken = async (key) => {
      await minted.promise;
      return mintToken(key);
    };
    const warming = invoke(`${provider}-streaming-warmup`, { mode: "byok" });
    invoke(saveChannel, "B");
    minted.resolve();
    assert.deepEqual(await warming, { success: true });
    const result = await invoke(`${provider}-streaming-start`, { mode: "byok" });
    assert.equal(result.success, true);
    assert.equal(rodeWarm(provider, property, result), false);
    assert.equal(target[property].token, "token-B");
  });

  test(`${provider}: a start overlapping an old-key warmup does not ride its socket`, async (t) => {
    t.after(() => (fetchToken = mintToken));
    target[property] = null;
    invoke(saveChannel, "A");
    const minted = { A: deferred(), B: deferred() };
    fetchToken = async (key) => {
      await minted[key].promise;
      return mintToken(key);
    };
    const warming = invoke(`${provider}-streaming-warmup`, { mode: "byok" });
    invoke(saveChannel, "B");
    const starting = invoke(`${provider}-streaming-start`, { mode: "byok" });
    minted.A.resolve();
    // The old-key socket opens while the start is still minting with the new key.
    await warming;
    minted.B.resolve();
    const result = await starting;
    assert.equal(result.success, true);
    assert.equal(rodeWarm(provider, property, result), false);
    assert.equal(target[property].token, "token-B");
  });
}

test("assemblyai: a socket opened on the old key loses to the save, even when it wins the race", async (t) => {
  t.after(() => (fetchToken = mintToken));
  target.assemblyAiStreaming = null;
  invoke("save-assemblyai-key", "A");
  const minted = { A: deferred(), B: deferred() };
  fetchToken = async (key) => {
    await minted[key].promise;
    return mintToken(key);
  };
  const first = invoke("assemblyai-streaming-warmup", { mode: "byok" });
  invoke("save-assemblyai-key", "B");
  const second = invoke("assemblyai-streaming-warmup", { mode: "byok" });
  minted.A.resolve();
  await first;
  // The second warmup finds the first one's socket open and keeps it.
  minted.B.resolve();
  await second;
  const result = await invoke("assemblyai-streaming-start", { mode: "byok" });
  assert.equal(result.success, true);
  assert.equal(target.assemblyAiStreaming.rodeWarm, false);
  assert.equal(target.assemblyAiStreaming.token, "token-B");
});

test("gemini: a warm socket never crosses between managed and BYOK", async (t) => {
  withManagedApi(t);
  target.geminiStreaming = null;
  invoke("save-gemini-key", "A");
  await invoke("gemini-streaming-warmup", { mode: "openwhispr" });
  let result = await invoke("gemini-streaming-start", { mode: "byok" });
  assert.equal(result.usedWarmConnection, false);
  assert.equal(target.geminiStreaming.token, "A");
  await invoke("gemini-streaming-stop");
  await invoke("gemini-streaming-warmup", { mode: "byok" });
  result = await invoke("gemini-streaming-start", { mode: "openwhispr" });
  assert.equal(result.usedWarmConnection, false);
  assert.equal(target.geminiStreaming.token, "token-Bearer account");
});

// Tinfoil reads the saved key whatever the transcription mode says.
for (const [provider, saveChannel, mode] of [
  ["openai-realtime", "save-openai-key", "byok"],
  ["tinfoil-realtime", "save-tinfoil-key", "byok"],
  ["tinfoil-realtime", "save-tinfoil-key", "openwhispr"],
  ["orukeet", "save-custom-transcription-key", "byok"],
]) {
  const options = { mode, provider, baseUrl: "https://example.com/v1" };

  test(`${provider} (${mode}): a start rides the connection its warmup opened`, async (t) => {
    t.after(() => invoke("dictation-realtime-stop"));
    target._dictationStreaming = null;
    invoke(saveChannel, "A");
    assert.deepEqual(await invoke("dictation-realtime-warmup", options), { success: true });
    const warmed = target._dictationStreaming;
    assert.equal((await invoke("dictation-realtime-start", options)).success, true);
    assert.equal(target._dictationStreaming, warmed);
    assert.equal(warmed.token, "A");
  });

  test(`${provider} (${mode}): a key saved after the warmup reaches the next start`, async (t) => {
    t.after(() => invoke("dictation-realtime-stop"));
    target._dictationStreaming = null;
    invoke(saveChannel, "A");
    await invoke("dictation-realtime-warmup", options);
    const warmed = target._dictationStreaming;
    invoke(saveChannel, "B");
    assert.equal((await invoke("dictation-realtime-start", options)).success, true);
    assert.notEqual(target._dictationStreaming, warmed);
    assert.equal(target._dictationStreaming.token, "B");
  });

  test(`${provider} (${mode}): a key saved mid-session leaves the live session alone`, async (t) => {
    t.after(() => invoke("dictation-realtime-stop"));
    target._dictationStreaming = null;
    invoke(saveChannel, "A");
    await invoke("dictation-realtime-warmup", options);
    await invoke("dictation-realtime-start", options);
    const live = target._dictationStreaming;
    invoke(saveChannel, "B");
    assert.equal(target._dictationStreaming, live);
    assert.equal(live.isConnected, true);
    assert.equal(live.disconnects, 0);
  });
}

test("openai-realtime: a key save leaves a managed warm connection in place", async (t) => {
  withManagedApi(t);
  t.after(() => invoke("dictation-realtime-stop"));
  const options = { mode: "openwhispr", provider: "openai-realtime" };
  target._dictationStreaming = null;
  assert.deepEqual(await invoke("dictation-realtime-warmup", options), { success: true });
  const warmed = target._dictationStreaming;
  invoke("save-openai-key", "B");
  assert.equal((await invoke("dictation-realtime-start", options)).success, true);
  assert.equal(target._dictationStreaming, warmed);
});

test("an unknown realtime provider still fails closed", async () => {
  const result = await invoke("dictation-realtime-warmup", { mode: "byok", provider: "unknown" });
  assert.equal(result.success, false);
  assert.match(result.error, /Unsupported realtime token provider/);
});

// provider, the saver of the key both meeting streams authenticate with, the mode,
// and the session token that key mints. Corti and Tinfoil read their saved
// credentials whatever the mode says.
const MEETING = [
  ["openai-realtime", "save-openai-key", "byok", (key) => key],
  ["assemblyai-realtime", "save-assemblyai-key", "byok", (key) => `token-${key}`],
  ["deepgram-realtime", "save-deepgram-key", "byok", (key) => key],
  ["corti-realtime", "save-corti-client-secret", "byok", (key) => `token-${key}`],
  ["tinfoil-realtime", "save-tinfoil-key", "byok", (key) => key],
  ["corti-realtime", "save-corti-client-secret", "openwhispr", (key) => `token-${key}`],
  ["tinfoil-realtime", "save-tinfoil-key", "openwhispr", (key) => key],
];
const meetingStreams = () => [target._meetingMicStreaming, target._meetingSystemStreaming];
const assertMeetingStreams = ([mic, system]) => {
  assert.equal(target._meetingMicStreaming, mic);
  assert.equal(target._meetingSystemStreaming, system);
};
const resetMeeting = (t) => {
  t.after(() => invoke("meeting-transcription-stop"));
  target._meetingMicStreaming = null;
  target._meetingSystemStreaming = null;
};

for (const [provider, saveChannel, mode, tokenFor] of MEETING) {
  const options = { provider, mode };

  test(`${provider} (${mode}): a meeting start rides the connections its prepare opened`, async (t) => {
    resetMeeting(t);
    invoke(saveChannel, "A");
    assert.deepEqual(await invoke("meeting-transcription-prepare", options), { success: true });
    const prepared = meetingStreams();
    assert.equal((await invoke("meeting-transcription-start", options)).success, true);
    assertMeetingStreams(prepared);
    for (const streaming of prepared) assert.equal(streaming.token, tokenFor("A"));
  });

  test(`${provider} (${mode}): a key saved between meeting prepare and start reaches the meeting`, async (t) => {
    resetMeeting(t);
    invoke(saveChannel, "A");
    await invoke("meeting-transcription-prepare", options);
    invoke(saveChannel, "B");
    assert.equal((await invoke("meeting-transcription-start", options)).success, true);
    for (const streaming of meetingStreams()) assert.equal(streaming.token, tokenFor("B"));
  });
}

for (const [provider, saveChannel, mode] of MEETING.filter(([name]) =>
  ["assemblyai-realtime", "corti-realtime"].includes(name)
)) {
  test(`${provider} (${mode}): a key saved while the meeting prepare mints is not ridden by the start`, async (t) => {
    t.after(() => (fetchToken = mintToken));
    resetMeeting(t);
    const options = { provider, mode };
    invoke(saveChannel, "A");
    const minting = deferred();
    const minted = deferred();
    fetchToken = async (key) => {
      minting.resolve();
      await minted.promise;
      return mintToken(key);
    };
    const preparing = invoke("meeting-transcription-prepare", options);
    // The prepare has read the old key and is waiting on its session token.
    await minting.promise;
    invoke(saveChannel, "B");
    minted.resolve();
    assert.deepEqual(await preparing, { success: true });
    assert.equal((await invoke("meeting-transcription-start", options)).success, true);
    for (const streaming of meetingStreams()) assert.equal(streaming.token, "token-B");
  });
}

// Corti and Tinfoil never open a managed connection.
for (const [provider, saveChannel] of MEETING.filter(
  ([name]) => !["corti-realtime", "tinfoil-realtime"].includes(name)
)) {
  test(`${provider}: a key save leaves a managed prepared meeting in place`, async (t) => {
    withManagedApi(t);
    resetMeeting(t);
    const options = { provider, mode: "openwhispr" };
    assert.deepEqual(await invoke("meeting-transcription-prepare", options), { success: true });
    const prepared = meetingStreams();
    invoke(saveChannel, "B");
    assert.equal((await invoke("meeting-transcription-start", options)).success, true);
    assertMeetingStreams(prepared);
  });
}

test("a key saved mid-meeting leaves the live meeting alone", async (t) => {
  resetMeeting(t);
  invoke("save-deepgram-key", "A");
  const options = { provider: "deepgram-realtime", mode: "byok" };
  assert.equal((await invoke("meeting-transcription-start", options)).success, true);
  const live = meetingStreams();
  invoke("save-deepgram-key", "B");
  assertMeetingStreams(live);
  for (const streaming of live) {
    assert.equal(streaming.isConnected, true);
    assert.equal(streaming.disconnects, 0);
  }
});

test("a prepare after a mid-meeting renewal leaves the live meeting alone", async (t) => {
  resetMeeting(t);
  invoke("save-deepgram-key", "A");
  const options = { provider: "deepgram-realtime", mode: "byok" };
  await invoke("meeting-transcription-start", options);
  const [mic] = meetingStreams();
  mic.onSessionExpired({ proactive: true });
  await new Promise(setImmediate);
  const renewed = meetingStreams();
  assert.notEqual(renewed[0], mic);
  assert.deepEqual(await invoke("meeting-transcription-prepare", options), {
    success: true,
    alreadyPrepared: true,
  });
  assertMeetingStreams(renewed);
});
