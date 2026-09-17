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
let server,
  target,
  opened = 0;
const messages = [];
const event = { sender: new EventEmitter() };
event.sender.send = (channel, text) => messages.push([channel, text]);
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
  net: {
    fetch: async (url, options) => {
      assert.equal(url, "https://api.openwhispr.test/api/stt/orukeet/session");
      assert.equal(options.headers.Authorization, "Bearer account-a");
      return backendResponse();
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
    if (request === "./orukeetStreaming")
      return {
        OrukeetStreaming: class extends OrukeetStreaming {
          constructor() {
            super({
              createSocket: (url, options, protocols) => {
                assert.equal(url, cloudSession.websocketUrl);
                assert.equal(options.headers.Authorization, undefined);
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
      else if (JSON.parse(data).type === "commit")
        socket.send(
          JSON.stringify({
            type: "final",
            text: `Recorded ${bytes} bytes`,
            model: "orukeet-v0.1.0",
          })
        );
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
  assert.equal(messages.filter(([channel]) => channel === "dictation-realtime-final").length, 1);
  assert.equal((await handlers.get("dictation-realtime-stop")()).text, final.text);
  assert.equal(tokenListeners.size, 0);
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
