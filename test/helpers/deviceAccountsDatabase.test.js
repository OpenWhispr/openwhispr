// Whose personal rows are in view signed out. On a device only one account has
// ever signed in on, that account's history, dictionary, snippets and chats stay
// visible and editable; once a second account has signed in, signed out shows
// only unattributed rows. Writes, claims and sync stay with the signed-in account.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");

const A = "account-a";
const B = "account-b";

// A's rows in all four tables: one synced and one never-synced of each.
function seedAccountA(db) {
  db.setActiveAccountId(A);
  const synced = db.saveTranscription("A's synced dictation");
  db.markTranscriptionSynced(synced.id, "cloud-t");
  const local = db.saveTranscription("A's local dictation");
  db.applyDictionaryChanges({ add: ["Kubernetes", "Terraform"] });
  const word = db.getPendingDictionary().find((row) => row.word === "Kubernetes");
  db.markDictionaryEntrySynced(word.id, "cloud-w", null, "Kubernetes");
  db.setSnippets([
    { trigger: "addr", replacement: "A's address" },
    { trigger: "sig", replacement: "Best, A" },
  ]);
  const snippet = db.getPendingSnippets().find((row) => row.trigger === "addr");
  db.markSnippetSynced(snippet.id, "cloud-s", null, "addr", "A's address");
  const chat = db.createAgentConversation("A's chat");
  db.addAgentMessage(chat.id, "user", "A's question");
  db.markConversationSynced(chat.id, "cloud-c");
  return { synced: synced.id, local: local.id, chat: chat.id, word: word.id, snippet: snippet.id };
}

const view = (db) => ({
  history: db
    .getTranscriptions(50)
    .map((row) => row.text)
    .sort(),
  dictionary: db.getDictionary(),
  snippets: db.getSnippets().map((row) => row.trigger),
  chats: db
    .getAgentConversations(50)
    .map((row) => row.title)
    .sort(),
});
const accountsOwnedView = {
  history: ["A's local dictation", "A's synced dictation"],
  dictionary: ["Kubernetes", "Terraform"],
  snippets: ["addr", "sig"],
  chats: ["A's chat"],
};
const emptyView = { history: [], dictionary: [], snippets: [], chats: [] };
const row = (db, table, where) => ({
  ...db.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(),
});

test("signed out on a device one account has used, its rows stay visible in all four tables", (t) => {
  const db = createDb(t);
  if (!db) return;
  const ids = seedAccountA(db);
  db.setActiveAccountId(null);

  assert.deepEqual(view(db), accountsOwnedView);
  assert.equal(db.getTranscriptionById(ids.local).text, "A's local dictation");
  assert.deepEqual(
    db.getAgentConversation(ids.chat).messages.map((message) => message.content),
    ["A's question"]
  );
  assert.deepEqual(
    db.getAgentMessages(ids.chat).map((message) => message.content),
    ["A's question"]
  );
  assert.deepEqual(db.getOtherAccountTranscriptionIds(), [], "its recordings are its own");
});

