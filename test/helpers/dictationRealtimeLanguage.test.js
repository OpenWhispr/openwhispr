const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");

// #2050: the dictation language must reach the realtime session on every path
// the dictation-realtime-* handlers own — the BYOK session.update, the cloud
// token request, and a warm connection minted for a different language.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();
const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on() {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => listeners.set(channel, handler),
    removeHandler() {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class {
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

const calls = { connects: [], disconnects: [], tokens: [], audio: [], sent: [], instances: [] };
let nextInstance = 0;
let tokenGate = null;

class FakeRealtimeStreaming {
  constructor() {
    this.id = ++nextInstance;
    this.isConnected = false;
    this.options = null;
    calls.instances.push(this);
  }
  beginConnecting() {}
  async connect(options) {
    this.options = options;
    this.isConnected = true;
    calls.connects.push({ id: this.id, options });
  }
  async disconnect({ commit = true } = {}) {
    this.isConnected = false;
    calls.disconnects.push({ id: this.id, commit });
    return { text: "" };
  }
  sendAudio() {
    calls.audio.push(this.id);
    return true;
  }
}
FakeRealtimeStreaming.normalizeLanguage =
  require("../../src/helpers/openaiRealtimeStreaming").normalizeLanguage;

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./sarvamRealtimeStreaming") {
      return { SarvamRealtimeStreaming: class extends FakeRealtimeStreaming {} };
    }
    if (request === "./sarvamTranscription") {
      return { transcribeWithSarvam: async () => ({ text: "batch transcript" }) };
    }
    if (request === "./openaiRealtimeStreaming") return FakeRealtimeStreaming;
    if (request === "./realtimeTokenProviders") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        fetchRealtimeTokenForProvider: async (provider, _deps, options) => {
          calls.tokens.push({ provider, options });
          await tokenGate?.promise;
          return "secret";
        },
      };
    }
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

function scenario(t) {
  for (const record of Object.values(calls)) record.length = 0;
  // Seed the constructor's dictation fields: the proxy's catch-all would make
  // `this._dictationStreaming?.isConnected` truthy on a cold start.
  const target = {
    _dictationStreaming: null,
    _dictationConnectPromise: null,
    _dictationIdleTimer: null,
    _dictationPreviewEnabled: false,
    environmentManager: new Proxy(
      { getSarvamKey: () => "test-key" },
      {
        get: (value, property) => value[property] ?? anything(),
      }
    ),
    windowManager: { hideTranscriptionPreview() {}, showTranscriptionPreview() {} },
  };
  const IPCHandlers = require(handlersModulePath);
  IPCHandlers.prototype.setupHandlers.call(
    withDevicePolicy(
      new Proxy(target, {
        get: (value, property) => (property in value ? value[property] : anything()),
      })
    )
  );
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    send: (channel, payload) => calls.sent.push({ channel, payload }),
  });
  const event = { sender };
  const invoke = (channel, options) => {
    if (channel === "dictation-realtime-start" && options?.sarvamCaptureId)
      listeners.get("dictation-realtime-reserve")(event, options.sarvamCaptureId);
    return handlers.get(channel)(event, options);
  };
  const sendAudio = () => listeners.get("dictation-realtime-send")(event, new Uint8Array(4));
  t.after(() => invoke("dictation-realtime-stop"));
  return { invoke, sendAudio, sender, target };
}

const byok = (overrides) => ({
  provider: "openai-realtime",
  mode: "byok",
  model: "gpt-4o-mini-transcribe",
  language: "de",
  ...overrides,
});

test("a cold BYOK start passes the dictation language to the realtime session", async (t) => {
  const s = scenario(t);
  assert.deepEqual(await s.invoke("dictation-realtime-start", byok()), { success: true });
  assert.equal(calls.connects.length, 1);
  assert.equal(calls.connects[0].options.language, "de");
  assert.equal(calls.connects[0].options.model, "gpt-4o-mini-transcribe");
  assert.equal(calls.connects[0].options.preconfigured, false);
});

test("a cloud start sends the language with the token request and leaves the model to the server", async (t) => {
  const s = scenario(t);
  await s.invoke(
    "dictation-realtime-start",
    byok({ mode: "openwhispr", model: "gpt-4o-transcribe", language: "de" })
  );
  assert.equal(calls.tokens.length, 1);
  assert.equal(calls.tokens[0].provider, "openai-realtime");
  assert.equal(calls.tokens[0].options.language, "de");
  // The server owns the managed dictation model; a stale non-OpenAI id in
  // settings must not reach the client-secret request.
  assert.equal("model" in calls.tokens[0].options, false);
  assert.equal(calls.connects[0].options.preconfigured, true);
});

