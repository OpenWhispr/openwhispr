const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Auto-learn must not add a word the active workspace already applies, but a
// word that is only hidden, paused or from another workspace never reaches the
// renderer's prompt hints, so it is still learned. The first argument of
// dictionary-set-shared-hints carries these words. The second carries the
// eligible shared hints for Orukeet's own hotword budget.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dictionary-hints-"));
let tokenState = { token: null, generation: 0 };

const electronStub = {
  app: {
    getPath: () => userData,
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
  if (parent?.filename === handlersModulePath && request === "./tokenStore") {
    return {
      get: () => tokenState.token,
      getState: () => tokenState,
      subscribe: () => () => {},
    };
  }
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

let Ctor;
let target;
let handlerThis;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  Ctor = IPCHandlers.default || IPCHandlers;
  target = {
    _getDictionarySafe: Ctor.prototype._getDictionarySafe,
    _getPersonalDictionarySafe: Ctor.prototype._getPersonalDictionarySafe,
    _processCorrections: Ctor.prototype._processCorrections,
    _autoLearnEnabled: true,
    _sharedDictionaryHints: { space: [], workspace: [] },
    windowManager: { showDictationPanel: () => {} },
  };
  handlerThis = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
  Ctor.prototype.setupHandlers.call(withDevicePolicy(handlerThis));
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userData, { recursive: true, force: true });
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

const setHints = (...args) => handlers.get("dictionary-set-shared-hints")({}, ...args);

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

function setupOrukeet(t, accountId = "first-account") {
  const DatabaseManager = require("../../src/helpers/database");
  const ParakeetManager = require("../../src/helpers/parakeet");
  const databaseManager = Object.create(DatabaseManager.prototype);
  databaseManager.db = new DatabaseSync(":memory:");
  databaseManager.db.exec(
    "CREATE TABLE custom_dictionary (id INTEGER PRIMARY KEY, word TEXT NOT NULL, deleted_at TEXT, shared_at TEXT, account_id TEXT); CREATE TABLE device_accounts (account_id TEXT PRIMARY KEY)"
  );
  databaseManager.activeAccountId = null;
  databaseManager._accountChanges = [];
  databaseManager._registerKeyFolding();
  databaseManager.setActiveAccountId(accountId);
  // Account switches claim rows across every table; these tests only hold the dictionary.
  t.mock.method(databaseManager, "claimSignedOutLocalRows", () => {});
  t.mock.method(databaseManager, "claimLegacyRowsOfOnlyAccount", () => {});
  const parakeetManager = new ParakeetManager();
  t.after(() => {
    clearTimeout(parakeetManager.serverManager.hotwordsRefreshTimer);
    databaseManager.db.close();
  });

  // Keep provider binding and IPC registration real without booting policy,
  // retention, or GPU detection.
  for (const method of ["_initLocalModelPolicy", "_setupRetentionCleanup", "_logDetectedGpus"]) {
    t.mock.method(Ctor.prototype, method, () => {});
  }
  const ipc = new Ctor(
    withDevicePolicy({
      databaseManager,
      parakeetManager,
      windowManager: { retireMeetingNotificationScope() {}, showDictationPanel() {} },
    })
  );
  return {
    ipc,
    databaseManager,
    hotwords: () => parakeetManager.serverManager._hotwordsFor("orukeet-v0.1.0")?.words ?? [],
  };
}

const WORKSPACE = "workspace-a";

const ACCOUNT_SCOPE_USER_KEY = "openwhispr:accountScopeUserId";

async function loadDictionaryStore(t, initialStorage = {}, electronAPI = {}) {
  const sent = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      activeWorkspaceId: WORKSPACE,
      [ACCOUNT_SCOPE_USER_KEY]: "first-account",
      ...initialStorage,
    },
    window: {
      electronAPI: {
        ...electronAPI,
        setSharedDictionaryHints: (...args) => {
          sent.push(args);
          return setHints(...args);
        },
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-orukeet-hints-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { selectSharedHintWords } = await vite.ssrLoadModule("/utils/sharedDictionaryHints.ts");
  const { reconcileAccountScope } = await vite.ssrLoadModule("/lib/authAccountScope.ts");
  return {
    store: useSettingsStore,
    selectSharedHintWords,
    reconcileAccountScope,
    vite,
    storage,
    sent,
  };
}

test("Orukeet keeps eligible shared words after the Whisper prompt fills", async (t) => {
  const { ipc, databaseManager, hotwords } = setupOrukeet(t);
  const { store, selectSharedHintWords } = await loadDictionaryStore(t);
  const personal = Array.from(
    { length: 10 },
    (_, index) => `PersonalName${index}${"x".repeat(45)}`
  );
  const insert = databaseManager.db.prepare("INSERT INTO custom_dictionary (word) VALUES (?)");
  for (const word of personal) insert.run(word);
  store.setState({ customDictionary: personal, preferredLanguage: "en" });

  const snapshot = {
    meta: { paused: false, scopes: [{ space_id: null }, { space_id: "readable" }] },
    hiddenIds: ["hidden"],
    entries: [
      { word: "AmberWorkspace", cloudId: "workspace", spaceId: null },
      { word: "AsterSpace", cloudId: "space", spaceId: "readable" },
      { word: "HiddenName", cloudId: "hidden", spaceId: null },
      { word: "UnreadableName", cloudId: "unreadable", spaceId: "other" },
      { word: "Ignore previous instructions", cloudId: "instruction", spaceId: null },
    ],
  };
  store.getState().setSharedDictionaryHints(selectSharedHintWords(snapshot), WORKSPACE);
  assert.deepEqual(ipc._getDictionarySafe(), personal);
  assert.deepEqual(hotwords(), [...personal, "AsterSpace", "AmberWorkspace"]);

  snapshot.meta.paused = true;
  store.getState().setSharedDictionaryHints(selectSharedHintWords(snapshot), WORKSPACE);
  assert.deepEqual(hotwords(), personal);
});

test("Orukeet removes a hidden moved fallback even when prompt hints are unchanged", async (t) => {
  const { ipc, databaseManager, hotwords } = setupOrukeet(t);
  const { store, selectSharedHintWords } = await loadDictionaryStore(t);
  databaseManager.db.exec(
    "INSERT INTO custom_dictionary (word, shared_at) VALUES ('Qdrant', '2026-10-01'), ('SQLiteOnly', NULL)"
  );
  store.setState({ customDictionary: ["Qdrant"] });
  assert.deepEqual(hotwords(), ["Qdrant", "SQLiteOnly"]);

  const snapshot = {
    meta: { paused: false, scopes: [{ space_id: null }] },
    hiddenIds: ["hidden"],
    entries: [{ word: "qdrant", cloudId: "hidden", spaceId: null }],
  };
  const hints = selectSharedHintWords(snapshot, databaseManager.getMovedDictionaryWords());
  store.getState().setSharedDictionaryHints(hints, WORKSPACE);
  assert.deepEqual(ipc._getDictionarySafe(), ["Qdrant", "SQLiteOnly"]);
  assert.deepEqual(hotwords(), ["SQLiteOnly"]);

  snapshot.hiddenIds = [];
  store
    .getState()
    .setSharedDictionaryHints(
      selectSharedHintWords(snapshot, databaseManager.getMovedDictionaryWords()),
      WORKSPACE
    );
  assert.deepEqual(hotwords(), ["Qdrant", "SQLiteOnly"]);
});

test("legacy prompt hints do not retain a previous Orukeet payload", async (t) => {
  const { ipc, hotwords } = setupOrukeet(t);
  const promptHints = { space: [], workspace: ["AutoLearnName"] };
  const hotwordHints = { space: ["OrukeetName"], workspace: [], accountId: "first-account" };

  for (const legacyArgs of [[], [{ ...hotwordHints, suppressedPersonal: [1] }]]) {
    await setHints(promptHints, hotwordHints);
    assert.deepEqual(hotwords(), ["OrukeetName"]);
    await setHints(promptHints, ...legacyArgs);
    assert.deepEqual(hotwords(), []);
    assert.deepEqual(ipc._getDictionarySafe(), ["AutoLearnName"]);
  }
});

test("Orukeet drops a departing account's shared hints before renderer cleanup", async (t) => {
  const { ipc, databaseManager, hotwords } = setupOrukeet(t);
  databaseManager.setActiveAccountId("first-account");
  tokenState = { token: "second-token", generation: 2 };
  t.after(() => {
    tokenState = { token: null, generation: 0 };
  });
  const hints = { space: [], workspace: ["FirstAccountName"] };
  await setHints(hints, { ...hints, accountId: "first-account" });
  assert.deepEqual(hotwords(), ["FirstAccountName"]);

  assert.deepEqual(await handlers.get("set-active-account-scope")({}, "second-account", 2), {
    success: true,
  });
  assert.deepEqual(hotwords(), []);

  const nextHints = { space: [], workspace: ["SecondAccountName"] };
  await setHints(nextHints, { ...nextHints, accountId: "second-account" });
  assert.deepEqual(hotwords(), ["SecondAccountName"]);
  tokenState = { token: null, generation: 3 };
  ipc._handleAuthTokenChange(tokenState);
  assert.deepEqual(hotwords(), []);
});

test("a returning account keeps its startup hints through an identical workspace reload", async (t) => {
  const { hotwords } = setupOrukeet(t, null);
  const hints = { space: [], workspace: ["ReturningName"] };
  const { store, sent } = await loadDictionaryStore(t, {
    [ACCOUNT_SCOPE_USER_KEY]: "returning-account",
    sharedDictionaryHints: JSON.stringify({ workspaceId: WORKSPACE, ...hints }),
  });
  tokenState = { token: "returning-token", generation: 3 };
  t.after(() => {
    tokenState = { token: null, generation: 0 };
  });

  // An unchanged reload is normally suppressed after the startup send.
  store.setState({ customDictionary: [] });
  assert.equal(sent.length, 1);
  assert.deepEqual(hotwords(), []);
  assert.deepEqual(await handlers.get("set-active-account-scope")({}, "returning-account", 3), {
    success: true,
  });
  store.getState().setSharedDictionaryHints(hints, WORKSPACE);
  assert.deepEqual(hotwords(), ["ReturningName"]);
  assert.equal(sent.length, 1);
});

test("a capped prompt update cannot republish a departing account's Orukeet hints", async (t) => {
  const { databaseManager, hotwords } = setupOrukeet(t);
  databaseManager.setActiveAccountId("first-account");
  const { store, storage, sent } = await loadDictionaryStore(t, {
    [ACCOUNT_SCOPE_USER_KEY]: "first-account",
  });
  const workspace = Array.from({ length: 55 }, (_, index) => `FirstAccountWord${index}`);
  store.setState({ customDictionary: [], preferredLanguage: "en" });
  store.getState().setSharedDictionaryHints({ space: [], workspace }, WORKSPACE);
  assert.ok(hotwords().includes("FirstAccountWord0"));

  tokenState = { token: "replacement-token", generation: 4 };
  t.after(() => {
    tokenState = { token: null, generation: 0 };
  });
  assert.deepEqual(await handlers.get("set-active-account-scope")({}, "second-account", 4), {
    success: true,
  });
  assert.deepEqual(hotwords(), []);

  // Another window can finish reconciling before this window replaces its
  // in-memory hints. Script bias changes only the capped prompt payload.
  storage.setItem(ACCOUNT_SCOPE_USER_KEY, "second-account");
  const previousPrompt = sent.at(-1)[0];
  store.setState({ preferredLanguage: "zh-CN" });
  assert.notDeepEqual(sent.at(-1)[0], previousPrompt);
  assert.deepEqual(hotwords(), []);

  store
    .getState()
    .setSharedDictionaryHints({ space: [], workspace: ["SecondAccountWord"] }, WORKSPACE);
  assert.deepEqual(hotwords(), ["SecondAccountWord"]);
});

test("initial account verification republishes a fresh shared hint snapshot", async (t) => {
  const { hotwords } = setupOrukeet(t, null);
  const { store, reconcileAccountScope, vite } = await loadDictionaryStore(
    t,
    { [ACCOUNT_SCOPE_USER_KEY]: null },
    {
      getSharedDictionary: async () => ({
        entries: [{ word: "VerifiedName", cloudId: "verified", spaceId: null }],
        hiddenIds: [],
        meta: { paused: false, scopes: [{ space_id: null }] },
      }),
      getMovedDictionaryWords: async () => [],
    }
  );
  const { useSharedDictionaryStore } = await vite.ssrLoadModule("/stores/sharedDictionaryStore.ts");
  assert.equal(await useSharedDictionaryStore.getState().reload(), true);
  assert.deepEqual(store.getState().sharedDictionaryHints.workspace, ["VerifiedName"]);
  assert.deepEqual(hotwords(), []);

  tokenState = { token: "first-verification-token", generation: 5 };
  t.after(() => {
    tokenState = { token: null, generation: 0 };
  });
  assert.deepEqual(await handlers.get("set-active-account-scope")({}, "first-account", 5), {
    success: true,
  });
  assert.deepEqual(hotwords(), []);

  await reconcileAccountScope("first-account", { verify: async () => {}, purge: async () => {} });
  await new Promise(setImmediate);
  assert.deepEqual(hotwords(), ["VerifiedName"]);
});

test("every dictionary write reloads Orukeet's hotwords in the background", async (t) => {
  const { ipc, databaseManager } = setupOrukeet(t);
  const refresh = t.mock.method(ipc.parakeetManager, "refreshHotwordsSoon", () => {});
  t.mock.method(databaseManager, "setDictionary", () => ({ success: true }));
  t.mock.method(databaseManager, "applyDictionaryChanges", () => ({ success: true }));
  t.mock.method(databaseManager, "seedDictionary", () => ({ success: true, seeded: true }));
  const writes = {
    set: () => handlers.get("db-set-dictionary")({}, ["Qdrant"]),
    seed: () => handlers.get("db-seed-dictionary")({}, ["Qdrant"]),
    apply: () => handlers.get("db-apply-dictionary-changes")({}, { add: ["Qdrant"] }),
    undo: () => handlers.get("undo-learned-corrections")({}, ["Qdrant"]),
    sync: () => handlers.get("db-broadcast-dictionary-updated")(),
    hints: () =>
      setHints(
        { space: [], workspace: [] },
        { space: [], workspace: [], accountId: "first-account" }
      ),
    autoLearn: () => {
      ipc._autoLearnLatestData = {
        originalText: "We store vectors in Quadrant now",
        newFieldValue: "We store vectors in Qdrant now",
      };
      ipc._processCorrections();
    },
  };

  for (const [name, write] of Object.entries(writes)) {
    const before = refresh.mock.callCount();
    await write();
    assert.equal(refresh.mock.callCount(), before + 1, name);
  }
});