test("signed out, an edit or delete keeps the row the account's and pending for its next sign-in", (t) => {
  const db = createDb(t);
  if (!db) return;
  const ids = seedAccountA(db);
  db.setActiveAccountId(null);

  // The word and trigger the account already has are edited, not twinned.
  db.applyDictionaryChanges({ add: ["KUBERNETES"] });
  db.setSnippets([
    { trigger: "ADDR", replacement: "A's new address" },
    { trigger: "sig", replacement: "Best, A" },
  ]);
  assert.deepEqual(db.getDictionary(), ["KUBERNETES", "Terraform"]);
  assert.deepEqual(db.getSnippets(), [
    { trigger: "ADDR", replacement: "A's new address" },
    { trigger: "sig", replacement: "Best, A" },
  ]);
  const count = (table) => db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  assert.deepEqual([count("custom_dictionary"), count("snippets")], [2, 2], "no twin rows");
  const word = row(db, "custom_dictionary", `id = ${ids.word}`);
  assert.deepEqual(
    [word.word, word.account_id, word.sync_status, word.cloud_id],
    ["KUBERNETES", A, "pending", "cloud-w"]
  );
  const snippet = row(db, "snippets", `id = ${ids.snippet}`);
  assert.deepEqual(
    [snippet.replacement, snippet.account_id, snippet.sync_status],
    ["A's new address", A, "pending"]
  );

  assert.equal(db.updateAgentConversationTitle(ids.chat, "A's renamed chat").success, true);
  assert.ok(db.addAgentMessage(ids.chat, "user", "asked signed out"));
  assert.equal(row(db, "agent_conversations", `id = ${ids.chat}`).account_id, A);

  // Deleting a synced row leaves the owner's tombstone; a local one just goes.
  db.applyDictionaryChanges({ remove: ["kubernetes"] });
  db.setSnippets([{ trigger: "sig", replacement: "Best, A" }]);
  assert.equal(db.deleteTranscription(ids.synced).success, true);
  assert.equal(db.deleteTranscription(ids.local).success, true);
  assert.equal(db.deleteAgentConversation(ids.chat).success, true);
  for (const [table, id] of [
    ["custom_dictionary", ids.word],
    ["snippets", ids.snippet],
    ["transcriptions", ids.synced],
    ["agent_conversations", ids.chat],
  ]) {
    const tombstone = row(db, table, `id = ${id}`);
    assert.ok(tombstone.deleted_at, `${table} tombstone`);
    assert.deepEqual([tombstone.account_id, tombstone.sync_status], [A, "pending"], table);
  }
  assert.equal(db.getTranscriptionById(ids.local), null);
  assert.deepEqual(view(db), {
    history: [],
    dictionary: ["Terraform"],
    snippets: ["sig"],
    chats: [],
  });

  // Nothing syncs signed out; the account's own sign-in pushes the deletes.
  assert.deepEqual(
    [
      db.getPendingDictionaryDeletes(),
      db.getPendingSnippetDeletes(),
      db.getPendingTranscriptionDeletes(),
      db.getPendingConversationDeletes(),
    ].map((queue) => queue.length),
    [0, 0, 0, 0]
  );
  db.setActiveAccountId(A);
  assert.deepEqual(
    [
      db.getPendingDictionaryDeletes(),
      db.getPendingSnippetDeletes(),
      db.getPendingTranscriptionDeletes(),
      db.getPendingConversationDeletes(),
    ].map((queue) => queue.length),
    [1, 1, 1, 1]
  );
});

test("rows added signed out are unattributed, and join the account when it syncs them", (t) => {
  const db = createDb(t);
  if (!db) return;
  seedAccountA(db);
  db.setActiveAccountId(null);

  const dictation = db.saveTranscription("spoken signed out");
  db.applyDictionaryChanges({ add: ["Ansible"] });
  db.setSnippets([...db.getSnippets(), { trigger: "eta", replacement: "On my way" }]);
  const chat = db.createAgentConversation("signed-out chat");
  db.recordAnalyticsEvent({
    eventId: "signed-out-event",
    wordCount: 3,
    occurredAt: new Date().toISOString(),
    localDate: "2026-11-10",
  });

  assert.equal(dictation.transcription.account_id, null);
  assert.equal(row(db, "custom_dictionary", "word = 'Ansible'").account_id, null);
  assert.equal(row(db, "snippets", "trigger = 'eta'").account_id, null);
  assert.equal(row(db, "agent_conversations", `id = ${chat.id}`).account_id, null);
  assert.equal(row(db, "analytics_events", "event_id = 'signed-out-event'").account_id, null);
  assert.deepEqual(view(db), {
    history: ["A's local dictation", "A's synced dictation", "spoken signed out"],
    dictionary: ["Kubernetes", "Terraform", "Ansible"],
    snippets: ["addr", "sig", "eta"],
    chats: ["A's chat", "signed-out chat"],
  });
  assert.equal(db.getAnalyticsSummary().totalWords, 3, "Insights shows unattributed counters only");

  db.setActiveAccountId(A);
  const pending = db.getPendingDictionary().find((entry) => entry.word === "Ansible");
  db.markDictionaryEntrySynced(pending.id, "cloud-ansible", null, "Ansible");
  assert.equal(row(db, "custom_dictionary", "word = 'Ansible'").account_id, A);
});