test("the cloud token request carries the base language code and leaves it unset for auto", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-start", byok({ mode: "openwhispr", language: "zh-TW" }));
  await s.invoke("dictation-realtime-stop");
  await s.invoke("dictation-realtime-start", byok({ mode: "openwhispr", language: "auto" }));
  assert.equal(calls.tokens[0].options.language, "zh");
  assert.equal("language" in calls.tokens[1].options, true);
  assert.equal(calls.tokens[1].options.language, undefined);
  await s.invoke("dictation-realtime-stop");
  await s.invoke("dictation-realtime-start", byok({ mode: "openwhispr", language: "brx" }));
  assert.equal(calls.tokens[2].options.language, undefined);
});

test("the tinfoil branch keeps its language-free connect (voxtral support is unverified)", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-start", byok({ provider: "tinfoil-realtime" }));
  assert.equal(calls.connects.length, 1);
  assert.equal("language" in calls.connects[0].options, false);
});

test("Cloud dictation ignores a saved personal model when minting and reusing its token", async (t) => {
  const s = scenario(t);
  await s.invoke(
    "dictation-realtime-warmup",
    byok({ mode: "openwhispr", model: "saaras:v4", language: "brx" })
  );
  assert.equal(calls.tokens[0].options.language, undefined);
  assert.equal("model" in calls.tokens[0].options, false);
  await s.invoke(
    "dictation-realtime-start",
    byok({ mode: "openwhispr", model: "nova-3", language: "auto" })
  );
  assert.equal(calls.connects.length, 1);
});

test("Sarvam dictation still receives a three-letter input language", async (t) => {
  const s = scenario(t);
  await s.invoke(
    "dictation-realtime-start",
    byok({ provider: "sarvam", model: "saaras:v4", language: "brx", sarvamCaptureId: "take" })
  );
  assert.equal(calls.connects[0].options.language, "brx");
});

test("a start reuses a warm connection minted for the same language and model", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-warmup", byok());
  await s.invoke("dictation-realtime-start", byok());
  assert.equal(calls.connects.length, 1, "no redial");
  assert.deepEqual(calls.disconnects, []);
});

test("a start redials when the warm connection was minted for another language", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-warmup", byok({ language: "de" }));
  await s.invoke("dictation-realtime-start", byok({ language: undefined }));
  assert.equal(calls.connects.length, 2, "warm German session cannot serve an Auto dictation");
  assert.deepEqual(calls.disconnects, [{ id: calls.connects[0].id, commit: false }]);
  assert.equal("language" in calls.connects[1].options, true);
  assert.equal(calls.connects[1].options.language, undefined);
});

// The renderer streams worklet frames before dictation-realtime-start arrives,
// so a redial happens with audio already in flight. The retiring session is
// neither committed (its head would come back as a wrong-language final) nor
// waited on, so frames sent once the start is handled reach the new session.
test("frames sent once a mismatch redial starts buffer into the new session, not the retiring one", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-warmup", byok({ language: "en" }));
  const started = s.invoke("dictation-realtime-start", byok({ language: "de" }));
  s.sendAudio();
  await started;
  const [warm, fresh] = calls.instances;
  assert.deepEqual(calls.audio, [fresh.id]);
  assert.deepEqual(calls.disconnects, [{ id: warm.id, commit: false }]);
});

test("a retiring warm session's late events never reach the renderer", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-warmup", byok({ language: "en" }));
  await s.invoke("dictation-realtime-start", byok({ language: "de" }));
  const [warm] = calls.instances;
  warm.onPartialTranscript?.("hel");
  warm.onFinalTranscript?.("hello");
  warm.onError?.(new Error("closed"));
  warm.onSessionEnd?.({ text: "hello" });
  assert.deepEqual(calls.sent, []);
});

test("a start redials when the warm connection was minted for another model", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-warmup", byok({ model: "gpt-4o-mini-transcribe" }));
  await s.invoke("dictation-realtime-start", byok({ model: "gpt-4o-transcribe" }));
  assert.equal(calls.connects.length, 2);
  assert.equal(calls.connects[1].options.model, "gpt-4o-transcribe");
});

