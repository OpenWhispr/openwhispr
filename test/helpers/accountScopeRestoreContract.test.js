const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

// The offline scope-restore behavior hangs off wiring points that unit
// tests cannot reach; pin them at the source level.
test("scope handler evaluates requests through the binding policy and persists validated bindings", () => {
  const source = read("src/helpers/ipcHandlers.js");
  const handler = source.match(
    /ipcMain\.handle\("set-active-account-scope"([\s\S]*?)ipcMain\.handle\("delete-account-data"/
  );
  assert.ok(handler, "set-active-account-scope handler is present");
  assert.ok(
    handler[1].includes("accountScopeBinding.evaluateScopeRequest"),
    "handler delegates its gate to evaluateScopeRequest"
  );
  assert.ok(
    handler[1].includes("accountScopeBinding.persist(accountId, state.token)"),
    "validated non-null scope persists the binding"
  );
  assert.ok(
    handler[1].includes("accountScopeBinding.clear()"),
    "validated signed-out scope clears the binding"
  );
});

test("clearing the bearer token also clears the persisted scope binding", () => {
  const source = read("src/helpers/ipcHandlers.js");
  const subscription = source.match(
    /tokenStore\.subscribe\(\(\{ generation, token \}\) => \{([\s\S]*?)broadcastToWindows/
  );
  assert.ok(subscription, "token subscription is present");
  assert.ok(subscription[1].includes("setActiveAccountId(null)"));
  assert.ok(subscription[1].includes("accountScopeBinding.clear()"));
});

test("boot restores the validated scope before any main-process consumer constructs", () => {
  const source = read("main.js");
  const bootWindow = source.match(
    /databaseManager = new DatabaseManager\(\);([\s\S]*?)new IPCHandlers\(/
  );
  assert.ok(bootWindow, "DatabaseManager constructs before IPCHandlers");
  assert.ok(bootWindow[1].includes("resolveBootAccountScope"));
  assert.ok(bootWindow[1].includes("databaseManager.setActiveAccountId(bootAccountId)"));
});
