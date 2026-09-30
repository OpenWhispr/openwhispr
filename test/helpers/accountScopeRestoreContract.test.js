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
    /ipcMain\.handle\("set-active-account-scope"([\s\S]*?)ipcMain\.handle\(\s*"delete-account-data"/
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

// What the handler does on a cleared token is tested in accountScopeIpc.test.js.
test("every bearer token change reaches the handler that clears the scope", () => {
  const source = read("src/helpers/ipcHandlers.js");
  assert.ok(source.includes("tokenStore.subscribe((state) => this._handleAuthTokenChange(state))"));
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

test("account-scoped accessibility readiness is revalidated before opening the sticky gate", () => {
  const source = read("main.js");
  const handler = source.match(
    /ipcMain\.on\("mac-accessibility-features-ready"([\s\S]*?)\/\/ Listen for usage limit/
  );
  assert.ok(handler, "macOS accessibility readiness handler is present");
  assert.ok(handler[1].includes("resolveActiveAccountScope"));
  assert.ok(handler[1].includes("matchesActiveAccountScope"));
  assert.ok(
    handler[1].indexOf("matchesActiveAccountScope") <
      handler[1].indexOf("macAccessibilityFeaturesReady = true"),
    "the current scope is checked before the readiness gate opens"
  );
});
