const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// Runs the registered Electron handlers with a real local WebSocket server.
// Only Electron, account state and the remote authorization response are stubbed.
const handlers = new Map();
const broadcasts = [];
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orukeet-dictation-ipc-"));
let tokenState = { token: "account-a", generation: 1 };
const tokenListeners = new Set();
let backendResponse = async () => Response.json(cloudSession);
const cloudSession = {
  baseUrl: "https://orukeet.gizmovoice.ai",
  websocketUrl: "wss://orukeet.gizmovoice.ai/v1/audio/transcriptions/stream",
  clientToken: "test.token.signature",
  protocol: "orukeet.pcm.v1",
  model: "orukeet-v0.1.0",
  expiresIn: 60,
  singleUse: true,
};
const { once, EventEmitter } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const { OrukeetStreaming } = require("../../src/helpers/orukeetStreaming");
const AgentStreamRequestRegistry = require("../../src/helpers/agentStreamRequestRegistry");
let server,
  target,
  opened = 0;
let refuseCommit = false;
let commitCount = 0;
const messages = [];
const event = { sender: new EventEmitter() };
event.sender.send = (channel, text) => messages.push([channel, text]);
event.sender.id = 1;
const backendFetch = async (url, options) => {
  assert.ok(
    [
      "https://api.openwhispr.test/api/stt/orukeet/session",
      "https://api.openwhispr.test/api/reason",
      "https://api.openwhispr.test/api/streaming-usage",
      "https://api.openwhispr.test/api/transcribe",
    ].includes(url)
  );
  assert.equal(options.headers.Authorization, "Bearer account-a");
  return backendResponse(url, options);
};
const managedOptions = {
  provider: "orukeet",
  mode: "openwhispr",
  model: "orukeet-v0.1.0",
  baseUrl: "https://untrusted-renderer.test",
};

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
    on: (channel, fn) => handlers.set(channel, fn),
    removeHandler: () => {},
  },
  net: { fetch: backendFetch },
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
  // Cloud uploads go through a dedicated session partition.
  session: {
    fromPartition: () => ({
      webRequest: { onBeforeSendHeaders: () => {} },
      fetch: backendFetch,
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
    if (request === "./orukeetStreaming")
      return {
        OrukeetStreaming: class extends OrukeetStreaming {
          constructor(options) {
            super({
              ...options,
              createSocket: (url, options, protocols) => {
                assert.equal(url, cloudSession.websocketUrl);
                assert.equal(
                  options.headers.Authorization,
                  protocols ? undefined : "Bearer test-key"
                );
                opened++;
                return new WebSocket(`ws://127.0.0.1:${server.address().port}`, protocols, options);
              },
            });
          }
        },
      };
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        subscribe: (fn) => {
          tokenListeners.add(fn);
          return () => tokenListeners.delete(fn);
        },
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

function buildFakeThis() {
  const target = {
    sessionId: "test-session",
    _dictationStreaming: null,
    _dictationConnectPromise: null,
    _dictationIdleTimer: null,
    _cloudTranscriptionRequests: new AgentStreamRequestRegistry(),
  };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

test.before(async () => {
  process.env.OPENWHISPR_API_URL = "https://api.openwhispr.test";
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "ready",
        channels: 1,
        sample_rate: 16000,
        encoding: "pcm_s16le",
        max_seconds: 600,
      })
    );
    let bytes = 0;
    socket.on("message", (data, binary) => {
      if (binary) bytes += data.length;
      else if (JSON.parse(data).type === "commit") {
        commitCount++;
        if (refuseCommit) {
          if (refuseCommit === "once") refuseCommit = false;
          socket.send(JSON.stringify({ type: "error", code: "capacity", retry_after_ms: 100 }));
          return;
        }
        socket.send(
          JSON.stringify({ type: "language", language: "en", language_confidence: 0.99 })
        );
        socket.send(
          JSON.stringify({
            type: "final",
            text: `Recorded ${bytes} bytes`,
            model: "orukeet-v0.1.0",
            language: "en",
            language_confidence: 0.99,
            language_audio_seconds: 6,
          })
        );
      }
    });
  });
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = buildFakeThis();
  Ctor.prototype.setupHandlers.call(target);
});

