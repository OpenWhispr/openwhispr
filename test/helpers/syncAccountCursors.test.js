// Pull cursors are per account, and rows from before attribution are claimed by
// the account whose cloud holds them. Real DatabaseManager and SyncService; only
// HTTP is faked, with one fake cloud per account, and nothing resets a cursor
// between sign-ins: that's the real flow.

const test = require("node:test");
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
const { createAccountCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { cloudPostForAuthGeneration } = require("../../src/services/cloudApi.ts");
const { getValidatedAuthGeneration } = require("../../src/lib/authRequestContext.ts");

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  return db;
}

async function signInAs(t, db, cloud, accountId) {
  db.setActiveAccountId(accountId);
  windowStub.electronAPI = createElectronApi(db, { cloud, snippets: true });
  await establishValidatedAuth(accountId);
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return service;
}

function seedHistory(cloud, tag, at) {
  return {
    word: cloud.seedDictionaryEntry({
      word: `${tag}Word`,
      client_dict_id: `${tag}-dict`,
      created_at: at,
      updated_at: at,
    }),
    snippet: cloud.seedSnippet({
      trigger: `${tag}trig`,
      replacement: "x",
      client_snippet_id: `${tag}-snip`,
      created_at: at,
      updated_at: at,
    }),
    chat: cloud.seedConversation({
      title: `${tag} chat`,
      client_conversation_id: `${tag}-chat`,
      created_at: at,
      updated_at: at,
      messages: [{ role: "user", content: `${tag} asked`, created_at: at }],
    }),
    dictation: cloud.seedTranscription({
      text: `${tag} dictation`,
      client_transcription_id: `${tag}-dictation`,
      created_at: at,
      updated_at: at,
    }),
  };
}

function visible(db) {
  return {
    words: db.getDictionary(),
    snippets: db.getSnippets().map((snippet) => snippet.trigger),
    chats: db.getAgentConversations().map((chat) => chat.title),
    dictations: db.getTranscriptions().map((row) => row.text),
  };
}

// A database as an older build left it: rows nobody owns, marked by the upgrade.
// Each row's cloud copy is in `cloud`, and the older build's pass left cursors
// past all of them, with no owner recorded.
function seedUpgradedDevice(db, cloud, at) {
  const seeded = seedHistory(cloud, "old", at);
  db.setActiveAccountId(null);
  const rows = [
    ["custom_dictionary", "client_dict_id", "old-dict"],
    ["snippets", "client_snippet_id", "old-snip"],
    ["agent_conversations", "client_conversation_id", "old-chat"],
    ["transcriptions", "client_transcription_id", "old-dictation"],
  ];
  db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, updated_at) VALUES ('oldWord', 'old-dict', ?, 'synced', ?)"
    )
    .run(seeded.word.id, at);
  db.db
    .prepare(
      "INSERT INTO snippets (trigger, replacement, client_snippet_id, cloud_id, sync_status, updated_at) VALUES ('oldtrig', 'x', 'old-snip', ?, 'synced', ?)"
    )
    .run(seeded.snippet.id, at);
  db.db
    .prepare(
      "INSERT INTO agent_conversations (title, client_conversation_id, cloud_id, sync_status, updated_at) VALUES ('old chat', 'old-chat', ?, 'synced', ?)"
    )
    .run(seeded.chat.id, at);
  db.db
    .prepare(
      "INSERT INTO transcriptions (text, client_transcription_id, cloud_id, sync_status, created_at) VALUES ('old dictation', 'old-dictation', ?, 'synced', ?)"
    )
    .run(seeded.dictation.id, at);
  for (const [table] of rows) {
    db.db.prepare(`UPDATE ${table} SET legacy_unattributed = 1 WHERE account_id IS NULL`).run();
  }
  const cursor = new Date().toISOString();
  for (const key of ["conversations", "transcriptions", "dictionary", "snippets"]) {
    localStorageStub.setItem(`lastSyncedAt.${key}`, cursor);
  }
  localStorageStub.setItem("dictionarySharedAtBackfill", "true");
  return rows;
}

function owners(db, rows) {
  return rows.map(
    ([table, key, id]) =>
      db.db.prepare(`SELECT account_id FROM ${table} WHERE ${key} = ?`).get(id)?.account_id
  );
}

test("an account's first pass reads its older rows, whatever the last account's cursors say", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const cloudB = createAccountCloud();
  seedHistory(cloudA, "a", daysAgo(1));
  seedHistory(cloudB, "b", daysAgo(30));

  await (await signInAs(t, db, cloudA, "account-a")).syncAll(true);
  assert.deepEqual(visible(db), {
    words: ["aWord"],
    snippets: ["atrig"],
    chats: ["a chat"],
    dictations: ["a dictation"],
  });

  await (await signInAs(t, db, cloudB, "account-b")).syncAll(true);
  assert.deepEqual(visible(db), {
    words: ["bWord"],
    snippets: ["btrig"],
    chats: ["b chat"],
    dictations: ["b dictation"],
  });
});

