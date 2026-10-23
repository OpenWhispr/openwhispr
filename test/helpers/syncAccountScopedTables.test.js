// Transcriptions, chats, dictionary words and snippets are per-account cloud
// data, but used to live in device-global SQLite tables. After an account
// switch the next account saw, edited and pushed the previous one's rows with
// its own token: a dictionary or snippet PATCH 404'd on the other account's
// cloud id, the 404 cleared it, and the next pass re-created the row in the
// wrong account. Rows a signed-out account left pending were uploaded the
// same way. Real DatabaseManager and SyncService; only HTTP is faked, with one
// fake cloud per account.

const test = require("node:test");
const fs = require("node:fs");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");

const CURSOR_KEYS = [
  "lastSyncedAt.folders",
  "lastSyncedAt.notes",
  "lastSyncedAt.conversations",
  "lastSyncedAt.transcriptions",
  "lastSyncedAt.dictionary",
  "lastSyncedAt.dictionary.id",
  "lastSyncedAt.snippets",
  "lastSyncedAt.snippets.id",
];

// What useAuth leaves behind on an account boundary: the main process scopes
// the local rows to the account and the renderer holds a validated session
// for it. Cursors are dropped as #2892's per-account cursors do for an account
// with none saved, so each account's first pass reads its whole history.
async function signInAs(t, db, cloud, accountId) {
  for (const key of CURSOR_KEYS) localStorageStub.removeItem(key);
  db.setActiveAccountId(accountId);
  windowStub.electronAPI = createElectronApi(db, { cloud, snippets: true });
  await establishValidatedAuth(accountId);
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return service;
}

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  return db;
}

test("a dictionary word another account pulled is neither shown to nor re-created by the next account", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createFakeCloud();
  const cloudB = createFakeCloud();
  const bWord = cloudB.seedDictionaryEntry({ word: "Kubernetes", client_dict_id: "b-dict" });

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);
  assert.deepEqual(db.getDictionary(), ["Kubernetes"], "B's word reaches the device for B");

  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  assert.deepEqual(db.getDictionary(), [], "A must not see B's dictionary");

  // A recases the word as the settings list would if B's row were visible.
  db.applyDictionaryChanges({ add: ["KUBERNETES"] });
  await accountA.syncAll(true);
  await accountA.syncAll(true);

  assert.equal(
    cloudA.dictionary().some((row) => row.client_dict_id === bWord.client_dict_id),
    false,
    "B's dictionary row must never be re-created in A's cloud"
  );
  assert.equal(
    cloudA.logFor("/api/dictionary/update").length,
    0,
    "A never PATCHes B's cloud id with A's token"
  );

  await signInAs(t, db, cloudB, "account-b");
  const bRow = db.getDictionaryEntryByClientId(bWord.client_dict_id);
  assert.equal(bRow?.word, "Kubernetes", "B's own row is untouched");
  assert.equal(bRow?.cloud_id, bWord.id);
  assert.equal(bRow?.sync_status, "synced");
});

test("two accounts on one device can each hold the same dictionary word", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudB = createFakeCloud();
  cloudB.seedDictionaryEntry({ word: "Kubernetes", client_dict_id: "b-dict" });

  db.setActiveAccountId("account-a");
  db.applyDictionaryChanges({ add: ["Kubernetes"] });
  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);

  assert.deepEqual(db.getDictionary(), ["Kubernetes"]);
  assert.equal(db.getDictionaryEntryByClientId("b-dict")?.cloud_id, "dict-0001");
  db.setActiveAccountId("account-a");
  const [aRow] = db.getPendingDictionary();
  assert.equal(aRow?.word, "Kubernetes", "A's own copy keeps its pending upload");
  assert.equal(aRow?.cloud_id, null, "A's copy never adopts B's cloud identity");
});