test("a start redials when the warm connection belongs to another mode", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-warmup", byok({ mode: "openwhispr" }));
  await s.invoke("dictation-realtime-start", byok({ mode: "byok" }));
  assert.equal(calls.connects.length, 2);
  assert.equal(calls.connects[1].options.preconfigured, false);
});

test("after stop, the next start dials fresh", async (t) => {
  const s = scenario(t);
  await s.invoke("dictation-realtime-start", byok());
  await s.invoke("dictation-realtime-stop");
  await s.invoke("dictation-realtime-start", byok());
  assert.equal(calls.connects.length, 2);
});

// Managed Orukeet alone shares a connection between warmups and its recording.
// These pin every other route to redialling, as it always has.
for (const [label, options] of [
  ["openai-realtime (byok)", byok()],
  ["openai-realtime (openwhispr)", byok({ mode: "openwhispr" })],
  ["tinfoil-realtime (byok)", byok({ provider: "tinfoil-realtime" })],
]) {
  // Leaves a warmup waiting on its token, so the connection is still in flight.
  const warmupInFlight = async (t, s) => {
    tokenGate = deferred();
    t.after(() => {
      tokenGate = null;
    });
    const warmup = s.invoke("dictation-realtime-warmup", options);
    while (calls.tokens.length === 0) await new Promise((resolve) => setImmediate(resolve));
    return { warmup };
  };

  test(`${label}: a start during a warmup still replaces that warmup`, async (t) => {
    const s = scenario(t);
    const { warmup } = await warmupInFlight(t, s);
    const start = s.invoke("dictation-realtime-start", options);
    tokenGate.resolve();
    await warmup;
    assert.equal((await start).success, true);
    assert.equal(calls.connects.length, 2);
    assert.deepEqual(calls.disconnects, [{ id: calls.instances[0].id, commit: false }]);
  });

  test(`${label}: a warmup during a recording still redials`, async (t) => {
    const s = scenario(t);
    await s.invoke("dictation-realtime-start", options);
    await s.invoke("dictation-realtime-warmup", options);
    assert.equal(calls.connects.length, 2);
  });

  test(`${label}: a stop during a start waiting on a warmup still lets the start connect`, async (t) => {
    const s = scenario(t);
    const { warmup } = await warmupInFlight(t, s);
    const start = s.invoke("dictation-realtime-start", options);
    await s.invoke("dictation-realtime-stop");
    tokenGate.resolve();
    await warmup;
    assert.equal((await start).success, true);
    assert.equal(calls.connects.length, 2);
  });
}

const sarvamRecording = (sarvamCaptureId) =>
  byok({ provider: "sarvam", model: "saaras:v4", sarvamCaptureId });

test("a Sarvam recording cannot recover under a replacement project's key", async (t) => {
  const { invoke, target } = scenario(t);
  let key = "project-a";
  target.environmentManager.getSarvamKey = () => key;
  target.environmentManager.saveSarvamKey = (value) => {
    key = value;
  };
  const options = { sarvamCaptureId: "recording", model: "saaras:v4" };
  await invoke("dictation-realtime-start", sarvamRecording("recording"));
  assert.equal(calls.connects[0].options.apiKey, "project-a");
  await invoke("dictation-realtime-stop", "recording");
  await invoke("save-sarvam-key", "project-a");
  await invoke("save-openai-key", "unrelated-provider");
  assert.equal((await invoke("proxy-sarvam-transcription", options)).text, "batch transcript");
  await invoke("save-sarvam-key", "project-b");
  assert.equal(
    (await invoke("proxy-sarvam-transcription", options)).code,
    "PROVIDER_CREDENTIAL_CHANGED"
  );
  await invoke("save-sarvam-key", "project-a");
  assert.equal(
    (await invoke("proxy-sarvam-transcription", options)).code,
    "PROVIDER_CREDENTIAL_CHANGED"
  );
  assert.equal((await invoke("proxy-sarvam-transcription", {})).text, "batch transcript");
});

test("a replacement Sarvam key cannot claim a capture while its microphone opens", async (t) => {
  const { sender, invoke } = scenario(t);
  const event = { sender };
  listeners.get("dictation-realtime-reserve")(event, "recording");
  await invoke("save-sarvam-key", "replacement");
  const result = await handlers.get("dictation-realtime-start")(
    event,
    sarvamRecording("recording")
  );
  assert.equal(result.code, "PROVIDER_CREDENTIAL_CHANGED");
  assert.deepEqual(calls.connects, []);
});