test.after(async () => {
  await handlers.get("dictation-realtime-stop")();
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

test("registered managed IPC streams startup audio and returns exactly one complete final", async () => {
  const start = handlers.get("dictation-realtime-start")(event, managedOptions);
  handlers.get("dictation-realtime-send")(event, Buffer.alloc(640));
  assert.equal((await start).success, true);
  handlers.get("dictation-realtime-send")(event, Buffer.alloc(640));
  const final = await handlers.get("dictation-realtime-finalize")();
  assert.equal(final.success, true);
  assert.equal(final.text, "Recorded 1280 bytes");
  assert.equal(final.language, "en");
  assert.equal(final.languageConfidence, 0.99);
  assert.equal(final.languageAudioSeconds, 6);
  assert.deepEqual(messages.find(([channel]) => channel === "dictation-realtime-language")?.[1], {
    language: "en",
    languageConfidence: 0.99,
  });
  assert.equal(messages.filter(([channel]) => channel === "dictation-realtime-final").length, 1);
  assert.equal((await handlers.get("dictation-realtime-stop")()).text, final.text);
  assert.equal(tokenListeners.size, 0);
});

test(
  "managed IPC closes a capacity-refused commit without retrying",
  { timeout: 1000 },
  async (t) => {
    refuseCommit = true;
    const before = commitCount;
    const messagesBefore = messages.length;
    t.after(async () => {
      refuseCommit = false;
      await handlers.get("dictation-realtime-stop")();
    });

    assert.equal(
      (await handlers.get("dictation-realtime-start")(event, managedOptions)).success,
      true
    );
    const streaming = target._dictationStreaming;
    const closed = once(streaming.ws, "close");
    handlers.get("dictation-realtime-send")(event, Buffer.alloc(640));
    const final = await handlers.get("dictation-realtime-finalize")();

    assert.deepEqual(final, { success: false, error: "Orukeet transcription failed: capacity" });
    assert.equal(streaming.intentionalClose, true, "the refused attempt is closed before fallback");
    assert.equal(streaming.retryTimer, undefined, "no delayed commit can outlive fallback");
    assert.equal(streaming.finalResolve, null);
    assert.deepEqual(messages.slice(messagesBefore), [
      ["dictation-realtime-error", "Orukeet transcription failed: capacity"],
    ]);
    await closed;
    assert.equal(commitCount - before, 1);
  }
);

test("self-hosted IPC still retries a capacity-refused commit without re-uploading", async (t) => {
  refuseCommit = "once";
  const before = commitCount;
  target.environmentManager = { getCustomTranscriptionKey: () => "test-key" };
  t.after(async () => {
    refuseCommit = false;
    delete target.environmentManager;
    await handlers.get("dictation-realtime-stop")();
  });

  const start = await handlers.get("dictation-realtime-start")(event, {
    ...managedOptions,
    mode: "byok",
    baseUrl: cloudSession.baseUrl,
  });
  assert.equal(start.success, true);
  handlers.get("dictation-realtime-send")(event, Buffer.alloc(640));
  const final = await handlers.get("dictation-realtime-finalize")();

  assert.equal(final.success, true);
  assert.equal(final.text, "Recorded 640 bytes");
  assert.equal(commitCount - before, 2);
});

test("stop during token fetch cancels the real main-process connection", async () => {
  let resolve;
  backendResponse = () =>
    new Promise((r) => {
      resolve = r;
    });
  const before = opened;
  const start = handlers.get("dictation-realtime-start")(event, managedOptions);
  await handlers.get("dictation-realtime-stop")();
  resolve(Response.json(cloudSession));
  assert.equal((await start).success, false);
  assert.equal(opened, before);
  assert.equal(target._dictationStreaming, null);
});

test("main-process quota denial retains metadata and opens no socket", async () => {
  backendResponse = async () =>
    Response.json({ error: "Allowance exhausted", code: "LIMIT_EXCEEDED" }, { status: 402 });
  const before = opened;
  const result = await handlers.get("dictation-realtime-start")(event, managedOptions);
  assert.equal(result.code, "LIMIT_EXCEEDED");
  assert.equal(result.status, 402);
  assert.equal(opened, before);
});

test("closing the owning window releases the managed socket and auth subscription", async () => {
  backendResponse = async () => Response.json(cloudSession);
  await handlers.get("dictation-realtime-start")(event, managedOptions);
  const streaming = target._dictationStreaming;
  event.sender.emit("destroyed");
  assert.equal(streaming.isConnected, false);
  assert.equal(target._dictationStreaming, null);
  assert.equal(tokenListeners.size, 0);
  assert.equal(event.sender.listenerCount("destroyed"), 0);
});

test("cloud cleanup forwards fallback telemetry to its combined log request", async () => {
  const requests = [];
  backendResponse = async (url, options) => {
    assert.equal(url, "https://api.openwhispr.test/api/reason");
    requests.push(JSON.parse(options.body));
    return Response.json({ text: "clean transcript" });
  };
  for (const reason of ["rate_limited", undefined]) {
    const result = await handlers.get("cloud-reason")(event, "raw transcript", {
      purpose: "cleanup",
      sttProvider: "groq",
      streamingFallbackReason: reason,
    });
    assert.equal(result.success, true);
    assert.equal(requests.at(-1).streamingFallbackReason, reason);
    assert.equal(requests.at(-1).sttProvider, "groq");
  }
  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[1], "streamingFallbackReason"), false);
});