test("a snippet another account pulled is neither shown to nor re-created by the next account", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createFakeCloud();
  const cloudB = createFakeCloud();
  const bSnippet = cloudB.seedSnippet({
    trigger: "addr",
    replacement: "B's home address",
    client_snippet_id: "b-snippet",
  });

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);
  assert.deepEqual(db.getSnippets(), [{ trigger: "addr", replacement: "B's home address" }]);

  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  assert.deepEqual(db.getSnippets(), [], "A must not see B's snippets");

  db.setSnippets([{ trigger: "addr", replacement: "A's office address" }]);
  await accountA.syncAll(true);
  await accountA.syncAll(true);

  assert.equal(
    cloudA.snippets().some((row) => row.client_snippet_id === bSnippet.client_snippet_id),
    false,
    "B's snippet row must never be re-created in A's cloud"
  );
  assert.equal(cloudA.logFor("/api/snippets/update").length, 0);
  assert.deepEqual(
    cloudA.snippets().map((row) => row.replacement),
    ["A's office address"],
    "A's own snippet still uploads"
  );

  await signInAs(t, db, cloudB, "account-b");
  assert.deepEqual(
    db.getSnippets(),
    [{ trigger: "addr", replacement: "B's home address" }],
    "A's snippet with the same trigger neither replaced nor deleted B's"
  );
});

test("transcriptions another account dictated or pulled stay out of the next account's history and cloud", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createFakeCloud();

  db.setActiveAccountId("account-b");
  db.upsertTranscriptionFromCloud({
    id: "b-cloud-trans",
    client_transcription_id: "b-pulled",
    text: "B's pulled dictation",
    created_at: "2026-10-01T09:00:00.000Z",
  });
  // Dictated by B while offline, so it never reached B's cloud.
  db.saveTranscription("B's offline dictation", null, { clientTranscriptionId: "b-pending" });

  const accountA = await signInAs(t, db, cloudA, "account-a");
  assert.deepEqual(db.getTranscriptions(), [], "A must not see B's history");
  await accountA.syncAll(true);

  const uploaded = cloudA
    .logFor("/api/transcriptions/batch-create")
    .flatMap((call) => call.body.transcriptions.map((row) => row.client_transcription_id));
  assert.deepEqual(uploaded, [], "B's pending dictation must not upload with A's token");

  db.clearTranscriptions();
  db.setActiveAccountId("account-b");
  assert.deepEqual(
    db
      .getTranscriptions()
      .map((row) => row.text)
      .sort(),
    ["B's offline dictation", "B's pulled dictation"],
    "A's Clear history leaves B's rows alone"
  );
});

test("chats another account pulled or started stay out of the next account's lists and cloud", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createFakeCloud();
  const cloudB = createFakeCloud();
  cloudB.seedConversation({
    client_conversation_id: "b-conversation",
    title: "B's chat",
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:00:00.000Z",
    messages: [{ role: "user", content: "hello from B", created_at: "2026-10-01T09:00:00.000Z" }],
  });

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);
  const pulled = db.getConversationByClientId("b-conversation");
  assert.equal(pulled?.title, "B's chat");
  const local = db.createAgentConversation("B's unsynced chat");

  const accountA = await signInAs(t, db, cloudA, "account-a");
  assert.deepEqual(db.getAgentConversations(), [], "A must not list B's chats");
  assert.deepEqual(db.getAgentConversationsWithPreview(), []);
  assert.equal(db.getAgentConversation(pulled.id), null, "A cannot open B's chat by id");
  assert.equal(db.getConversationByClientId("b-conversation"), null);
  assert.equal(db.deleteAgentConversation(local.id)?.success, false, "A cannot delete B's chat");

  await accountA.syncAll(true);
  assert.equal(
    cloudA.logFor("/api/conversations/create").length,
    0,
    "B's unsynced chat must not upload with A's token"
  );
});

test("rows written before account attribution stay visible to every account", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId(null);
  db.saveTranscription("legacy dictation");
  db.applyDictionaryChanges({ add: ["legacy-word"] });
  db.setSnippets([{ trigger: "sig", replacement: "legacy signature" }]);
  db.createAgentConversation("legacy chat");

  for (const accountId of ["account-a", "account-b"]) {
    db.setActiveAccountId(accountId);
    assert.deepEqual(
      db.getTranscriptions().map((row) => row.text),
      ["legacy dictation"]
    );
    assert.deepEqual(db.getDictionary(), ["legacy-word"]);
    assert.deepEqual(db.getSnippets(), [{ trigger: "sig", replacement: "legacy signature" }]);
    assert.deepEqual(
      db.getAgentConversations().map((row) => row.title),
      ["legacy chat"]
    );
  }
});

