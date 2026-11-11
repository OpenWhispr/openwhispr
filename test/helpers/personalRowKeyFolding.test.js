// Dictionary words and snippet triggers are matched case-insensitively, by the
// same folding in SQL and in JS. SQLite's own lower() folds only ASCII, so a
// non-ASCII word ("École") once failed to hide or merge with its unattributed
// twin, and a delete aimed at the account's row could land on the twin.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");

const A = "account-a";

const rows = (db, table, key) =>
  db.db
    .prepare(
      `SELECT ${key} AS key, account_id, deleted_at IS NOT NULL AS deleted FROM ${table} ORDER BY id`
    )
    .all()
    .map((row) => ({ ...row }));

const ALPHABETS = [
  ["non-ASCII (é)", { guest: "école", own: "École", guestTrigger: "éta", ownTrigger: "ÉTA" }],
  ["German ẞ", { guest: "straße", own: "STRAẞE", guestTrigger: "grüße", ownTrigger: "GRÜẞE" }],
  ["ASCII", { guest: "kube", own: "Kube", guestTrigger: "eta", ownTrigger: "ETA" }],
];

for (const [label, words] of ALPHABETS) {
  test(`${label}: a word and trigger added signed out merge with the account's pulled casing`, (t) => {
    const db = createDb(t);
    if (!db) return;
    db.setActiveAccountId(null);
    db.applyDictionaryChanges({ add: [words.guest] });
    db.setSnippets([{ trigger: words.guestTrigger, replacement: "guest text" }]);
    db.setActiveAccountId(A);
    db.upsertDictionaryFromCloud({ id: "a-w1", client_dict_id: "a-c1", word: words.own });
    db.upsertSnippetFromCloud({
      id: "a-s1",
      client_snippet_id: "a-cs1",
      trigger: words.ownTrigger,
      replacement: "A's text",
    });

    const dictionary = rows(db, "custom_dictionary", "word");
    assert.equal(dictionary.length, 1, "one row for the word");
    assert.equal(dictionary[0].account_id, A);
    assert.deepEqual(db.getSnippets(), [{ trigger: words.ownTrigger, replacement: "A's text" }]);
    assert.equal(rows(db, "snippets", "trigger").length, 1, "one row for the trigger");

    assert.deepEqual(db.applyDictionaryChanges({ remove: [words.own] }), {
      success: true,
      added: 0,
      removed: 1,
    });
    assert.deepEqual(db.getDictionary(), []);
  });

  test(`${label}: the account's own word and trigger hide an unattributed twin a cloud holds`, (t) => {
    const db = createDb(t);
    if (!db) return;
    // From before attribution, with a cloud id: it may be another account's,
    // so a pull never merges into it.
    db.db
      .prepare(
        "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, legacy_unattributed) VALUES (?, 'legacy-c', 'cloud-x', 'synced', 1)"
      )
      .run(words.guest);
    db.db
      .prepare(
        "INSERT INTO snippets (trigger, replacement, client_snippet_id, cloud_id, sync_status, legacy_unattributed) VALUES (?, 'guest text', 'legacy-s', 'cloud-y', 'synced', 1)"
      )
      .run(words.guestTrigger);
    db.setActiveAccountId(A);
    db.upsertDictionaryFromCloud({ id: "a-w1", client_dict_id: "a-c1", word: words.own });
    db.upsertSnippetFromCloud({
      id: "a-s1",
      client_snippet_id: "a-cs1",
      trigger: words.ownTrigger,
      replacement: "A's text",
    });

    assert.deepEqual(db.getDictionary(), [words.own], "the twin is hidden");
    assert.deepEqual(
      db.getSnippets(),
      [{ trigger: words.ownTrigger, replacement: "A's text" }],
      "only the account's own trigger reaches expansion"
    );

    assert.deepEqual(db.applyDictionaryChanges({ remove: [words.own] }), {
      success: true,
      added: 0,
      removed: 1,
    });
    assert.deepEqual(
      db.getDictionary(),
      [],
      "the removal reached A's row, and the twin stays hidden"
    );
    assert.deepEqual(rows(db, "custom_dictionary", "word"), [
      { key: words.guest, account_id: null, deleted: 0 },
      { key: words.own, account_id: A, deleted: 1 },
    ]);
    db.setSnippets([]);
    assert.deepEqual(db.getSnippets(), []);
    assert.deepEqual(rows(db, "snippets", "trigger"), [
      { key: words.guestTrigger, account_id: null, deleted: 0 },
      { key: words.ownTrigger, account_id: A, deleted: 1 },
    ]);
  });
}

