const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Auto-learn must not add a word the active workspace already applies, but a
// word that is only hidden, paused or from another workspace never reaches the
// renderer's hints, so it is still learned. Main only knows the hints the
// renderer last sent over dictionary-set-shared-hints, which carry only the
// shared words that fit the transcription prompt (settingsStore's
// sharedWordsReachingPrompt, tested in settingsStoreSharedDictionaryHints).

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();

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
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
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

Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
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

let target;
let handlerThis;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = {
    _getDictionarySafe: Ctor.prototype._getDictionarySafe,
    _processCorrections: Ctor.prototype._processCorrections,
    _autoLearnEnabled: true,
    _sharedDictionaryHints: { space: [], workspace: [] },
    windowManager: { showDictationPanel: () => {} },
  };
  handlerThis = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
  Ctor.prototype.setupHandlers.call(handlerThis);
});

test.after(() => {
  Module._load = originalLoad;
});

function learnFrom(originalText, newFieldValue) {
  const added = [];
  target.databaseManager = {
    getDictionary: () => ["Piha"],
    applyDictionaryChanges: (changes) => {
      added.push(...(changes.add ?? []));
      return { success: true };
    },
  };
  target._autoLearnLatestData = { originalText, newFieldValue };
  handlerThis._processCorrections();
  return added;
}

const setHints = (hints) => handlers.get("dictionary-set-shared-hints")({}, hints);

test("correction learner skips a word that applies from the active workspace", async () => {
  await setHints({ space: [], workspace: ["Qdrant"] });

  const added = learnFrom("We store vectors in Quadrant now", "We store vectors in Qdrant now");

  assert.ok(!added.includes("Qdrant"), `learned ${JSON.stringify(added)}`);
});

test("correction learner skips a word that applies from a space", async () => {
  await setHints({ space: ["qdrant"], workspace: [] });

  const added = learnFrom("We store vectors in Quadrant now", "We store vectors in Qdrant now");

  assert.deepEqual(added, []);
});

test("correction learner still learns a word that is only hidden or from another workspace", async () => {
  await setHints({ space: [], workspace: ["ARR"] });

  const added = learnFrom("We store vectors in Quadrant now", "We store vectors in Qdrant now");

  assert.deepEqual(added, ["Qdrant"]);
});

test("a malformed hints payload is ignored and keeps the last good one", async () => {
  await setHints({ space: [], workspace: ["Qdrant"] });
  await setHints({ space: "Qdrant", workspace: [] });
  await setHints({ space: [1], workspace: [] });
  await setHints(null);

  const added = learnFrom("We store vectors in Quadrant now", "We store vectors in Qdrant now");

  assert.deepEqual(added, []);
});

test("a team word the prompt had no room for is learned", async () => {
  // The renderer sent only the words that fit; Qdrant applies in the
  // workspace but was cut, so dictation never hears of it.
  await setHints({ space: [], workspace: ["Parakeet"] });

  const added = learnFrom("We store vectors in Quadrant now", "We store vectors in Qdrant now");

  assert.deepEqual(added, ["Qdrant"]);
});