test("deleting an account erases its transcriptions, chats, words and snippets only", async (t) => {
  const db = setup(t);
  if (!db) return;
  for (const accountId of ["account-a", "account-b"]) {
    db.setActiveAccountId(accountId);
    db.saveTranscription(`${accountId} dictation`);
    db.applyDictionaryChanges({ add: [`${accountId}-word`] });
    db.setSnippets([{ trigger: `${accountId}-sig`, replacement: "signature" }]);
    const conversation = db.createAgentConversation(`${accountId} chat`);
    db.addAgentMessage(conversation.id, "user", "hello");
  }

  db.setActiveAccountId("account-a");
  db.deleteAccountData("account-a");

  const count = (table, accountId) =>
    db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(accountId).n;
  for (const table of ["transcriptions", "custom_dictionary", "snippets", "agent_conversations"]) {
    assert.equal(count(table, "account-a"), 0, `${table} rows of the deleted account are gone`);
    assert.equal(count(table, "account-b"), 1, `${table} rows of the other account remain`);
  }
  assert.equal(
    db.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id NOT IN (SELECT id FROM agent_conversations)"
      )
      .get().n,
    0,
    "no orphaned chat messages are left behind"
  );
});

test("an unattributed word whose cloud row 404s is never re-created, and its owner claims it", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createFakeCloud();
  const cloudB = createFakeCloud();
  // Before attribution, B's pulled word looked like anyone's; A then recased it.
  const bWord = cloudB.seedDictionaryEntry({ word: "Kubernetes", client_dict_id: "b-dict" });
  db.db
    .prepare(
      `INSERT INTO custom_dictionary (word, source, client_dict_id, cloud_id, sync_status, updated_at)
       VALUES ('KUBERNETES', 'manual', ?, ?, 'pending', datetime('now'))`
    )
    .run(bWord.client_dict_id, bWord.id);

  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  await accountA.syncAll(true);
  assert.equal(cloudA.dictionary().length, 0, "the 404 must not copy the word into A's cloud");
  const kept = db.getDictionaryEntryByClientId(bWord.client_dict_id);
  assert.equal(kept?.cloud_id, bWord.id, "the row keeps the cloud id its owner can still update");
  assert.equal(kept?.sync_status, "pending");

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);
  assert.equal(cloudB.dictionary()[0].word, "KUBERNETES", "the owner's pass delivers the edit");
  assert.equal(db.getDictionaryEntryByClientId(bWord.client_dict_id)?.account_id, "account-b");
  db.setActiveAccountId("account-a");
  assert.deepEqual(db.getDictionary(), [], "once claimed, the word leaves A's view");
});

test("a dictionary from before per-account words upgrades in place", async (t) => {
  const db = setup(t);
  if (!db) return;
  const DatabaseManager = db.constructor;
  const dbPath = db.db.name;
  db.db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });

  const BetterSqlite = require("better-sqlite3");
  const legacy = new BetterSqlite(dbPath);
  legacy.exec(`
    CREATE TABLE custom_dictionary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE custom_dictionary ADD COLUMN client_dict_id TEXT;
    ALTER TABLE custom_dictionary ADD COLUMN cloud_id TEXT;
    INSERT INTO custom_dictionary (word, client_dict_id, cloud_id) VALUES ('Alpha', 'alpha-client', 'alpha-cloud');
    INSERT INTO custom_dictionary (word, client_dict_id) VALUES ('Beta', 'beta-client');
    INSERT INTO custom_dictionary (word, client_dict_id) VALUES ('Gamma', 'gamma-client');
    DELETE FROM custom_dictionary WHERE word = 'Gamma';
  `);
  legacy.close();

  const upgraded = new DatabaseManager();
  t.after(() => upgraded.db?.close());
  assert.equal(
    upgraded.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_autoindex_custom_dictionary%'"
      )
      .get().n,
    0,
    "the device-wide UNIQUE(word) is gone"
  );
  upgraded.setActiveAccountId("account-a");
  assert.deepEqual(
    upgraded.getDictionary(),
    ["Alpha", "Beta"],
    "every word survives, unattributed"
  );
  assert.equal(upgraded.getDictionaryEntryByClientId("alpha-client")?.cloud_id, "alpha-cloud");

  upgraded.setActiveAccountId("account-b");
  upgraded.upsertDictionaryFromCloud({ id: "b-cloud", client_dict_id: "b-client", word: "Delta" });
  upgraded.setActiveAccountId("account-a");
  upgraded.applyDictionaryChanges({ add: ["Delta"] });
  const delta = upgraded.db
    .prepare(
      "SELECT account_id, client_dict_id FROM custom_dictionary WHERE word = 'Delta' ORDER BY id"
    )
    .all();
  assert.deepEqual(
    delta.map((row) => row.account_id),
    ["account-b", "account-a"],
    "both accounts hold their own Delta"
  );
  assert.ok(delta[1].client_dict_id, "the client id trigger still fills new rows");
  assert.ok(
    upgraded.db.prepare("SELECT MAX(id) AS id FROM custom_dictionary").get().id > 4,
    "AUTOINCREMENT does not reuse the deleted word's id"
  );
});