test("a pulled word or trigger merges into a never-synced unattributed casing of it", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(A);
  // Written signed out after attribution existed, so it may merge.
  db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, client_dict_id, sync_status) VALUES ('café', 'local-c', 'pending')"
    )
    .run();
  db.db
    .prepare(
      "INSERT INTO snippets (trigger, replacement, client_snippet_id, sync_status) VALUES ('déjà', 'local', 'local-s', 'pending')"
    )
    .run();

  db.upsertDictionaryFromCloud({ id: "a-w1", client_dict_id: "a-c1", word: "CAFÉ" });
  db.upsertSnippetFromCloud({
    id: "a-s1",
    client_snippet_id: "a-cs1",
    trigger: "DÉJÀ",
    replacement: "A's text",
  });

  // The word's local edit was still pending, so it keeps its own spelling.
  assert.deepEqual(rows(db, "custom_dictionary", "word"), [
    { key: "café", account_id: A, deleted: 0 },
  ]);
  assert.deepEqual(rows(db, "snippets", "trigger"), [{ key: "DÉJÀ", account_id: A, deleted: 0 }]);
});

test("a whole-list write keeps the account's own row when an unattributed casing shares its key", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(A);
  // Two casings an older build could store side by side, the account's first.
  db.applyDictionaryChanges({ add: ["Äpfel"] });
  db.setSnippets([{ trigger: "Öl", replacement: "A's text" }]);
  db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, legacy_unattributed) VALUES ('äpfel', 'legacy-c', 'cloud-x', 'synced', 1)"
    )
    .run();
  db.db
    .prepare(
      "INSERT INTO snippets (trigger, replacement, client_snippet_id, cloud_id, sync_status, legacy_unattributed) VALUES ('öl', 'legacy', 'legacy-s', 'cloud-y', 'synced', 1)"
    )
    .run();

  db.setDictionary(["ÄPFEL"]);
  db.setSnippets([{ trigger: "ÖL", replacement: "A's new text" }]);

  assert.deepEqual(rows(db, "custom_dictionary", "word"), [
    { key: "ÄPFEL", account_id: A, deleted: 0 },
    { key: "äpfel", account_id: null, deleted: 0 },
  ]);
  assert.deepEqual(rows(db, "snippets", "trigger"), [
    { key: "ÖL", account_id: A, deleted: 0 },
    { key: "öl", account_id: null, deleted: 0 },
  ]);
  assert.deepEqual(db.getDictionary(), ["ÄPFEL"]);
});

test("a sole account's claim leaves a non-ASCII casing whose twin a cloud may hold", (t) => {
  const db = createDb(t);
  if (!db) return;
  const insert = db.db.prepare(
    "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, legacy_unattributed) VALUES (?, ?, ?, ?, 1)"
  );
  insert.run("élan", "c-elan", "cloud-elan", "synced");
  insert.run("ÉLAN", "c-elan-2", null, "pending");

  db.setActiveAccountId(A);
  db.claimLegacyRowsOfOnlyAccount();

  assert.deepEqual(rows(db, "custom_dictionary", "word"), [
    { key: "élan", account_id: null, deleted: 0 },
    { key: "ÉLAN", account_id: null, deleted: 0 },
  ]);
});

test("Turkish İ folds as JavaScript folds it, the same in SQL as in the write paths", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(null);
  db.applyDictionaryChanges({ add: ["istanbul", "i̇zmir"] });
  db.setActiveAccountId(A);
  // "İ".toLowerCase() is "i̇" (i + U+0307), so "İstanbul" is not "istanbul",
  // while "İzmir" is "i̇zmir".
  db.upsertDictionaryFromCloud({ id: "a-w1", client_dict_id: "a-c1", word: "İstanbul" });
  db.upsertDictionaryFromCloud({ id: "a-w2", client_dict_id: "a-c2", word: "İzmir" });

  assert.deepEqual(db.getDictionary().sort(), ["istanbul", "i̇zmir", "İstanbul"].sort());
  assert.equal(rows(db, "custom_dictionary", "word").length, 3, "İzmir merged into i̇zmir");
});