test("an account returning after another one synced gets what changed meanwhile, deletes included", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const cloudB = createAccountCloud();
  const seeded = seedHistory(cloudA, "a", daysAgo(5));

  await (await signInAs(t, db, cloudA, "account-a")).syncAll(true);
  await (await signInAs(t, db, cloudB, "account-b")).syncAll(true);

  // From A's phone, while this device is on B.
  cloudA.deleteConversation(seeded.chat.id);
  cloudA.deleteTranscription(seeded.dictation.id);
  cloudA.seedDictionaryEntry({ word: "fromPhone", client_dict_id: "phone-dict" });
  cloudA.seedConversation({ title: "phone chat", client_conversation_id: "phone-chat" });
  await (await signInAs(t, db, cloudB, "account-b")).syncAll(true);

  await (await signInAs(t, db, cloudA, "account-a")).syncAll(true);
  const { words, chats, dictations } = visible(db);
  assert.deepEqual(words.sort(), ["aWord", "fromPhone"]);
  assert.deepEqual(chats, ["phone chat"]);
  assert.deepEqual(dictations, []);
});

test("signing back in as the same account keeps its cursors", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  seedHistory(cloudA, "a", daysAgo(5));
  await (await signInAs(t, db, cloudA, "account-a")).syncAll(true);
  const cursor = localStorageStub.getItem("lastSyncedAt.conversations");
  assert.ok(cursor);

  db.setActiveAccountId(null);
  const service = await signInAs(t, db, cloudA, "account-a");
  const lists = cloudA.logFor("/api/conversations/list").length;
  await service.syncAll(true);
  const nextList = cloudA.logFor("/api/conversations/list")[lists];
  assert.ok(
    new URLSearchParams(nextList.path.split("?")[1]).get("since"),
    "a delta, not a snapshot"
  );
});

test("after an upgrade the first pass claims what the account's cloud holds, and the next account sees none of it", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const rows = seedUpgradedDevice(db, cloudA, daysAgo(5));

  const accountA = await signInAs(t, db, cloudA, "account-a");
  const cursorBefore = localStorageStub.getItem("lastSyncedAt.conversations");
  await accountA.syncAll(true);
  assert.deepEqual(owners(db, rows), Array(4).fill("account-a"));
  assert.notEqual(
    localStorageStub.getItem("lastSyncedAt.conversations"),
    null,
    "the claim leaves delta sync running"
  );
  assert.ok(localStorageStub.getItem("lastSyncedAt.conversations") >= cursorBefore);

  await (await signInAs(t, db, createAccountCloud(), "account-b")).syncAll(true);
  assert.deepEqual(visible(db), { words: [], snippets: [], chats: [], dictations: [] });

  await signInAs(t, db, cloudA, "account-a");
  assert.deepEqual(visible(db), {
    words: ["oldWord"],
    snippets: ["oldtrig"],
    chats: ["old chat"],
    dictations: ["old dictation"],
  });
});

test("the upgrade claim runs once, and again after a failure", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const rows = seedUpgradedDevice(db, cloudA, daysAgo(5));
  const accountA = await signInAs(t, db, cloudA, "account-a");
  const snapshots = () =>
    cloudA
      .logFor("/api/transcriptions/list")
      .filter((call) => !new URLSearchParams(call.path.split("?")[1] ?? "").get("since")).length;

  cloudA.failNext("GET /api/transcriptions/list", { status: 503, error: "offline" });
  await accountA.syncAll(true);
  assert.equal(owners(db, rows)[3], null, "the dictation's claim failed with the request");

  await accountA.syncAll(true);
  assert.equal(owners(db, rows)[3], "account-a");
  const afterRetry = snapshots();

  await accountA.syncAll(true);
  assert.equal(snapshots(), afterRetry, "a finished claim isn't repeated");
});

test("a device with nothing to claim downloads nothing extra", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  for (const key of ["conversations", "transcriptions", "dictionary", "snippets"]) {
    localStorageStub.setItem(`lastSyncedAt.${key}`, new Date().toISOString());
  }
  localStorageStub.setItem("dictionarySharedAtBackfill", "true");
  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  assert.equal(
    cloudA
      .logFor("/api/conversations/list")
      .filter((call) => !new URLSearchParams(call.path.split("?")[1] ?? "").get("since")).length,
    0
  );
});