test("a warmup cleared to run after Sarvam starts preserves the active recording's policy", async (t) => {
  const { invoke, target, sender } = scenario(t);
  const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
  let loading = true;
  const verdict = deferred();
  target.effectivePolicyManager = {
    getCurrent: () => ({
      success: !loading,
      status: loading ? "loading" : "ready",
      managed: true,
      deviceReady: true,
      accountId: "owner",
      policy,
    }),
  };
  target.refreshEffectivePolicy = () => (loading ? verdict.promise : Promise.resolve());
  const warming = invoke("dictation-realtime-warmup", byok());
  await new Promise(setImmediate);
  loading = false;
  await invoke("dictation-realtime-start", sarvamRecording("live"));
  const socket = target._dictationStreaming;
  verdict.resolve();
  assert.equal((await warming).alreadyWarm, true);
  policy.transcription.allowedByokProviders = ["openai"];
  require(handlersModulePath).prototype._retireDisallowedProductWork.call(
    target,
    target.effectivePolicyManager.getCurrent()
  );
  assert.equal(socket.isConnected, false);
  listeners.get("dictation-realtime-send")({ sender }, new Uint8Array(4), "live");
  assert.deepEqual(calls.audio, []);
});

test("Sarvam fatal errors carry provider details and the capture ID through live and finalize IPC", async (t) => {
  const { invoke, target } = scenario(t);
  await invoke("dictation-realtime-start", sarvamRecording("live"));
  const stream = target._dictationStreaming;
  const refusal = Object.assign(new Error("Budget exhausted"), {
    fatal: true,
    code: "PROVIDER_QUOTA_EXHAUSTED",
    messageKey: "providerErrors.quotaExhausted",
    settingsTarget: "speechToText",
    status: 429,
  });
  stream.onError(refusal);
  const fields = {
    error: refusal.message,
    code: refusal.code,
    messageKey: refusal.messageKey,
    settingsTarget: refusal.settingsTarget,
    status: 429,
  };
  assert.deepEqual(calls.sent.at(-1), {
    channel: "dictation-realtime-error",
    payload: { ...fields, sarvamCaptureId: "live" },
  });
  stream.finalize = async () => {
    throw refusal;
  };
  assert.deepEqual(await invoke("dictation-realtime-finalize", "live"), {
    success: false,
    ...fields,
  });
});

test("cancelling Sarvam before the policy verdict settles prevents a late connection", async (t) => {
  const { invoke, target } = scenario(t);
  const verdict = deferred();
  let loading = true;
  target.effectivePolicyManager = {
    getCurrent: () => ({
      success: !loading,
      status: loading ? "loading" : "ready",
      deviceReady: true,
      accountId: null,
      managed: false,
      localOnly: false,
    }),
  };
  target.refreshEffectivePolicy = () => verdict.promise;
  const start = invoke("dictation-realtime-start", sarvamRecording("first"));
  await invoke("dictation-realtime-stop", "first");
  const beforeVerdict = await Promise.race([start, new Promise((r) => setImmediate(r))]);
  loading = false;
  verdict.resolve();
  await start;
  assert.equal(beforeVerdict?.code, "TRANSCRIPTION_CANCELLED");
  assert.equal(calls.connects.length, 0);
});

for (const eventName of ["did-start-loading", "render-process-gone"]) {
  test(`Sarvam closes on ${eventName} and a retired renderer leaves the replacement recording alone`, async (t) => {
    const { invoke, sender, target } = scenario(t);
    assert.equal(
      (await invoke("dictation-realtime-start", sarvamRecording("first"))).success,
      true
    );
    const original = target._dictationStreaming;
    sender.emit(eventName);
    assert.equal(original.isConnected, false);
    assert.equal(target._dictationStreaming, null);
    const other = Object.assign(new EventEmitter(), { id: 2, send() {} });
    const replacement = (channel, options) => handlers.get(channel)({ sender: other }, options);
    listeners.get("dictation-realtime-reserve")({ sender: other }, "second");
    await replacement("dictation-realtime-start", sarvamRecording("second"));
    const fresh = target._dictationStreaming;
    sender.emit("destroyed");
    await invoke("dictation-realtime-stop");
    assert.equal(target._dictationStreaming, fresh);
    assert.equal(fresh.isConnected, true);
    await replacement("dictation-realtime-stop", "second");
  });
}