const DETECTED = {
  sttDetectedLanguage: "ja",
  sttDetectedLanguageConfidence: 0.97,
  sttDetectedLanguageAudioSeconds: 6,
  sttDetectedLanguageStatus: "detected",
};

test("cloud cleanup forwards the detected language to its combined log request", async () => {
  const requests = [];
  backendResponse = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ text: "clean transcript" });
  };
  await handlers.get("cloud-reason")(event, "raw", {
    purpose: "cleanup",
    sttProvider: "orukeet",
    ...DETECTED,
  });
  await handlers.get("cloud-reason")(event, "raw", { purpose: "cleanup", sttProvider: "orukeet" });
  assert.deepEqual(
    Object.fromEntries(Object.keys(DETECTED).map((key) => [key, requests[0][key]])),
    DETECTED
  );
  for (const key of Object.keys(DETECTED)) {
    assert.equal(Object.hasOwn(requests[1], key), false, key);
  }
});

test("streaming usage forwards the detected language", async () => {
  const requests = [];
  backendResponse = async (url, options) => {
    assert.match(url, /\/api\/streaming-usage$/);
    requests.push(JSON.parse(options.body));
    return Response.json({
      recorded: true,
      wordCount: 1,
      wordsUsed: 1,
      wordsRemaining: 10,
      limitReached: false,
    });
  };
  await handlers.get("cloud-streaming-usage")(event, "hello", 4, {
    sttProvider: "orukeet",
    ...DETECTED,
  });
  await handlers.get("cloud-streaming-usage")(event, "hello", 4, {
    sttProvider: "orukeet",
    sttDetectedLanguageStatus: "unknown",
  });
  assert.deepEqual(
    Object.fromEntries(Object.keys(DETECTED).map((key) => [key, requests[0][key]])),
    DETECTED
  );
  assert.equal(requests[1].sttDetectedLanguageStatus, "unknown");
  assert.equal(Object.hasOwn(requests[1], "sttDetectedLanguage"), false);
});

