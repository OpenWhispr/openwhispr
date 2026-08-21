const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

test("meeting prepare invalidates authorization while system-audio capability is pending", async (t) => {
  const handlers = new Map();
  const capability = createDeferred();
  let streamingClientLookups = 0;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

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
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
      removeHandler: () => {},
    },
    net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
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
    if (parent?.filename === handlersModulePath && request === "./meetingStreamingProviders") {
      return {
        ALLOWED_MEETING_PROVIDERS: new Set(["local", "deepgram-realtime"]),
        getMeetingConnectionKey: (options) => JSON.stringify(options),
        getMeetingStreamingClient: () => {
          streamingClientLookups += 1;
          return class {};
        },
        disconnectMeetingStreamingClient: async () => ({ text: "" }),
      };
    }
    if (parent?.filename === handlersModulePath && request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  t.after(() => {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    delete require.cache[handlersModulePath];
  });

  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
    activeMeetingSpeakerConfig: null,
    audioTapManager: { isSupported: () => false, stop: async () => {} },
    linuxPortalAudioManager: {
      getCapability: () => capability.promise,
      stop: async () => {},
    },
    windowsLoopbackAudioManager: { stop: async () => {} },
    meetingAecManager: null,
    meetingDetectionEngine: {
      endRecordingSession: () => true,
      setUserRecording: () => {},
    },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (object, property) => (property in object ? object[property] : anything()),
    })
  );

  const prepare = handlers.get("meeting-transcription-prepare");
  const abort = handlers.get("meeting-transcription-abort");
  assert.ok(prepare);
  assert.ok(abort);

  const pendingPrepare = prepare(
    { sender: {} },
    { provider: "deepgram-realtime", model: "nova-3", mode: "byok" }
  );
  await Promise.resolve();
  await abort({}, undefined);
  capability.resolve({
    available: true,
    supportsSystemAudio: true,
    supportsNativeCapture: true,
  });

  await assert.rejects(pendingPrepare, { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
  assert.equal(streamingClientLookups, 0, "stale prepare must not create a streaming client");
});
