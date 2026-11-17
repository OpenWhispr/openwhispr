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
test("restart marks dispatched writes unknown and blocks automatic retries", () => {
  const { db, store } = fixture();
  store.begin(key, "activity", "interrupted", 0);
  const restarted = createSalesforceExports({ db });
  assert.equal(restarted.get(key).activity_state, "unknown");
  assert.equal(restarted.begin(key, "activity", "retry", restarted.get(key).version), false);
});
test("confirmed associations are scoped to owner, org, instance and exact destination", () => {
  const { store } = fixture();
  store.begin(key, "activity", "one", 0);
  store.finish(key, "activity", "one", "succeeded", "00T000000000001");
  assert.equal(store.list(key).length, 1);
  for (const change of [
    { ownerAccountId: "other" },
    { organizationId: "other" },
    { instanceUrl: "https://other.my.salesforce.com" },
    { recordId: "006000000000002" },
  ]) {
    assert.equal(store.list({ ...key, ...change }).length, 0);
    assert.equal(store.get({ ...key, ...change }), null);
  }
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
    assert.equal(restarted.begin(key, "fields", "retry", saved.version), false);
    assert.equal(restarted.list(key).length, 1);
  } finally {
    db.close();
    unlinkSync(path);
  }
});