test("the language fallback upload carries the fallback reason and detection, and no language", async () => {
  const bodies = [];
  backendResponse = async (url, options) => {
    assert.match(url, /\/api\/transcribe$/);
    bodies.push(Buffer.from(options.body).toString("latin1"));
    return Response.json({ text: "日本語", wordsUsed: 1, wordsRemaining: 10 });
  };
  const result = await handlers.get("cloud-transcribe")(event, new Uint8Array(64).buffer, {
    streamingFallbackReason: "language_detected_unsupported",
    ...DETECTED,
  });
  assert.equal(result.success, true);
  const body = bodies[0];
  assert.match(body, /name="streamingFallbackReason"\r\n\r\nlanguage_detected_unsupported\r\n/);
  assert.match(body, /name="sttDetectedLanguage"\r\n\r\nja\r\n/);
  assert.match(body, /name="sttDetectedLanguageConfidence"\r\n\r\n0\.97\r\n/);
  assert.match(body, /name="sttDetectedLanguageAudioSeconds"\r\n\r\n6\r\n/);
  assert.match(body, /name="sttDetectedLanguageStatus"\r\n\r\ndetected\r\n/);
  assert.doesNotMatch(body, /name="language"/);
});

test("warmups landing together mint one session and share its unused socket", async () => {
  await handlers.get("dictation-realtime-stop")();
  let mints = 0;
  backendResponse = async () => {
    mints += 1;
    return Response.json(cloudSession);
  };
  const socketsBefore = opened;

  // Both post-dictation re-warm paths fire at once.
  const [first, second] = await Promise.all([
    handlers.get("dictation-realtime-warmup")(event, managedOptions),
    handlers.get("dictation-realtime-warmup")(event, managedOptions),
  ]);
  assert.equal(first.success, true);
  assert.deepEqual(second, { success: true, alreadyWarm: true });
  assert.equal(mints, 1);
  assert.equal(opened, socketsBefore + 1);

  // The dictation itself rides the warm socket.
  assert.equal(
    (await handlers.get("dictation-realtime-start")(event, managedOptions)).success,
    true
  );
  assert.equal(mints, 1);
  handlers.get("dictation-realtime-send")(event, Buffer.alloc(640));
  assert.equal((await handlers.get("dictation-realtime-finalize")()).success, true);
  await handlers.get("dictation-realtime-stop")();
});

test("a warmup never reuses a socket that has already carried audio", async () => {
  await handlers.get("dictation-realtime-stop")();
  let mints = 0;
  backendResponse = async () => {
    mints += 1;
    return Response.json(cloudSession);
  };

  await handlers.get("dictation-realtime-start")(event, managedOptions);
  handlers.get("dictation-realtime-send")(event, Buffer.alloc(640));
  const used = target._dictationStreaming;
  const warmup = await handlers.get("dictation-realtime-warmup")(event, managedOptions);

  assert.equal(warmup.success, true);
  assert.equal(warmup.alreadyWarm, undefined);
  assert.equal(mints, 2);
  assert.notEqual(target._dictationStreaming, used);
  await handlers.get("dictation-realtime-stop")();
});

test("an idle Orukeet warm socket closes after 60 seconds and start cancels expiry", async () => {
  await handlers.get("dictation-realtime-stop")();
  backendResponse = async () => Response.json(cloudSession);
  await handlers.get("dictation-realtime-warmup")(event, managedOptions);
  const first = target._dictationStreaming;
  assert.equal(target._dictationIdleTimer._idleTimeout, 60000);

  // Exercise the registered expiry callback without advancing WebSocket timers.
  const expire = target._dictationIdleTimer._onTimeout;
  clearTimeout(target._dictationIdleTimer);
  expire();
  assert.equal(first.isConnected, false);
  assert.equal(target._dictationStreaming, null);
  await handlers.get("dictation-realtime-warmup")(event, managedOptions);
  assert.ok(target._dictationIdleTimer);
  await handlers.get("dictation-realtime-start")(event, managedOptions);
  assert.equal(target._dictationIdleTimer, null);
  assert.equal(target._dictationStreaming.isConnected, true);
  await handlers.get("dictation-realtime-stop")();
});