test("on a shared device, a legacy row's own upload proves nothing about who owns it", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId(null);
  db.applyDictionaryChanges({ add: ["Legacy"] });
  db.setSnippets([{ trigger: "leg", replacement: "x" }]);
  const chat = db.createAgentConversation("legacy chat");
  db.addAgentMessage(chat.id, "user", "hello");
  db.saveTranscription("legacy dictation", null, { clientTranscriptionId: "legacy-dictation" });
  for (const table of ["custom_dictionary", "snippets", "agent_conversations", "transcriptions"]) {
    db.db.prepare(`UPDATE ${table} SET legacy_unattributed = 1`).run();
  }
  db.setActiveAccountId("account-c");
  db.saveTranscription("C used this device too", null, { clientTranscriptionId: "c-own" });

  const cloudA = createAccountCloud();
  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  await accountA.syncAll(true);
  assert.equal(cloudA.dictionary().length, 1, "the row still reaches the account syncing it");
  assert.equal(cloudA.conversations().length, 1);
  assert.equal(cloudA.transcriptions().length, 1);

  for (const table of ["custom_dictionary", "snippets", "agent_conversations", "transcriptions"]) {
    assert.equal(
      db.db.prepare(`SELECT account_id FROM ${table} WHERE account_id IS NOT 'account-c'`).get()
        .account_id,
      null,
      `${table} stays unattributed`
    );
  }
  await signInAs(t, db, createAccountCloud(), "account-b");
  assert.deepEqual(visible(db), {
    words: ["Legacy"],
    snippets: ["leg"],
    chats: ["legacy chat"],
    dictations: ["legacy dictation"],
  });
});

test("a chat or dictation delete the cloud already applied doesn't retry forever", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const seeded = seedHistory(cloudA, "a", daysAgo(5));
  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);

  const chat = db.getConversationByClientId("a-chat");
  const dictation = db.getTranscriptionByClientId("a-dictation");
  db.deleteAgentConversation(chat.id);
  db.deleteTranscription(dictation.id);
  // The first delete landed, but its ack was dropped by an account switch.
  cloudA.deleteConversation(seeded.chat.id);
  cloudA.deleteTranscription(seeded.dictation.id);
  // Skip the pull's tombstones, so only the retried delete can clear the rows.
  localStorageStub.setItem(
    "lastSyncedAt.conversations",
    new Date(Date.now() + 60000).toISOString()
  );
  localStorageStub.setItem(
    "lastSyncedAt.transcriptions",
    new Date(Date.now() + 60000).toISOString()
  );

  await accountA.syncAll(true);
  assert.equal(
    db.db.prepare("SELECT 1 FROM agent_conversations WHERE id = ?").get(chat.id),
    undefined
  );
  assert.equal(
    db.db.prepare("SELECT 1 FROM transcriptions WHERE id = ?").get(dictation.id),
    undefined
  );
  assert.deepEqual(db.getPendingConversationDeletes(), []);
  assert.deepEqual(db.getPendingTranscriptionDeletes(), []);
});

test("clearing history queues a legacy row's delete for the clearing account alone", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId(null);
  db.saveTranscription("whose is this", null, { clientTranscriptionId: "legacy" });
  db.db
    .prepare(
      "UPDATE transcriptions SET legacy_unattributed = 1, cloud_id = 'someone-elses', sync_status = 'synced'"
    )
    .run();

  // Only one account has used this device: the row can only be theirs.
  db.setActiveAccountId("account-a");
  const single = db.db.prepare("SELECT id FROM transcriptions").get().id;
  db.db.prepare("BEGIN").run();
  db.clearTranscriptions();
  assert.deepEqual(
    db.getPendingTranscriptionDeletes().map((row) => row.cloud_id),
    ["someone-elses"]
  );
  db.db.prepare("ROLLBACK").run();
  assert.ok(db.db.prepare("SELECT 1 FROM transcriptions WHERE id = ?").get(single));

  // Another account has: A's token can only delete A's own copy, so B's next
  // pass must never pick up this tombstone and delete B's.
  db.setActiveAccountId("account-b");
  db.saveTranscription("B's own");
  db.setActiveAccountId("account-a");
  db.clearTranscriptions();
  assert.deepEqual(
    db.getPendingTranscriptionDeletes().map((row) => row.cloud_id),
    ["someone-elses"]
  );
  db.setActiveAccountId("account-b");
  assert.deepEqual(db.getPendingTranscriptionDeletes(), []);
  assert.deepEqual(
    db.getTranscriptions().map((row) => row.text),
    ["B's own"]
  );
});

