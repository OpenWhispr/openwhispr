const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-dict-"));
const originalLoad = Module._load;
// Routes broadcast through the shared windowBroadcast module, which reaches for
// Electron's BrowserWindow; capture the calls so they can be asserted here.
const broadcasts = [];

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  if (request === "./windowBroadcast") {
    return {
      broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const CliBridge = require("../../src/helpers/cliBridge.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file")
  );
}

// Builds the route table against a real database with broadcasts stubbed. The
// constructor does not start a server, so routes can be invoked directly.
function createBridge(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-dict-"));
  let db;
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  broadcasts.length = 0;
  const bridge = new CliBridge({ databaseManager: db });
  return { bridge, db, broadcasts };
}

function call(bridge, method, pathname, body) {
  for (const route of bridge.routes) {
    if (route.method !== method) continue;
    const params = route.match(pathname);
    if (!params) continue;
    return route.handler({ params, query: new URLSearchParams(), body });
  }
  throw new Error(`No route for ${method} ${pathname}`);
}

test("GET /v1/dictionary/list returns the stored words", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr", "Alice"]);
  const result = call(ctx.bridge, "GET", "/v1/dictionary/list");
  assert.deepEqual(result.data, ["OpenWhispr", "Alice"]);
});

test("POST /v1/dictionary/update bulk-adds words that survive a reload", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr"]);
  const contacts = ["Ada Lovelace", "Grace Hopper", "Katherine Johnson"];
  const result = call(ctx.bridge, "POST", "/v1/dictionary/update", { add: contacts });

  assert.equal(result.data.added, 3);
  assert.deepEqual(ctx.db.getDictionary(), ["OpenWhispr", ...contacts]);

  // The point of the endpoint: rows arrive with the sync columns set, so they
  // are uploadable rather than invisible to the cloud push (#1295).
  const pending = ctx.db.getPendingDictionary().map((r) => r.word);
  for (const name of contacts) assert.ok(pending.includes(name), `${name} should be pending`);
  for (const row of ctx.db.getPendingDictionary()) assert.ok(row.client_dict_id);
});

test("POST /v1/dictionary/update removes only the named words", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr", "Alice", "Bob"]);
  const result = call(ctx.bridge, "POST", "/v1/dictionary/update", { remove: ["Alice"] });

  assert.equal(result.data.removed, 1);
  assert.deepEqual(ctx.db.getDictionary(), ["OpenWhispr", "Bob"]);
});

test("POST /v1/dictionary/update broadcasts the new list to renderers", async (t) => {
  // The route defers its broadcast with setImmediate, and the synchronous tests
  // above never yield to the event loop, so their broadcasts are still queued
  // here. Let them land before createBridge resets the recorder, or they are
  // counted against this test.
  await new Promise((resolve) => setImmediate(resolve));

  const ctx = createBridge(t);
  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr"]);
  call(ctx.bridge, "POST", "/v1/dictionary/update", { add: ["Alice"] });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.broadcasts.length, 1);
  assert.equal(ctx.broadcasts[0].channel, "dictionary-updated");
  assert.deepEqual(ctx.broadcasts[0].payload, ["OpenWhispr", "Alice"]);
});

test("POST /v1/dictionary/update rejects a non-array field", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "POST", "/v1/dictionary/update", { add: "Alice" }), {
    code: "VALIDATION",
  });
});

test("POST /v1/dictionary/update rejects non-string entries", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "POST", "/v1/dictionary/update", { add: ["Alice", 7] }), {
    code: "VALIDATION",
  });
});

test("POST /v1/dictionary/update rejects an empty request", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "POST", "/v1/dictionary/update", {}), {
    code: "VALIDATION",
  });
});
