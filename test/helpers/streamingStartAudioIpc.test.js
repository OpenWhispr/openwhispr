const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { WebSocketServer } = require("ws");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");
const CortiStreaming = require("../../src/helpers/cortiStreaming");
const { audioRecorder } = require("./harness/audioRecorder");
const { deferred } = require("./harness/deferred");

// Runs the registered start/send/stop handlers with the real streaming clients
// against a loopback provider. Electron, the stored credentials, the token mint
// and the provider host are the only stand-ins.
const handlers = new Map();
const modulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "streaming-start-audio-ipc-"));
const event = { sender: { id: 1 } };
// The audio each provider socket received, in the order the sockets opened.
const sockets = [];
let server;
// When set, the next token mint waits on it: the network round trip a start
// makes before its socket exists.
let pendingMint = null;
const mintToken = async (token) => {
  await pendingMint?.promise;
  return token;
};

const loopbackUrl = (provider) => `ws://127.0.0.1:${server.address().port}/${provider}`;

class LoopbackAssemblyAi extends AssemblyAiStreaming {
  buildWebSocketUrl(options) {
    return super
      .buildWebSocketUrl(options)
      .replace("wss://streaming.assemblyai.com/v3/ws", loopbackUrl("assemblyai"));
  }
}

class LoopbackCorti extends CortiStreaming {
  buildWebSocketUrl(options) {
    return super.buildWebSocketUrl(options).replace(/^wss:\/\/[^?]+/, loopbackUrl("corti"));
  }
}

const electron = {
  app: {
    getPath: () => userDataDirectory,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on() {},
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
    removeHandler() {},
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  net: {
    // The only request a BYOK AssemblyAI start makes before it connects.
    fetch: async (url) => {
      assert.equal(url, "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60");
      return Response.json({ token: await mintToken("assemblyai-token") });
    },
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
};

Module._load = function loadWithLoopback(request, parent, isMain) {
  if (request === "electron") return electron;
  if (parent?.filename === modulePath) {
    if (request === "./assemblyAiStreaming") return LoopbackAssemblyAi;
    if (request === "./cortiStreaming") return LoopbackCorti;
  }
  return originalLoad.call(this, request, parent, isMain);
};

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
  environmentManager: { getAssemblyAIKey: () => "byok-key" },
  assemblyAiStreaming: null,
  cortiStreaming: null,
  _mintStoredCortiToken: async (options) => ({
    token: await mintToken("corti-token"),
    environment: options.environment,
    tenant: options.tenant,
  }),
};

test.before(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket, request) => {
    const audio = audioRecorder();
    sockets.push(audio);
    // AssemblyAI begins on connect; Corti waits for its config.
    if (request.url.startsWith("/assemblyai")) {
      socket.send(JSON.stringify({ type: "Begin", id: "test-session" }));
    }
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        audio.record(data);
        return;
      }
      const reply = {
        Terminate: { type: "Termination", audio_duration_seconds: 0 },
        config: { type: "CONFIG_ACCEPTED", sessionId: "test-session" },
        flush: { type: "flushed" },
      }[JSON.parse(data.toString()).type];
      if (reply) socket.send(JSON.stringify(reply));
    });
  });

  const IPCHandlers = require(modulePath);
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  Module._load = originalLoad;
  fs.rmSync(userDataDirectory, { recursive: true, force: true });
});

const PROVIDERS = [
  {
    name: "AssemblyAI",
    channel: "assemblyai",
    client: "assemblyAiStreaming",
    options: { mode: "byok" },
  },
  {
    name: "Corti",
    channel: "corti",
    client: "cortiStreaming",
    options: { environment: "us", tenant: "base" },
  },
];

for (const { name, channel, client, options } of PROVIDERS) {
  test(`${name} holds no audio once a start has failed`, async () => {
    let failMint;
    pendingMint = { promise: new Promise((_, reject) => (failMint = reject)) };
    const started = handlers.get(`${channel}-streaming-start`)(event, options);
    handlers.get(`${channel}-streaming-send`)(event, Buffer.alloc(1600));
    failMint(new Error("token request failed"));
    pendingMint = null;

    assert.equal((await started).success, false);
    // Nothing is in flight any more, so nothing may be held for a later session.
    assert.equal(target[client].sendAudio(Buffer.alloc(1600)), false);
  });

  for (const warm of [false, true]) {
    const socket = warm ? "warm socket" : "cold socket";
    test(`${name} keeps the audio sent while a start mints its token (${socket})`, async () => {
      if (warm) {
        const warmup = await handlers.get(`${channel}-streaming-warmup`)(event, options);
        assert.equal(warmup.success, true);
      }
      const openedBeforeStart = sockets.length;
      // Three 50 ms frames of the opening words, captured while the mint is in flight.
      const frames = [1, 2, 3].map((value) => Buffer.alloc(1600, value));

      pendingMint = deferred();
      const started = handlers.get(`${channel}-streaming-start`)(event, options);
      for (const frame of frames) handlers.get(`${channel}-streaming-send`)(event, frame);
      pendingMint.resolve();
      pendingMint = null;

      try {
        assert.equal((await started).success, true);
        assert.equal(
          sockets.length,
          openedBeforeStart + (warm ? 0 : 1),
          warm ? "the start must ride the warm socket" : "the start must open its own socket"
        );
        assert.deepEqual(await sockets.at(-1).received(4800), Buffer.concat(frames));
      } finally {
        await handlers.get(`${channel}-streaming-stop`)();
      }
    });
  }
}