test("retention follows the active account and leaves another account's rows alone", (t) => {
  const db = setup(t);
  if (!db) return;
  const old = "2020-01-01 00:00:00";
  const insert = db.db.prepare(
    "INSERT INTO transcriptions (text, cloud_id, sync_status, created_at, account_id, legacy_unattributed) VALUES (?, ?, 'synced', ?, ?, ?)"
  );
  const a = insert.run("A's old", "cloud-a", old, "account-a", 0).lastInsertRowid;
  const b = insert.run("B's old", "cloud-b", old, "account-b", 0).lastInsertRowid;
  const legacy = insert.run("legacy old", "cloud-legacy", old, null, 1).lastInsertRowid;

  db.setActiveAccountId("account-b");
  const { ids } = db.deleteTranscriptionsExpiredBefore(30);
  assert.deepEqual(ids.map(Number).sort(), [Number(b), Number(legacy)].sort());
  assert.ok(
    db.db.prepare("SELECT 1 FROM transcriptions WHERE id = ? AND deleted_at IS NULL").get(a)
  );
  assert.deepEqual(
    db.getPendingTranscriptionDeletes().map((row) => row.cloud_id),
    ["cloud-b", "cloud-legacy"],
    "B's token can only delete a copy in B's own cloud"
  );
  db.setActiveAccountId("account-a");
  assert.deepEqual(db.getPendingTranscriptionDeletes(), [], "A's next pass can't push them");
});