for (const boundary of ["reload", "account change", "replacement"]) {
  test(`a Sarvam start waiting on a warmup cannot open a socket after ${boundary}`, async (t) => {
    const { invoke, sender, target } = scenario(t);
    target.effectivePolicyManager = {
      getCurrent: () => ({
        success: true,
        status: "ready",
        managed: false,
        deviceReady: true,
        accountId: "owner",
      }),
    };
    target.refreshEffectivePolicy = async () => {};
    const warmup = deferred();
    target._dictationConnectPromise = warmup.promise;
    const start = invoke("dictation-realtime-start", sarvamRecording("old"));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.connects.length, 0);
    let replacement;
    if (boundary === "reload") sender.emit("did-start-loading");
    else if (boundary === "account change")
      target._retireAccountProductStreams(
        target._remoteStreamPolicies.get("_dictationStreaming").accountId
      );
    else replacement = invoke("dictation-realtime-start", sarvamRecording("new"));
    const beforeWarmup = await Promise.race([start, new Promise((r) => setImmediate(r))]);
    target._dictationConnectPromise = null;
    warmup.resolve();
    await start;
    if (replacement) assert.equal((await replacement).success, true);
    assert.equal(
      beforeWarmup?.code,
      boundary === "account change" ? "AUTH_CONTEXT_CHANGED" : "TRANSCRIPTION_CANCELLED"
    );
    assert.equal(calls.connects.length, replacement ? 1 : 0);
    if (replacement) {
      const current = target._dictationStreaming;
      listeners.get("dictation-realtime-release")({ sender }, "old");
      assert.equal(target._dictationStreaming, current);
      assert.equal(current.isConnected, true);
    }
  });
}

test("a late stop and a foreign start cannot close a replacement Sarvam capture", async (t) => {
  const { invoke, sender, target } = scenario(t);
  await invoke("dictation-realtime-start", sarvamRecording("first"));
  const original = target._dictationStreaming;
  const closed = deferred();
  original.disconnect = async () => {
    await closed.promise;
    return { text: "" };
  };
  const stop = invoke("dictation-realtime-stop", "first");
  await invoke("dictation-realtime-start", sarvamRecording("second"));
  const replacement = target._dictationStreaming;
  closed.resolve();
  await stop;
  const stranger = Object.assign(new EventEmitter(), { id: 99, send() {} });
  const denied = await handlers.get("dictation-realtime-start")(
    { sender: stranger },
    { provider: "unknown" }
  );
  assert.equal(denied.success, false);
  listeners.get("dictation-realtime-release")({ sender }, "first");
  await invoke("dictation-realtime-stop", "first");
  await invoke("dictation-realtime-stop");
  listeners.get("dictation-realtime-send")({ sender }, new Uint8Array(4), "first");
  assert.deepEqual(calls.audio, []);
  assert.equal(target._dictationStreaming, replacement);
  assert.equal(replacement.isConnected, true);
});

for (const boundary of ["account change", "reload", "cancel"]) {
  test(`a reserved Sarvam recording cannot start after ${boundary} while its microphone opens`, async (t) => {
    const { sender, target } = scenario(t);
    const event = { sender };
    const start = (id) => handlers.get("dictation-realtime-start")(event, sarvamRecording(id));
    listeners.get("dictation-realtime-reserve")(event, "opening");
    if (boundary === "account change")
      target._retireAccountProductStreams(target.effectivePolicyManager.getCurrent().accountId);
    else if (boundary === "reload") sender.emit("did-start-loading");
    else await handlers.get("dictation-realtime-stop")(event, "opening");
    const next = Object.assign(new EventEmitter(), { id: 2, send() {} });
    listeners.get("dictation-realtime-reserve")({ sender: next }, "next");
    assert.equal((await start("opening")).code, "AUTH_CONTEXT_CHANGED");
    assert.equal(calls.connects.length, 0);
    assert.equal(
      (await handlers.get("dictation-realtime-start")({ sender: next }, sarvamRecording("next")))
        .success,
      true
    );
    next.emit("destroyed");
  });
}

test("cancelling a Sarvam reservation leaves the previous provider's idle socket intact", async (t) => {
  const { invoke, sender, target } = scenario(t);
  await invoke("dictation-realtime-warmup", byok());
  const idle = target._dictationStreaming;
  listeners.get("dictation-realtime-reserve")({ sender }, "opening");
  listeners.get("dictation-realtime-send")({ sender }, new Uint8Array(4), "opening");
  await invoke("dictation-realtime-stop", "opening");
  assert.deepEqual(calls.audio, []);
  assert.equal(target._dictationStreaming, idle);
  assert.equal(idle.isConnected, true);
});