test("reconstructed Insights counters stay with the account that dictated them", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-b");
  db.upsertTranscriptionFromCloud({
    id: "b-cloud-trans",
    client_transcription_id: "b-pulled",
    text: "three spoken words",
    created_at: "2026-10-01T09:00:00.000Z",
  });
  db.setActiveAccountId("account-a");

  db.backfillAnalyticsHistoryBatch();

  assert.equal(
    db.db.prepare("SELECT account_id FROM analytics_events WHERE event_id = 'b-pulled'").get()
      ?.account_id,
    "account-b"
  );
  assert.equal(
    db.countUnclaimedAnalyticsEvents(),
    0,
    "A's Insights opt-in has nothing of B's to claim"
  );
});

test("a word or snippet re-added while signed out stays hidden behind the account's own and never breaks its sync", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createFakeCloud();
  cloudA.seedDictionaryEntry({ word: "OpenWhispr", client_dict_id: "a-dict" });
  cloudA.seedSnippet({ trigger: "addr", replacement: "A's address", client_snippet_id: "a-snip" });

  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);

  // Signed out, the account's rows are out of scope: startup re-adds the agent
  // name and the user types the same trigger again.
  db.setActiveAccountId(null);
  assert.deepEqual(db.getDictionary(), []);
  db.applyDictionaryChanges({ add: ["OpenWhispr"] });
  db.setSnippets([{ trigger: "addr", replacement: "typed while signed out" }]);

  const accountA2 = await signInAs(t, db, cloudA, "account-a");
  assert.deepEqual(db.getDictionary(), ["OpenWhispr"], "the word is listed once");
  assert.deepEqual(db.getSnippets(), [{ trigger: "addr", replacement: "A's address" }]);
  assert.deepEqual(db.getPendingDictionary(), [], "the hidden copy is never pushed");
  assert.deepEqual(db.getPendingSnippets(), []);

  await accountA2.syncAll(true);
  assert.equal(cloudA.dictionary().length, 1);
  assert.equal(cloudA.snippets().length, 1);

  db.applyDictionaryChanges({ remove: ["OpenWhispr"] });
  assert.deepEqual(db.getDictionary(), [], "removing the word removes it from the list");
});

test("another account's pull never takes over a word or snippet someone already synced", async (t) => {
  const db = setup(t);
  if (!db) return;
  // From before attribution: account A's synced word and snippet.
  db.db
    .prepare(
      `INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, legacy_unattributed)
       VALUES ('foo', 'a-dict', 'a-cloud', 'synced', 1)`
    )
    .run();
  db.db
    .prepare(
      `INSERT INTO snippets (trigger, replacement, client_snippet_id, cloud_id, sync_status, legacy_unattributed)
       VALUES ('addr', 'A''s address', 'a-snip', 'a-snip-cloud', 'synced', 1)`
    )
    .run();
  const cloudB = createFakeCloud();
  cloudB.seedDictionaryEntry({ word: "Foo", client_dict_id: "b-dict" });
  cloudB.seedSnippet({ trigger: "addr", replacement: "B's address", client_snippet_id: "b-snip" });

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);
  assert.deepEqual(db.getDictionary(), ["Foo"], "B sees its own word, once");
  assert.deepEqual(db.getSnippets(), [{ trigger: "addr", replacement: "B's address" }]);

  db.setActiveAccountId("account-a");
  assert.deepEqual(db.getDictionary(), ["foo"], "A's word is still A's");
  assert.deepEqual(db.getSnippets(), [{ trigger: "addr", replacement: "A's address" }]);
  assert.equal(db.getDictionaryEntryByClientId("a-dict")?.cloud_id, "a-cloud");
});

