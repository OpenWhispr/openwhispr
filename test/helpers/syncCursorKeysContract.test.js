const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const syncServiceSource = fs.readFileSync(
  path.join(__dirname, "../../src/services/SyncService.ts"),
  "utf8"
);

// Keys that share the prefix but aren't personal delta cursors: bookkeeping, and
// the shared dictionary's, which are per workspace and cleared at sign-out.
const NON_CURSOR_KEYS = new Set([
  "lastSyncedAt.accountId",
  "lastSyncedAt.byAccount.",
  "lastSyncedAt.sharedDictionary",
]);

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

// A replay counter says whether an account's note cursors were ever replayed
// from the feed's start. Left device-wide, another account's first pull would
// mark the replay done for everyone.
test("the note feed's replay counters are saved per account with the cursors", () => {
  const saved = syncServiceSource.match(/const ACCOUNT_SYNC_STATE_KEYS = \[([\s\S]*?)\];/);
  assert.ok(saved, "ACCOUNT_SYNC_STATE_KEYS is declared");
  assert.match(saved[1], /\.\.\.SYNC_CURSOR_KEYS\b/, "it carries every cursor");

  const replayKeys = [
    ...syncServiceSource.matchAll(/const (NOTE_FEED_REPLAY\w*_KEY) = "noteFeedReplay[^"]*";/g),
  ].map((match) => match[1]);
  assert.ok(replayKeys.length > 0, "the replay counters are named constants");
  for (const name of replayKeys) {
    assert.match(saved[1], new RegExp(`\\b${name}\\b`), `${name} is missing from it`);
  }
  assert.equal(
    [...syncServiceSource.matchAll(/["`]noteFeedReplay[^"`]*["`]/g)].length,
    replayKeys.length,
    "no replay counter is built outside those constants"
  );
  assert.doesNotMatch(
    syncServiceSource,
    /for \(const key of SYNC_CURSOR_KEYS\)/,
    "an account switch saves and restores the whole set, not the cursors alone"
  );
});