test("a fork made signed out stays with its source chat's account", (t) => {
  const db = createDb(t);
  if (!db) return;
  const ids = seedAccountA(db);
  const [message] = db.getAgentMessages(ids.chat);
  db.setActiveAccountId(null);

  const fork = db.forkAgentConversation(ids.chat, message.id, null);

  assert.equal(row(db, "agent_conversations", `id = ${fork.id}`).account_id, A);
  db.setActiveAccountId(B);
  assert.equal(db.getAgentConversation(fork.id), null, "the next account can't read the copy");
});

test("signed out, Clear history and the recordings scope act on what is visible", (t) => {
  const db = createDb(t);
  if (!db) return;
  const ids = seedAccountA(db);
  db.updateTranscriptionAudio(ids.synced, { hasAudio: 1 });
  db.setActiveAccountId(null);

  assert.deepEqual(db.getTranscriptionIdsWithAudio(), [ids.synced]);
  const cleared = db.clearTranscriptions();

  assert.deepEqual(cleared.ids.sort(), [ids.synced, ids.local].sort());
  const tombstone = row(db, "transcriptions", `id = ${ids.synced}`);
  assert.ok(tombstone.deleted_at);
  assert.deepEqual([tombstone.account_id, tombstone.sync_status], [A, "pending"]);
  assert.equal(
    db.db.prepare("SELECT 1 FROM transcriptions WHERE id = ?").get(ids.local),
    undefined
  );
  assert.deepEqual(db.getTranscriptions(50), []);
});

test("a second account signing in makes the device shared, even if it writes nothing", (t) => {
  const db = createDb(t);
  if (!db) return;
  const ids = seedAccountA(db);
  db.setActiveAccountId(null);
  assert.deepEqual(view(db), accountsOwnedView);

  db.setActiveAccountId(B);
  assert.deepEqual(view(db), emptyView, "B never sees A's rows");
  db.setActiveAccountId(null);

  assert.deepEqual(view(db), emptyView, "signed out no longer shows A's rows");
  assert.equal(db.getTranscriptionById(ids.local), null);
  assert.equal(db.getAgentConversation(ids.chat), null);
  assert.equal(db.deleteTranscription(ids.local).success, false);
  assert.equal(db.updateAgentConversationTitle(ids.chat, "renamed").success, false);
  assert.deepEqual(db.getOtherAccountTranscriptionIds().sort(), [ids.synced, ids.local].sort());
  db.setActiveAccountId(A);
  assert.equal(db.hasOtherAccountRows(), true, "the record counts as another account's trace");
});

test("deleting the other account's data makes the device the first account's alone again", (t) => {
  const db = createDb(t);
  if (!db) return;
  seedAccountA(db);
  db.setActiveAccountId(B);
  db.applyDictionaryChanges({ add: ["Bword"] });
  db.setActiveAccountId(null);
  assert.deepEqual(view(db), emptyView);

  db.setActiveAccountId(B);
  db.deleteAccountData(B);
  db.setActiveAccountId(null);

  assert.deepEqual(view(db), accountsOwnedView);
  db.setActiveAccountId(A);
  assert.equal(db.hasOtherAccountRows(), false);
});

