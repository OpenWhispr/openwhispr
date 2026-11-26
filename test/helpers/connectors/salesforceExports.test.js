const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createSalesforceExports } = require("../../../src/helpers/connectors/salesforceExports");
const key = {
  ownerAccountId: "owner",
  organizationId: "org",
  instanceUrl: "https://tenant.my.salesforce.com",
  noteId: 1,
  objectType: "Opportunity",
  recordId: "006000000000001",
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  return { db, store: createSalesforceExports({ db }) };
}
test("durable reservation prevents concurrent exports and keeps outcomes separate", () => {
  const { store } = fixture();
  assert.equal(store.begin(key, "activity", "first", 0), true);
  assert.equal(store.begin(key, "activity", "second", 0), false);
  assert.equal(store.finish(key, "activity", "first", "succeeded", "00T000000000001"), true);
  const saved = store.get(key);
  assert.equal(saved.activity_id, "00T000000000001");
  assert.equal(store.begin(key, "fields", "fields", saved.version), true);
  store.finish(key, "fields", "fields", "failed");
  assert.equal(store.get(key).activity_state, "succeeded");
  assert.equal(store.get(key).fields_state, "failed");
  assert.equal(store.begin(key, "activity", "old-card", 0), false);
});
test("restart marks dispatched writes unknown; only a card prepared after that can write again", () => {
  const { db, store } = fixture();
  store.begin(key, "activity", "interrupted", 0);
  const restarted = createSalesforceExports({ db });
  assert.equal(restarted.get(key).activity_state, "unknown");
  assert.equal(restarted.begin(key, "activity", "old-card", 0), false);
  assert.equal(restarted.begin(key, "activity", "retry", restarted.get(key).version), true);
});
test("confirmed associations are scoped to owner, org and exact destination", () => {
  const { store } = fixture();
  store.begin(key, "activity", "one", 0);
  store.finish(key, "activity", "one", "succeeded", "00T000000000001");
  assert.equal(store.list(key).length, 1);
  for (const change of [
    { ownerAccountId: "other" },
    { organizationId: "other" },
    { recordId: "006000000000002" },
  ]) {
    assert.equal(store.list({ ...key, ...change }).length, 0);
    assert.equal(store.get({ ...key, ...change }), null);
  }
});
test("a renamed My Domain keeps the organization's associations", () => {
  const { store } = fixture();
  const renamed = { ...key, instanceUrl: "https://renamed.my.salesforce.com" };
  store.begin(key, "activity", "one", 0);
  store.finish(key, "activity", "one", "succeeded", "00T000000000001");
  assert.equal(store.list(renamed).length, 1);
  const saved = store.get(renamed);
  assert.equal(saved.activity_id, "00T000000000001");
  assert.equal(store.begin(renamed, "activity", "two", saved.version), true);
  assert.equal(store.finish(renamed, "activity", "two", "succeeded", saved.activity_id), true);
});
test("a write in flight finishes under the instance URL it began on", () => {
  const { store } = fixture();
  const renamed = { ...key, instanceUrl: "https://renamed.my.salesforce.com" };
  store.begin(key, "activity", "one", 0);
  assert.equal(store.get(renamed), null);
  assert.equal(store.finish(key, "activity", "one", "succeeded", "00T000000000001"), true);
  assert.equal(store.get(renamed).activity_id, "00T000000000001");
});

test("closing and reopening SQLite preserves confirmed activity and interrupted field outcome", () => {
  const { randomUUID } = require("node:crypto");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { unlinkSync } = require("node:fs");
  const path = join(tmpdir(), `salesforce-exports-${randomUUID()}.sqlite`);
  let db = new DatabaseSync(path);
  try {
    const store = createSalesforceExports({ db });
    store.begin(key, "activity", "saved", 0);
    store.finish(key, "activity", "saved", "succeeded", "00T000000000001");
    store.begin(key, "fields", "interrupted", store.get(key).version);
    db.close();
    db = new DatabaseSync(path);
    const restarted = createSalesforceExports({ db });
    const saved = restarted.get(key);
    assert.equal(saved.activity_state, "succeeded");
    assert.equal(saved.activity_id, "00T000000000001");
    assert.equal(saved.fields_state, "unknown");
    assert.equal(restarted.begin(key, "fields", "old-card", saved.version - 1), false);
    assert.equal(restarted.begin(key, "fields", "retry", saved.version), true);
    assert.equal(restarted.list(key).length, 1);
  } finally {
    db.close();
    unlinkSync(path);
  }
});

test("a table from before activity_hash gains the column and keeps its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE salesforce_exports (
    account_id TEXT NOT NULL, organization_id TEXT NOT NULL, instance_url TEXT NOT NULL,
    note_id INTEGER NOT NULL, object_type TEXT NOT NULL, record_id TEXT NOT NULL,
    activity_id TEXT, activity_state TEXT NOT NULL DEFAULT 'idle',
    fields_state TEXT NOT NULL DEFAULT 'idle', operation_id TEXT,
    version INTEGER NOT NULL DEFAULT 0, confirmed_at TEXT,
    PRIMARY KEY (account_id, organization_id, instance_url, note_id, object_type, record_id)
  )`);
  db.prepare(
    `INSERT INTO salesforce_exports (account_id, organization_id, instance_url, note_id, object_type, record_id, activity_id, activity_state)
    VALUES (?, ?, ?, ?, ?, ?, '00T000000000001', 'succeeded')`
  ).run(
    key.ownerAccountId,
    key.organizationId,
    key.instanceUrl,
    key.noteId,
    key.objectType,
    key.recordId
  );
  const store = createSalesforceExports({ db });
  const saved = store.get(key);
  assert.equal(saved.activity_id, "00T000000000001");
  assert.equal(saved.activity_hash, null);
  assert.equal(store.begin(key, "activity", "next", saved.version), true);
  assert.equal(store.finish(key, "activity", "next", "succeeded", "00T000000000001", "hash"), true);
  assert.equal(store.get(key).activity_hash, "hash");
});
test("the stored text's hash replaces the sent one only until another write begins", () => {
  const { store } = fixture();
  store.begin(key, "activity", "one", 0);
  store.finish(key, "activity", "one", "succeeded", "00T000000000001", "sent");
  assert.equal(store.recordActivityHash(key, "00T000000000001", 1, "stored"), true);
  assert.equal(store.get(key).activity_hash, "stored");
  store.begin(key, "fields", "fields", 1);
  // A read-back that lands after a later write began changes nothing.
  assert.equal(store.recordActivityHash(key, "00T000000000001", 1, "late"), false);
  assert.equal(store.get(key).activity_hash, "stored");
});
