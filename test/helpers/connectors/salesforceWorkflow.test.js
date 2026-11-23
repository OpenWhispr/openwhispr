const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { buildSalesforceConnector } = require("../../../src/helpers/connectors/salesforceConnector");
const { createConnectorManager } = require("../../../src/helpers/connectors/connectorManager");
const { createPendingActions } = require("../../../src/helpers/connectors/pendingActions");
const { createSalesforceNoteReader } = require("../../../src/helpers/connectors/salesforceNotes");
const { i18nMain } = require("../../../src/helpers/i18nMain");

test("real connector pipeline exports, reviews field edits, briefs linked notes and updates the same activity", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const owner = "account-a";
  const instanceUrl = "https://example.my.salesforce.com";
  const recordId = "006000000000001AAA";
  const taskId = "00T000000000001EAA";
  const modified = "2026-11-02T10:00:00.000+0000";
  const record = {
    Id: recordId,
    Name: "Acme renewal",
    StageName: "Needs Analysis",
    Amount: null,
    CurrencyIsoCode: "USD",
    CloseDate: "2026-11-25",
    NextStep: null,
    AccountId: null,
    OwnerId: "005000000000001AAA",
    LastModifiedDate: modified,
    Summary__c: "Old summary",
    Needs__c: "Old needs",
  };
  let task = null;
  let sourceDeleted = false;
  const writes = [];
  const field = (name, extra = {}) => ({
    name,
    label: name,
    type: "string",
    length: 255,
    createable: true,
    updateable: true,
    ...extra,
  });
  const metadata = {
    Opportunity: {
      queryable: true,
      updateable: true,
      fields: [
        field("Id"),
        field("Name"),
        field("LastModifiedDate"),
        ...[
          "StageName",
          "Amount",
          "CurrencyIsoCode",
          "CloseDate",
          "NextStep",
          "AccountId",
          "OwnerId",
        ].map((name) => field(name)),
        field("Summary__c", { custom: true }),
        field("Needs__c", { custom: true }),
      ],
    },
    Task: {
      createable: true,
      updateable: true,
      fields: [
        field("Subject"),
        field("Description", { length: 32000 }),
        field("Status", { picklistValues: [{ active: true, value: "Completed" }] }),
        field("WhoId", { referenceTo: ["Contact", "Lead"] }),
        field("WhatId", { referenceTo: ["Account", "Opportunity"] }),
      ],
    },
  };
  const credential = {
    userId: "005000000000001AAA",
    organizationId: "00D000000000001EAA",
    instanceUrl,
    loginUrl: "https://login.salesforce.com",
    accessToken: "synthetic-test-token",
    expiresAt: null,
    userName: "Test User",
    organizationName: "Test Org",
  };
  const credentials = { activeAccountId: () => owner, read: () => ({ credential, generation: 1 }) };
  const database = {
    db,
    activeAccountId: owner,
    getNote: (id) =>
      id === 7 && !sourceDeleted
        ? {
            id,
            account_id: owner,
            title: "Renewal call",
            created_at: "2026-11-02 09:00:00",
            updated_at: "2026-11-03 09:00:00",
            deleted_at: null,
          }
        : null,
  };
  const connector = buildSalesforceConnector({
    credentials,
    database,
    getSalesforceNote: createSalesforceNoteReader({ database, getAccountId: () => owner }),
    env: { SALESFORCE_CLIENT_ID: "synthetic-client" },
    i18n: i18nMain,
    logger: { warn() {} },
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, instanceUrl);
      assert.equal(init.redirect, "manual");
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/describe"))
        return Response.json(metadata[pathname.split("/").at(-2)]);
      if (pathname.endsWith("/query")) {
        const query = new URL(url).searchParams.get("q");
        return Response.json({
          records: query.includes("TaskStatus") ? [{ ApiName: "Completed" }] : [record],
          done: true,
        });
      }
      if (init.method === "GET") return Response.json(pathname.includes("/Task/") ? task : record);
      const body = JSON.parse(init.body);
      writes.push({ pathname, method: init.method, body });
      if (init.method === "POST") {
        task = { ...body, Id: taskId, WhoId: null, LastModifiedDate: modified };
        return Response.json({ id: taskId, success: true, errors: [] }, { status: 201 });
      }
      Object.assign(pathname.includes("/Task/") ? task : record, body);
      return new Response(null, { status: 204 });
    },
  });
  const receipts = new Map();
  const manager = createConnectorManager({
    connectors: [connector],
    pendingActions: createPendingActions(),
    credentials,
    getAccountId: () => owner,
    logger: { info() {}, warn() {} },
    actionLog: {
      reconcileInterrupted: () => ({}),
      insert: (row) => receipts.set(row.id, row),
      update: (id, patch, from) => {
        const row = receipts.get(id);
        if (!row || (from && row.state !== from)) return 0;
        Object.assign(row, patch);
        return 1;
      },
    },
  });
  const permission = { policyState: "allowed", accountId: owner };
  const destination = { objectType: "Opportunity", recordId, noteId: 7 };
  const search = await manager.query(
    "salesforce",
    "search_records",
    { query: "Acme", objectType: "Opportunity" },
    permission
  );
  assert.equal(search.status, "ok");
  assert.equal(search.items[0].recordId.slice(0, 15), recordId.slice(0, 15));
  const prepared = await manager.prepare(
    "salesforce",
    "export_conversation",
    { ...destination, title: "Renewal", body: "The customer needs a larger plan." },
    permission
  );
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.preview.title, "Renewal");
  assert.match(prepared.preview.body, /Renewal call/);
  assert.equal(writes.length, 0);
  const saved = await manager.commit(
    prepared.actionId,
    { title: "Reviewed renewal", body: prepared.preview.body },
    permission
  );
  assert.equal(saved.state, "sent");
  assert.equal(writes[0].body.Subject, "Reviewed renewal");
  assert.equal(writes[0].body.Status, "Completed");
  const fieldPreview = await manager.prepare(
    "salesforce",
    "update_fields",
    {
      ...destination,
      fields: [
        { name: "Summary__c", value: "New summary" },
        { name: "Needs__c", value: "New needs" },
      ],
    },
    permission
  );
  assert.equal(fieldPreview.status, "ready");
  assert.equal(fieldPreview.preview.salesforceFields[0].before, "Old summary");
  const updated = await manager.commit(
    fieldPreview.actionId,
    { value0: "Reviewed summary", include0: "yes", value1: "New needs", include1: "no" },
    permission
  );
  assert.equal(updated.state, "sent");
  assert.deepEqual(writes[1].body, { Summary__c: "Reviewed summary" });
  assert.equal(record.Needs__c, "Old needs");
  const briefing = await manager.query("salesforce", "get_briefing", destination, permission);
  assert.equal(briefing.status, "ok");
  assert.equal(briefing.items[0].Name, "Acme renewal");
  assert.equal(
    briefing.items[0].url,
    "https://example.my.salesforce.com/lightning/r/Opportunity/006000000000001AAA/view"
  );
  assert.ok(Number.isFinite(Date.parse(briefing.items[0].retrievedAt)));
  assert.equal(briefing.items[0].Amount, null);
  assert.equal(briefing.items[0].NextStep, null);
  assert.equal(briefing.items[0].AccountId, null);
  assert.deepEqual(briefing.items[0].unavailableFields, []);
  assert.equal(briefing.items[0].unavailableNotes, 0);
  assert.equal(briefing.truncated, false, "source metadata survives the bounded query result");
  assert.deepEqual(
    briefing.items.filter((item) => item.kind === "note").map((item) => item.noteId),
    [7]
  );
  const sourceNote = briefing.items.find((item) => item.kind === "note");
  assert.equal(
    sourceNote.activityUrl,
    "https://example.my.salesforce.com/lightning/r/Task/00T000000000001EAA/view"
  );
  assert.ok(sourceNote.exportedAt);
  assert.equal(writes.length, 2, "briefing never writes");
  const correction = await manager.prepare(
    "salesforce",
    "export_conversation",
    { ...destination, title: "Corrected renewal", body: "Corrected summary" },
    permission
  );
  assert.equal(correction.status, "ready");
  assert.equal((await manager.commit(correction.actionId, {}, permission)).state, "sent");
  assert.equal(writes.filter((write) => write.method === "POST").length, 1);
  assert.ok(writes[2].pathname.includes(`/Task/${taskId.slice(0, 15)}`));
  sourceDeleted = true;
  const withoutNote = await manager.query("salesforce", "get_briefing", destination, permission);
  assert.equal(withoutNote.items.filter((item) => item.kind === "note").length, 0);
});