test("the accounts a database already holds rows for are recorded when it opens", (t) => {
  const db = createDb(t);
  if (!db) return;
  seedAccountA(db);
  db.db
    .prepare(
      "INSERT INTO transcriptions (text, client_transcription_id, account_id) VALUES (?, ?, ?)"
    )
    .run("B's dictation", "b-t", B);
  // As a database from before the record existed.
  db.db.exec("DROP TABLE device_accounts");
  db.db.close();

  const reopened = new DatabaseManager();
  t.after(() => reopened.db.close());
  const recorded = () =>
    reopened.db
      .prepare("SELECT account_id FROM device_accounts ORDER BY account_id")
      .all()
      .map((entry) => entry.account_id);
  assert.deepEqual(recorded(), [A, B]);
  assert.deepEqual(view(reopened), emptyView, "two accounts' rows: signed out shows neither");

  reopened.db.prepare("DELETE FROM transcriptions WHERE account_id = ?").run(B);
  reopened.db.exec("DELETE FROM device_accounts");
  reopened.db.close();
  const sole = new DatabaseManager();
  t.after(() => sole.db.close());
  assert.deepEqual(view(sole), accountsOwnedView, "one account's rows: its own stay in view");
});

test("a single delete of an unattributed row is the deleter's to push", (t) => {
  const db = createDb(t);
  if (!db) return;
  const insert = (table, columns, values) =>
    db.db
      .prepare(
        `INSERT INTO ${table} (${columns}, cloud_id, sync_status, legacy_unattributed)
         VALUES (${values}, 'cloud', 'synced', 1)`
      )
      .run().lastInsertRowid;
  const seedLegacy = (suffix) => ({
    dictation: insert(
      "transcriptions",
      "text, client_transcription_id",
      `'t${suffix}', 't${suffix}'`
    ),
    chat: insert(
      "agent_conversations",
      "title, client_conversation_id",
      `'c${suffix}', 'c${suffix}'`
    ),
    word: insert("custom_dictionary", "word, client_dict_id", `'word${suffix}', 'w${suffix}'`),
    snippet: insert(
      "snippets",
      "trigger, replacement, client_snippet_id",
      `'trg${suffix}', 'r', 's${suffix}'`
    ),
  });
  const owners = (ids) =>
    [
      ["transcriptions", ids.dictation],
      ["agent_conversations", ids.chat],
      ["custom_dictionary", ids.word],
      ["snippets", ids.snippet],
    ].map(([table, id]) => {
      const tombstone = row(db, table, `id = ${id}`);
      assert.ok(tombstone.deleted_at, `${table} tombstone`);
      return tombstone.account_id;
    });
  const deleteAll = (ids, suffix) => {
    db.deleteTranscription(ids.dictation);
    db.deleteAgentConversation(ids.chat);
    db.applyDictionaryChanges({ remove: [`word${suffix}`] });
    db.setSnippets(db.getSnippets().filter((snippet) => snippet.trigger !== `trg${suffix}`));
  };
  const queues = () =>
    [
      db.getPendingTranscriptionDeletes(),
      db.getPendingConversationDeletes(),
      db.getPendingDictionaryDeletes(),
      db.getPendingSnippetDeletes(),
    ].map((queue) => queue.length);
  db.setActiveAccountId(B);

  const signedOut = seedLegacy(1);
  db.setActiveAccountId(null);
  deleteAll(signedOut, 1);
  assert.deepEqual(owners(signedOut), [null, null, null, null], "signed out, nobody is stamped");

  const signedIn = seedLegacy(2);
  db.setActiveAccountId(A);
  deleteAll(signedIn, 2);
  assert.deepEqual(owners(signedIn), [A, A, A, A]);
  assert.deepEqual(queues(), [2, 2, 2, 2]);

  db.setActiveAccountId(B);
  assert.deepEqual(queues(), [1, 1, 1, 1], "B's token never pushes the deletes A made");
});