test("deleting an account takes legacy rows only when no other account has used the device", (t) => {
  const db = setup(t);
  if (!db) return;
  const seedLegacy = () => {
    db.setActiveAccountId(null);
    db.applyDictionaryChanges({ add: ["Legacy"] });
    db.setSnippets([{ trigger: "leg", replacement: "x" }]);
    const chat = db.createAgentConversation("legacy chat");
    db.addAgentMessage(chat.id, "user", "hello");
    const { id } = db.saveTranscription("legacy dictation");
    for (const table of [
      "custom_dictionary",
      "snippets",
      "agent_conversations",
      "transcriptions",
    ]) {
      db.db.prepare(`UPDATE ${table} SET legacy_unattributed = 1 WHERE account_id IS NULL`).run();
    }
    return { chat, id };
  };
  const counts = () =>
    [
      "custom_dictionary",
      "snippets",
      "agent_conversations",
      "agent_messages",
      "transcriptions",
    ].map((table) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

  const first = seedLegacy();
  db.setActiveAccountId("account-a");
  db.saveTranscription("B's own", null, { clientTranscriptionId: "own" });
  db.db
    .prepare(
      "UPDATE transcriptions SET account_id = 'account-b' WHERE client_transcription_id = 'own'"
    )
    .run();
  const kept = db.deleteAccountData("account-a");
  assert.deepEqual(kept.deletedTranscriptionIds, [], "another account may own them");
  assert.deepEqual(counts(), [1, 1, 1, 1, 2]);

  db.db.prepare("DELETE FROM transcriptions WHERE account_id = 'account-b'").run();
  db.setActiveAccountId("account-a");
  const taken = db.deleteAccountData("account-a");
  assert.deepEqual(taken.deletedTranscriptionIds, [first.id]);
  assert.deepEqual(counts(), [0, 0, 0, 0, 0]);
});

test("the check for an account's own copy of a word uses the per-account key index", (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  for (const [table, key] of [
    ["custom_dictionary", "word"],
    ["snippets", "trigger"],
  ]) {
    const plan = db.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM ${table} owned WHERE owned.account_id = ? AND lower(owned.${key}) = lower(?)`
      )
      .all("account-a", "x")
      .map((row) => row.detail)
      .join(" ");
    assert.match(plan, new RegExp(`idx_${table}_account_lower_${key}`));
  }
});

test("a request pinned to a replaced sign-in leaves the current one validated", async (t) => {
  const db = setup(t);
  if (!db) return;
  await signInAs(t, db, createAccountCloud(), "account-b");
  const current = getValidatedAuthGeneration();
  assert.notEqual(current, null);

  await assert.rejects(
    cloudPostForAuthGeneration("/api/dictionary/batch-create", { entries: [] }, current + 7),
    { code: "AUTH_CONTEXT_CHANGED" }
  );
  assert.equal(getValidatedAuthGeneration(), current);
});

test("deleting an account leaves no journal row for its chats behind", (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const chat = db.createAgentConversation("in a folder being deleted");
  db.db
    .prepare(
      "INSERT INTO optimistic_folder_delete_rows (folder_id, entity_type, entity_id) VALUES (999, 'conversation', ?)"
    )
    .run(chat.id);
  db.deleteAccountData("account-a");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM optimistic_folder_delete_rows").get().n, 0);
});

test("a removed word stays removed beside a legacy copy another cloud may hold", async (t) => {
  const db = setup(t);
  if (!db) return;
  const at = daysAgo(5);
  db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, updated_at, legacy_unattributed) VALUES ('Shared', 'other-dict', 'other-cloud', 'synced', ?, 1)"
    )
    .run(at);
  db.db
    .prepare(
      "INSERT INTO snippets (trigger, replacement, client_snippet_id, cloud_id, sync_status, updated_at, legacy_unattributed) VALUES ('sig', 'x', 'other-snip', 'other-snip-cloud', 'synced', ?, 1)"
    )
    .run(at);
  const cloudA = createAccountCloud();
  cloudA.seedDictionaryEntry({ word: "Shared", client_dict_id: "a-dict" });
  cloudA.seedSnippet({ trigger: "sig", replacement: "mine", client_snippet_id: "a-snip" });
  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);

  db.applyDictionaryChanges({ remove: ["Shared"] });
  db.setSnippets([]);
  await accountA.syncAll(true);
  await accountA.syncAll(true);
  assert.deepEqual(db.getDictionary(), [], "the legacy copy doesn't surface");
  assert.deepEqual(db.getSnippets(), []);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS n FROM custom_dictionary WHERE cloud_id = 'other-cloud'")
      .get().n,
    1,
    "and whoever owns it keeps it"
  );

  db.applyDictionaryChanges({ add: ["Shared"] });
  assert.deepEqual(db.getDictionary(), ["Shared"], "the word can come back");
});

test("a word re-added while signed out survives the ack of the delete before it", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  cloudA.seedDictionaryEntry({ word: "Again", client_dict_id: "a-dict" });
  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  db.applyDictionaryChanges({ remove: ["Again"] });

  db.setActiveAccountId(null);
  db.applyDictionaryChanges({ add: ["Again"] });

  const back = await signInAs(t, db, cloudA, "account-a");
  await back.syncAll(true);
  assert.deepEqual(db.getDictionary(), ["Again"]);
  await back.syncAll(true);
  assert.ok(
    cloudA.dictionary().some((row) => row.word === "Again" && !row.deleted_at),
    "and reaches the cloud"
  );
});

test("an upgrade that dies between its two steps runs whole next launch", (t) => {
  const db = setup(t);
  if (!db) return;
  db.saveTranscription("from before the upgrade");
  db.db.exec("ALTER TABLE transcriptions DROP COLUMN legacy_unattributed");
  const exec = db.db.exec.bind(db.db);
  db.db.exec = (sql) => {
    if (/^UPDATE transcriptions SET legacy_unattributed/.test(sql)) throw new Error("crashed");
    return exec(sql);
  };
  assert.throws(() => db._initPersonalRowAccounts(), /crashed/);
  db.db.exec = exec;
  db._initPersonalRowAccounts();
  assert.equal(
    db.db.prepare("SELECT legacy_unattributed FROM transcriptions").get().legacy_unattributed,
    1
  );
});

test("a team note's delete retires every member's chats about it, each from its own cloud", (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId("account-a");
  const note = db.saveNote("Team note", "body").note;
  const chat = db.createAgentConversation("about the note", note.id);
  db.db
    .prepare(
      "UPDATE agent_conversations SET cloud_id = 'cloud-a', sync_status = 'synced' WHERE id = ?"
    )
    .run(chat.id);
  db.db.prepare("UPDATE notes SET account_id = NULL WHERE id = ?").run(note.id);

  db.setActiveAccountId("account-b");
  db._retireConversationsWhere("note_id = ?", [note.id]);
  assert.deepEqual(db.getPendingConversationDeletes(), [], "B never sends A's delete");
  db.setActiveAccountId("account-a");
  assert.deepEqual(
    db.getPendingConversationDeletes().map((row) => row.cloud_id),
    ["cloud-a"]
  );
});

test("a chat's copy orphaned by an account switch is deleted when its sender returns", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId(null);
  const chat = db.createAgentConversation("guest chat");
  db.addAgentMessage(chat.id, "user", "hello");
  const cloudA = createAccountCloud();
  const accountA = await signInAs(t, db, cloudA, "account-a");
  const api = windowStub.electronAPI;
  const request = api.cloudApiRequest;
  api.cloudApiRequest = async (options) => {
    const result = await request(options);
    if (options.path === "/api/conversations/create") {
      // B signs in and takes the row while the create is in flight.
      db.db.prepare("UPDATE agent_conversations SET account_id = 'account-b'").run();
      db.setActiveAccountId("account-b");
      api.authState.generation += 1;
    }
    return result;
  };
  await accountA.syncAll(true);
  assert.equal(cloudA.conversations().filter((row) => !row.deleted_at).length, 1);

  await (await signInAs(t, db, cloudA, "account-a")).syncAll(true);
  assert.equal(cloudA.conversations().filter((row) => !row.deleted_at).length, 0);
  assert.equal(db.getAgentConversation(chat.id), null, "the row stays with B");
});

test("an orphaned chat copy whose delete fails is queued and deleted", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const accountA = await signInAs(t, db, cloudA, "account-a");
  const chat = db.createAgentConversation("deleted mid-flight");
  db.addAgentMessage(chat.id, "user", "hello");
  const api = windowStub.electronAPI;
  const request = api.cloudApiRequest;
  api.cloudApiRequest = async (options) => {
    const result = await request(options);
    if (options.path === "/api/conversations/create") {
      // The chat leaves the device while its create is in flight, and the
      // connection drops before the copy's delete gets through.
      db.db.prepare("DELETE FROM agent_messages").run();
      db.db.prepare("DELETE FROM agent_conversations").run();
      cloudA.failNext("DELETE /api/conversations/delete", { status: 0, error: "offline" });
    }
    return result;
  };

  await accountA.syncAll(true);
  // No local row is left to retry the delete, so the pass's delete stage
  // takes it from the queue.
  assert.equal(cloudA.logFor("/api/conversations/delete").length, 2);
  assert.equal(cloudA.conversations().filter((row) => !row.deleted_at).length, 0);
});

test("a chat create ack main refuses is logged, and its retry sends no message twice", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const accountA = await signInAs(t, db, cloudA, "account-a");
  const chat = db.createAgentConversation("refused ack");
  db.addAgentMessage(chat.id, "user", "hello");
  db.addAgentMessage(chat.id, "assistant", "hello back");
  const api = windowStub.electronAPI;
  const acknowledge = api.acknowledgeConversationCreate;
  api.acknowledgeConversationCreate = async () => {
    api.acknowledgeConversationCreate = acknowledge;
    return { success: false, outcome: "unresolved", cloud_id: null };
  };
  const warn = t.mock.method(console, "warn", () => {});

  await accountA.syncAll(true);
  assert.equal(db.getAgentConversation(chat.id).cloud_id, null, "the chat stays unlinked");
  assert.equal(
    warn.mock.calls.filter((call) => /create ack was refused/.test(call.arguments[0])).length,
    1
  );

  await accountA.syncAll(true);
  const [copy] = cloudA.conversations();
  assert.equal(db.getAgentConversation(chat.id).cloud_id, copy.id);
  assert.equal(copy.messages.length, 2);
});

test("forgetting an account leaves no cursor or claim keyed by it", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  seedUpgradedDevice(db, cloudA, daysAgo(5));
  const accountA = await signInAs(t, db, cloudA, "account-a");
  // Its upgrade claim is still owed when the account is deleted.
  cloudA.failWith("GET /api/transcriptions/list", { status: 503, error: "offline" });
  await accountA.syncAll(true);
  assert.equal(localStorageStub.getItem("lastSyncedAt.accountId"), "account-a");
  assert.equal(localStorageStub.getItem("syncCursors.unownedClaimedBy"), "account-a");

  db.deleteAccountData("account-a");
  accountA.forgetAccount("account-a");
  const namesAccountA = () =>
    Array.from({ length: localStorageStub.length }, (_, index) => localStorageStub.key(index))
      .filter((key) => `${key}=${localStorageStub.getItem(key)}`.includes("account-a"))
      .sort();
  assert.deepEqual(namesAccountA(), []);
  assert.equal(localStorageStub.getItem("syncCursors.unownedClaimProgress"), null);

  const accountB = await signInAs(t, db, createAccountCloud(), "account-b");
  await accountB.syncAll(true);
  assert.deepEqual(namesAccountA(), [], "the next account's claim files nothing under it");
});

test("a dictionary rename onto a word the account owns merges instead of wedging the pull", (t) => {
  const db = setup(t);
  if (!db) return;
  const at = daysAgo(5);
  db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, updated_at, legacy_unattributed) VALUES ('foo', 'x-dict', 'x-cloud', 'synced', ?, 1)"
    )
    .run(at);
  db.setActiveAccountId("account-a");
  db.applyDictionaryChanges({ add: ["bar"] });

  const merged = db.upsertDictionaryFromCloud({
    id: "x-cloud",
    client_dict_id: "x-dict",
    word: "bar",
    source: "manual",
    created_at: at,
    updated_at: new Date().toISOString(),
  });
  assert.equal(merged.word, "bar");
  assert.equal(merged.account_id, "account-a");
  assert.deepEqual(db.getDictionary(), ["bar"]);
});

test("a chat create refused before it was sent isn't recorded as attempted", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const accountA = await signInAs(t, db, cloudA, "account-a");
  const chat = db.createAgentConversation("about to switch");
  db.addAgentMessage(chat.id, "user", "hello");
  const api = windowStub.electronAPI;
  const mark = api.markConversationCreateAttempted;
  api.markConversationCreateAttempted = async (...args) => {
    const result = await mark(...args);
    api.authState.generation += 1;
    return result;
  };
  await accountA.syncAll(true);
  assert.equal(cloudA.conversations().length, 0);
  const attempted = () =>
    db.db.prepare("SELECT cloud_create_attempted AS a FROM agent_conversations").get().a;
  assert.equal(attempted(), 0, "it never left, so it can still just be deleted");

  assert.equal((await mark(chat.id, api.authState.generation - 1))?.stale, true);
  assert.equal(attempted(), 0);
});

test("a one-account user's legacy word whose cloud row is gone is re-created", async (t) => {
  const db = setup(t);
  if (!db) return;
  db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, legacy_unattributed) VALUES ('Mine', 'mine-dict', 'gone', 'pending', 1)"
    )
    .run();
  const cloudA = createAccountCloud();
  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  await accountA.syncAll(true);
  assert.ok(cloudA.dictionary().some((row) => row.word === "Mine"));
});

test("signing in takes the signed-out rows that never sync, and only those", (t) => {
  const db = setup(t);
  if (!db) return;
  db.setActiveAccountId(null);
  const space = db.getSpaces().find((row) => row.kind === "private");
  const containerChat = db.createAgentConversation("container chat", null, space.id);
  const globalChat = db.createAgentConversation("global chat");
  const failed = db.saveTranscription("", null, { clientTranscriptionId: "failed" });
  db.updateTranscriptionStatus(failed.id, "failed", "boom");
  const done = db.saveTranscription("dictated", null, { clientTranscriptionId: "done" });
  const legacyFailed = db.saveTranscription("", null, { clientTranscriptionId: "old-failed" });
  db.db
    .prepare("UPDATE transcriptions SET status = 'failed', legacy_unattributed = 1 WHERE id = ?")
    .run(legacyFailed.id);

  db.setActiveAccountId("account-a");
  db.claimSignedOutLocalRows();
  const chatOwner = (id) =>
    db.db.prepare("SELECT account_id FROM agent_conversations WHERE id = ?").get(id).account_id;
  const dictationOwner = (id) =>
    db.db.prepare("SELECT account_id FROM transcriptions WHERE id = ?").get(id).account_id;
  assert.equal(chatOwner(containerChat.id), "account-a");
  assert.equal(dictationOwner(failed.id), "account-a");
  assert.equal(chatOwner(globalChat.id), null, "a push claims this one");
  assert.equal(dictationOwner(done.id), null);
  assert.equal(dictationOwner(legacyFailed.id), null, "and nobody knows whose this is");
});

test("Insights counts the active account's dictations, and signed out only unattributed ones", (t) => {
  const db = setup(t);
  if (!db) return;
  const insert = db.db.prepare(
    `INSERT INTO analytics_events (event_id, account_id, occurred_at, local_date, word_count, mode, sync_status)
     VALUES (?, ?, '2026-09-01T10:00:00.000Z', '2026-09-01', 3, 'dictation', 'pending')`
  );
  insert.run("a", "account-a");
  insert.run("b", "account-b");
  insert.run("guest", null);

  db.setActiveAccountId("account-b");
  assert.equal(db.getAnalyticsSummary().totalDictations, 2, "B's own and the guest counter");
  db.setActiveAccountId(null);
  assert.equal(db.getAnalyticsSummary().totalDictations, 1, "neither account's total shows");
  db.setActiveAccountId("account-a");
  assert.equal(db.getAnalyticsSummary().totalDictations, 2);
  db.clearTranscriptions();
  assert.equal(db.getAnalyticsSummary().totalDictations, 0, "A's clear reads as cleared");
  db.setActiveAccountId("account-b");
  assert.equal(db.getAnalyticsSummary().totalDictations, 1, "B's own survives A's clear");
});

const LEGACY_TABLES = ["custom_dictionary", "snippets", "agent_conversations", "transcriptions"];

function seedLegacyRows(db) {
  db.setActiveAccountId(null);
  db.applyDictionaryChanges({ add: ["Legacy"] });
  db.setSnippets([{ trigger: "leg", replacement: "x" }]);
  const chat = db.createAgentConversation("legacy chat");
  db.addAgentMessage(chat.id, "user", "hello");
  db.saveTranscription("legacy dictation", null, { clientTranscriptionId: "legacy-dictation" });
  for (const table of LEGACY_TABLES) {
    db.db.prepare(`UPDATE ${table} SET legacy_unattributed = 1`).run();
  }
}

const rowOwner = (db, table) => db.db.prepare(`SELECT account_id FROM ${table}`).get().account_id;

test("the only account on a device owns its pending legacy rows, so the next one never sees them", async (t) => {
  const db = setup(t);
  if (!db) return;
  seedLegacyRows(db);

  const cloudA = createAccountCloud();
  db.setActiveAccountId("account-a");
  db.claimLegacyRowsOfOnlyAccount();
  for (const table of LEGACY_TABLES) assert.equal(rowOwner(db, table), "account-a", table);

  const accountA = await signInAs(t, db, cloudA, "account-a");
  await accountA.syncAll(true);
  assert.equal(cloudA.dictionary().length, 1, "still uploaded exactly once");
  assert.equal(cloudA.conversations().length, 1);
  assert.equal(cloudA.transcriptions().length, 1);

  db.setActiveAccountId("account-b");
  assert.deepEqual(db.getDictionary(), []);
  assert.deepEqual(db.getSnippets(), []);
  assert.deepEqual(db.getAgentConversations(), []);
  assert.deepEqual(db.getTranscriptions(), []);
  db.setActiveAccountId(null);
  assert.deepEqual(db.getTranscriptions(), [], "nor does a signed-out guest");
});

test("legacy rows stay unattributed when another account has used the device", (t) => {
  const db = setup(t);
  if (!db) return;
  seedLegacyRows(db);
  db.setActiveAccountId("account-b");
  db.saveTranscription("B's own dictation", null, { clientTranscriptionId: "b-own" });

  db.setActiveAccountId("account-a");
  db.claimLegacyRowsOfOnlyAccount();

  for (const table of ["custom_dictionary", "snippets", "agent_conversations"]) {
    assert.equal(rowOwner(db, table), null, table);
  }
  assert.equal(
    db.db
      .prepare(
        "SELECT account_id FROM transcriptions WHERE client_transcription_id = 'legacy-dictation'"
      )
      .get().account_id,
    null
  );
});

test("the only account's claim leaves a legacy twin of its own word hidden", (t) => {
  const db = setup(t);
  if (!db) return;
  seedLegacyRows(db);
  db.setActiveAccountId("account-a");
  db.db
    .prepare("INSERT INTO custom_dictionary (word, client_dict_id, account_id) VALUES (?, ?, ?)")
    .run("Legacy", "a-own", "account-a");

  db.claimLegacyRowsOfOnlyAccount();

  assert.deepEqual(db.getDictionary(), ["Legacy"], "listed once, and no UNIQUE failure");
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM custom_dictionary WHERE account_id IS NULL").get().n,
    1
  );
});

test("signing out and back in with the only account doesn't reopen its legacy rows", (t) => {
  const db = setup(t);
  if (!db) return;
  seedLegacyRows(db);
  db.setActiveAccountId("account-a");
  db.claimLegacyRowsOfOnlyAccount();
  db.setActiveAccountId(null);
  db.saveTranscription("signed-out dictation", null, { clientTranscriptionId: "guest" });

  db.setActiveAccountId("account-a");
  db.claimLegacyRowsOfOnlyAccount();

  assert.equal(
    db.db
      .prepare("SELECT account_id FROM transcriptions WHERE client_transcription_id = 'guest'")
      .get().account_id,
    null,
    "only rows from before attribution are claimed this way; a guest row joins when it syncs"
  );
});

test("the only account's claim leaves a synced legacy row for its own cloud to prove", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudB = createAccountCloud();
  const inB = cloudB.seedTranscription({
    client_transcription_id: "b-dictation",
    text: "B's dictation",
    created_at: daysAgo(5),
    updated_at: daysAgo(5),
  });
  db.setActiveAccountId(null);
  db.saveTranscription("B's dictation", null, { clientTranscriptionId: "b-dictation" });
  db.db
    .prepare(
      "UPDATE transcriptions SET cloud_id = ?, sync_status = 'synced', legacy_unattributed = 1"
    )
    .run(inB.id);

  db.setActiveAccountId("account-a");
  db.claimLegacyRowsOfOnlyAccount();
  assert.equal(rowOwner(db, "transcriptions"), null, "a cloud id isn't A's to take on no evidence");

  const accountB = await signInAs(t, db, cloudB, "account-b");
  await accountB.syncAll(true);
  assert.equal(rowOwner(db, "transcriptions"), "account-b", "B's own cloud proves it");
  assert.deepEqual(
    db.getTranscriptions().map((row) => row.text),
    ["B's dictation"]
  );
});

test("another account's first pull leaves this account's note feed replay to run", async (t) => {
  const db = setup(t);
  if (!db) return;
  const cloudA = createAccountCloud();
  const replays = () =>
    cloudA
      .logFor("/api/notes/list")
      .filter((call) => call.path.includes(encodeURIComponent("1970-01-01T00:00:00.000Z"))).length;

  // A upgraded with cursors already in place, and its one replay of the feed
  // has failed once so far.
  await (await signInAs(t, db, cloudA, "account-a")).syncAll(true);
  localStorageStub.setItem("noteFeedReplay.v1", "1");
  const before = replays();

  // B's cursor-less first pull covers B's whole feed, which counts as B's replay.
  await (await signInAs(t, db, createAccountCloud(), "account-b")).syncAll(true);
  assert.equal(localStorageStub.getItem("noteFeedReplay.v1"), "3");

  await (await signInAs(t, db, cloudA, "account-a")).syncAll(true);
  assert.equal(replays(), before + 1, "A's feed is still replayed once A is back");
  assert.equal(localStorageStub.getItem("noteFeedReplay.v1"), "3");
});
