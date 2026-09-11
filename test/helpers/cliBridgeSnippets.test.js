const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-snip-"));
const originalLoad = Module._load;
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
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createBridge(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-snip-"));
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

const signOff = { trigger: "sign-off", replacement: "Best,\nGabe" };
const ask = { trigger: "investor ask", replacement: "We are raising a seed round." };

test("GET /v1/snippets/list returns the stored snippets", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  ctx.db.setSnippets([signOff, ask]);
  const result = call(ctx.bridge, "GET", "/v1/snippets/list");
  assert.deepEqual(result.data, [signOff, ask]);
});

test("POST /v1/snippets/update adds snippets and replaces an existing trigger", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  ctx.db.setSnippets([signOff]);
  const replaced = { trigger: "Sign-Off", replacement: "Cheers,\nGabe" };
  const result = call(ctx.bridge, "POST", "/v1/snippets/update", { add: [replaced, ask] });

  assert.equal(result.data.added, 2);
  assert.equal(result.data.removed, 0);
  assert.deepEqual(ctx.db.getSnippets(), [replaced, ask]);
});

test("POST /v1/snippets/update removes only the named triggers", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  ctx.db.setSnippets([signOff, ask]);
  const result = call(ctx.bridge, "POST", "/v1/snippets/update", { remove: ["Investor Ask"] });

  assert.equal(result.data.removed, 1);
  assert.deepEqual(ctx.db.getSnippets(), [signOff]);
});

test("POST /v1/snippets/update broadcasts the new list to renderers", async (t) => {
  await new Promise((resolve) => setImmediate(resolve));

  const ctx = createBridge(t);
  if (!ctx) return;

  call(ctx.bridge, "POST", "/v1/snippets/update", { add: [signOff] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.broadcasts.length, 1);
  assert.equal(ctx.broadcasts[0].channel, "snippets-updated");
  assert.deepEqual(ctx.broadcasts[0].payload, [signOff]);
});

test("POST /v1/snippets/update rejects malformed and empty requests", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(
    () => call(ctx.bridge, "POST", "/v1/snippets/update", { add: [{ trigger: "x" }] }),
    { code: "VALIDATION" }
  );
  assert.throws(() => call(ctx.bridge, "POST", "/v1/snippets/update", {}), {
    code: "VALIDATION",
  });
});
