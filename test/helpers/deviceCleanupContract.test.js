const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CACHE_ENTRIES,
  MODEL_CACHE_ENTRIES,
  MODEL_USER_DATA_ENTRIES,
  USER_DATA_ENTRIES,
} = require("../../src/helpers/localDataWipe");

const ipcHandlersSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
  "utf8"
);

const cleanupHandler = ipcHandlersSource.match(
  /ipcMain\.handle\("cleanup-app", async \(event\) => \{([\s\S]*?)ipcMain\.handle\("update-hotkey"/
);

test("explicit device cleanup covers models, credentials, caches, and browser settings", () => {
  assert.ok(cleanupHandler, "cleanup-app handler is present");
  const source = cleanupHandler[1];

  for (const operation of [
    "deleteAllParakeetModels",
    "diarizationManager?.deleteModels",
    "modelManager.deleteAllModels",
    "environmentManager?.clearAllPersistedData",
    "tokenStore.clear",
    "clearStorageData",
    "clearCache",
    "setAutoStartEnabled(false)",
    // #3030: the files go through the inventory the offboarding wipe shares.
    "removeLocalData({ includeModels: true })",
  ]) {
    assert.ok(source.includes(operation), `device cleanup includes ${operation}`);
  }
  // Every channel on the device (production, staging, dev) shares the keyring
  // master key: deleting it here would make the others' saved keys unreadable.
  assert.ok(!source.includes("deleteMasterKey"), "device cleanup keeps the shared master key");

  const caches = [...CACHE_ENTRIES, ...MODEL_CACHE_ENTRIES];
  for (const cacheName of ["embedding-models", "qdrant-data", "qdrant-data-dev", "yt-dlp"])
    assert.ok(caches.includes(cacheName), `device cleanup removes ${cacheName}`);

  const userData = [...USER_DATA_ENTRIES, ...MODEL_USER_DATA_ENTRIES];
  for (const fileName of [
    "account-scope-binding.json",
    "installed-models.json",
    "model-registry.json",
    "model-registry.json.backup",
    "paid-key-checks.json",
    "connectors",
  ])
    assert.ok(userData.includes(fileName), `device cleanup removes ${fileName}`);
});

test("Reset app removes the skills folder and its versions folder", () => {
  for (const directoryName of ["bin", "llama-cpp", "connectors", "skills", "skill-versions"])
    assert.ok(USER_DATA_ENTRIES.includes(directoryName), `device cleanup removes ${directoryName}`);
});

// cleanup-app can't run outside Electron (it closes the database, clears
// sessions and relaunches), so this pins the order in its source. Settings
// signs out before calling it, so the revoke must not depend on a signed-in
// account (revokeAllStored reads every account's login from disk). It still
// needs the receipts database, for the cancelled receipts of pending cards,
// and the connector files themselves.
test("device cleanup revokes every stored connector login before the files and receipts go", () => {
  assert.ok(cleanupHandler, "cleanup-app handler is present");
  const source = cleanupHandler[1];
  const revoke = source.indexOf("this.connectorManager?.revokeAllStored()");
  assert.ok(
    revoke >= 0,
    "device cleanup revokes connector logins (Slack, Gmail) at their providers"
  );
  assert.ok(
    !source.includes("this.connectorManager?.disconnectAll()"),
    "device cleanup doesn't use disconnectAll, which needs a signed-in account"
  );

  for (const later of ["this.databaseManager?.db?.close()", "removeLocalData("]) {
    const at = source.indexOf(later);
    assert.ok(at >= 0, `device cleanup still contains ${later}`);
    assert.ok(revoke < at, `connector logins are revoked before ${later}`);
  }
});