test("a push ack reaches only an unattributed row or the active account's own", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(A);
  const dictation = db.saveTranscription("A's dictation");
  db.applyDictionaryChanges({ add: ["Kubernetes"] });
  db.setSnippets([{ trigger: "addr", replacement: "A's address" }]);
  const word = row(db, "custom_dictionary", "word = 'Kubernetes'");
  const snippet = row(db, "snippets", "trigger = 'addr'");
  db.setActiveAccountId(B);

  assert.equal(db.markTranscriptionSynced(dictation.id, "b-cloud").success, false);
  assert.deepEqual(db.markDictionaryEntrySynced(word.id, "b-cloud"), {
    success: false,
    changes: 0,
  });
  assert.deepEqual(db.markSnippetSynced(snippet.id, "b-cloud"), { success: false, changes: 0 });
  for (const [table, id] of [
    ["transcriptions", dictation.id],
    ["custom_dictionary", word.id],
    ["snippets", snippet.id],
  ]) {
    const unchanged = row(db, table, `id = ${id}`);
    assert.deepEqual(
      [unchanged.account_id, unchanged.cloud_id, unchanged.sync_status],
      [A, null, "pending"],
      table
    );
  }

  db.setActiveAccountId(A);
  assert.equal(db.markTranscriptionSynced(dictation.id, "a-cloud").success, true);
  assert.equal(db.markDictionaryEntrySynced(word.id, "a-cloud").success, true);
  assert.equal(db.markSnippetSynced(snippet.id, "a-cloud").success, true);
});

test("a sole account's claim leaves an unsynced casing of a word its cloud may hold", (t) => {
  const db = createDb(t);
  if (!db) return;
  const insert = db.db.prepare(
    "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, legacy_unattributed) VALUES (?, ?, ?, ?, 1)"
  );
  insert.run("Alpha", "c-alpha", "cloud-alpha", "synced");
  insert.run("ALPHA", "c-alpha-2", null, "pending");
  insert.run("Bravo", "c-bravo", null, "pending");

  db.setActiveAccountId(A);
  db.claimLegacyRowsOfOnlyAccount();

  const owners = () =>
    Object.fromEntries(
      db.db
        .prepare("SELECT word, account_id FROM custom_dictionary")
        .all()
        .map((entry) => [entry.word, entry.account_id])
    );
  assert.deepEqual(owners(), { Alpha: null, ALPHA: null, Bravo: A });
  assert.deepEqual(db.getDictionary(), ["Alpha", "ALPHA", "Bravo"], "both casings stay in view");

  // The cloud proves the synced casing; the pair is settled on it.
  const pulled = db.upsertDictionaryFromCloud({
    id: "cloud-alpha",
    client_dict_id: "c-alpha",
    word: "Alpha",
    updated_at: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(pulled.account_id, A);
  assert.deepEqual(owners(), { Alpha: A, ALPHA: null, Bravo: A });
  assert.deepEqual(db.getDictionary(), ["Alpha", "Bravo"]);
});

test("only an account that left counts as a change since a recording started", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  await tick();
  const signedOut = new Date().toISOString();
  await tick();
  db.setActiveAccountId(A);
  assert.equal(db.accountChangedSince(signedOut), false, "a guest signed in: nobody left");
  await tick();
  const underA = new Date().toISOString();
  await tick();
  db.setActiveAccountId(null);
  assert.equal(db.accountChangedSince(underA), true, "A signed out");
  db.setActiveAccountId(B);
  assert.equal(db.accountChangedSince(underA), true, "A was replaced by B");
  db.setActiveAccountId(A);
  assert.equal(db.accountChangedSince(underA), false, "A is back");
  // Stamping is unchanged: the signed-out recording stays unattributed.
  assert.equal(
    db.saveTranscription("spoken signed out", null, { analyticsOccurredAt: signedOut })
      .transcription.account_id,
    null
  );
});

test("a failed dictation spoken signed out that lands after the sign-in joins the account", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  await tick();
  const signedOut = new Date().toISOString();
  await tick();
  // The sign-in's claim runs once, before the dictation lands. It never syncs, so nothing
  // else would give it an account, and the next account to sign in would see it.
  db.setActiveAccountId(A);
  db.claimSignedOutLocalRows();

  const failed = db.saveTranscription("", null, {
    status: "failed",
    analyticsOccurredAt: signedOut,
  }).transcription;
  assert.equal(failed.account_id, A);
  // A completed one still waits to join the account when it syncs.
  const completed = db.saveTranscription("spoken signed out", null, {
    analyticsOccurredAt: signedOut,
  }).transcription;
  assert.equal(completed.account_id, null);
});