test("pushing a row from before attribution doesn't hand it to the pushing account", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.saveTranscription("dictated before the upgrade", null, { clientTranscriptionId: "legacy" });
  db.db.prepare("UPDATE transcriptions SET legacy_unattributed = 1").run();
  db.saveTranscription("dictated signed out", null, { clientTranscriptionId: "signed-out" });
  const cloudB = createFakeCloud();

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);

  const owner = (clientId) =>
    db.db
      .prepare("SELECT account_id FROM transcriptions WHERE client_transcription_id = ?")
      .get(clientId).account_id;
  assert.equal(owner("legacy"), null, "an upload proves nothing about who dictated it");
  assert.equal(owner("signed-out"), "account-b", "a signed-out dictation joins the account");
  db.setActiveAccountId("account-a");
  assert.deepEqual(
    db.getTranscriptions().map((row) => row.client_transcription_id),
    ["legacy"],
    "the other account still sees the legacy row"
  );
});

test("an account switch while a push is in flight neither claims the row nor cleans up the cloud copy", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createFakeCloud();
  db.setActiveAccountId("account-a");
  db.applyDictionaryChanges({ add: ["Kubernetes"] });
  db.setActiveAccountId(null);
  db.saveTranscription("dictated signed out", null, { clientTranscriptionId: "signed-out" });

  const accountA = await signInAs(t, db, cloudA, "account-a");
  // The cloud answers each create after the user has switched to account B.
  const switchAccount = () => {
    db.setActiveAccountId("account-b");
    windowStub.electronAPI.authState.generation += 1;
    return false;
  };
  cloudA.failWith((call) => call.path === "/api/transcriptions/batch-create" && switchAccount());
  cloudA.failWith((call) => call.path === "/api/dictionary/batch-create" && switchAccount());
  await accountA.syncAll(true);

  const transcription = db.db
    .prepare("SELECT account_id, sync_status FROM transcriptions WHERE client_transcription_id = ?")
    .get("signed-out");
  assert.equal(transcription.account_id, null, "account B never claims A's upload");
  assert.equal(transcription.sync_status, "pending");
  assert.equal(cloudA.logFor("/api/dictionary/delete").length, 0, "no cleanup after a stale ack");
  db.setActiveAccountId("account-a");
  assert.equal(db.getPendingDictionary()[0]?.word, "Kubernetes", "A's word stays pending for A");
});

test("clearing one account's history leaves another account's Insights rebuildable", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-b");
  db.saveTranscription("B dictated this one", null, { clientTranscriptionId: "b-1" });
  db.setActiveAccountId("account-a");
  db.saveTranscription("A dictated this one", null, { clientTranscriptionId: "a-1" });

  db.clearTranscriptions();
  db.backfillAnalyticsHistoryBatch();

  const events = db.db.prepare("SELECT event_id, account_id FROM analytics_events").all();
  assert.deepEqual(events, [{ event_id: "b-1", account_id: "account-b" }]);
});

test("a cached list is seeded only into a database that has never held one", (t) => {
  const db = createDb(t);
  if (!db) return;
  assert.equal(db.seedDictionary(["Kubernetes"]).seeded, true);
  assert.equal(db.seedSnippets([{ trigger: "addr", replacement: "A's address" }]).seeded, true);

  db.db.prepare("UPDATE custom_dictionary SET account_id = 'account-a'").run();
  db.db.prepare("UPDATE snippets SET account_id = 'account-a'").run();
  db.setActiveAccountId("account-b");
  assert.equal(db.seedDictionary(["Kubernetes"]).seeded, false);
  assert.equal(db.seedSnippets([{ trigger: "addr", replacement: "A's address" }]).seeded, false);
  assert.deepEqual(db.getDictionary(), [], "A's cached words never land in B");
  assert.deepEqual(db.getSnippets(), []);
});

test("an older build can still open a database where two accounts share a trigger", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  db.setSnippets([{ trigger: "addr", replacement: "A" }]);
  db.setActiveAccountId("account-b");
  db.setSnippets([{ trigger: "addr", replacement: "B" }]);

  // What every build before per-account triggers runs at launch.
  assert.doesNotThrow(() =>
    db.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_lower_active ON snippets(lower(trigger)) WHERE deleted_at IS NULL"
    )
  );
});
