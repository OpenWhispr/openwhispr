const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const syncServiceSource = fs.readFileSync(
  path.join(__dirname, "../../src/services/SyncService.ts"),
  "utf8"
);

// Bookkeeping keys that share the prefix but are not delta cursors.
const NON_CURSOR_KEYS = new Set(["lastSyncedAt.accountId", "lastSyncedAt.byAccount."]);

// teamCursorLagging() builds the team and personal cursor names from its kind.
const TEMPLATE_KINDS = ["folders", "notes"];

function declaredCursorKeys() {
  const match = syncServiceSource.match(/const SYNC_CURSOR_KEYS = \[([\s\S]*?)\];/);
  assert.ok(match, "SYNC_CURSOR_KEYS is declared");
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

function referencedCursorKeys() {
  const keys = new Set();
  for (const [, key] of syncServiceSource.matchAll(/["`](lastSyncedAt\.[^"`]+)["`]/g)) {
    if (key.includes("${kind}")) {
      for (const kind of TEMPLATE_KINDS) keys.add(key.replace("${kind}", kind));
    } else if (!NON_CURSOR_KEYS.has(key)) {
      keys.add(key);
    }
  }
  return keys;
}

// An account switch saves and restores exactly SYNC_CURSOR_KEYS; a cursor
// missing from the list would carry one account's position into another's
// pulls and skip that account's older rows.
test("every lastSyncedAt cursor SyncService reads or writes is saved per account", () => {
  const declared = declaredCursorKeys();
  for (const key of referencedCursorKeys()) {
    assert.ok(declared.has(key), `${key} is missing from SYNC_CURSOR_KEYS`);
  }
});
