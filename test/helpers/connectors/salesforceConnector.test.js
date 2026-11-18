const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createSalesforceExports } = require("../../../src/helpers/connectors/salesforceExports");
const {
  createSalesforceConnector,
} = require("../../../src/helpers/connectors/salesforceConnector");
const { i18nMain, changeLanguage } = require("../../../src/helpers/i18nMain");
const instanceUrl = "https://tenant.my.salesforce.com";
const binding = {
  ownerAccountId: "owner",
  accountId: "user",
  workspaceId: "org",
  instanceUrl,
  generation: 1,
};
const recordId = "006000000000001";
const activityId = "00T000000000001";
const args = {
  objectType: "Opportunity",
  recordId,
  noteId: 1,
  title: "Meeting",
  body: "Customer needs and agreed next steps",
};
const modified = "2026-11-02T10:00:00.000+0000";
function field(name, extra = {}) {
  return {
    name,
    label: name,
    type: "string",
    length: 255,
    createable: true,
    updateable: true,
    ...extra,
  };
}
function fixture() {
  const calls = [];
  let current = true;
  const notes = new Map([
    [1, { id: 1, title: "Conversation", account_id: "owner" }],
    [2, { id: 2, title: "Extra", account_id: "owner" }],
  ]);
  const record = {
    Id: recordId,
    Name: "Selected deal",
    LastModifiedDate: modified,
    Notes__c: "Before",
    StageName: "Discovery",
  };
  const task = {
    Id: activityId,
    Subject: args.title,
    Description: args.body,
    WhatId: recordId,
    WhoId: null,
    LastModifiedDate: modified,
  };
  const metadata = {
    Opportunity: {
      queryable: true,
      updateable: true,
      fields: [
        field("Id"),
        field("Name"),
        field("LastModifiedDate"),
        field("StageName"),
        field("Notes__c", { custom: true, length: 500 }),
        field("Rich__c", { custom: true, htmlFormatted: true }),
        field("Formula__c", { custom: true, calculated: true }),
        field("Number__c", { custom: true, type: "double" }),
      ],
    },
    Task: {
      createable: true,
      updateable: true,
      fields: [
        field("Subject"),
        field("Description", { type: "textarea", length: 32000 }),
        field("Status", { picklistValues: [{ value: "Done", active: true }] }),
        field("WhatId", { referenceTo: ["Opportunity", "Account"] }),
        field("WhoId", { referenceTo: ["Contact", "Lead"] }),
      ],
    },
  };
  const db = new DatabaseSync(":memory:");
  const store = createSalesforceExports({ db });
  const credential = {
    userId: "user",
    organizationId: "org",
    instanceUrl,
    userName: "Sales user",
    organizationName: "Org",
  };
  const auth = {
    boundCredential: () => (current ? credential : null),
    getAccessToken: async () =>
      current
        ? { ok: true, token: "token", credential }
        : { ok: false, errorCode: "connection_changed" },
    isConfigured: () => true,
    reconnects: 0,
    markReconnect() {
      this.reconnects += 1;
      return { ok: false, errorCode: "reconnect_needed" };
    },
  };
  let writeResult = null;
  const api = {
    request: async (request) => {
      calls.push(request);
      if (request.method && request.method !== "GET") {
        if (writeResult) return writeResult;
        // A saved Task reads back what was written.
        if (request.path.includes("/sobjects/Task")) Object.assign(task, request.body);
        return {
          ok: true,
          data: request.method === "POST" ? { id: activityId, success: true } : null,
        };
      }
      if (request.path.includes("/describe"))
        return { ok: true, data: metadata[request.path.split("/").at(-2)] };
      if (request.path.includes("/query?")) {
        const query = new URL(request.path, instanceUrl).searchParams.get("q");
        return {
          ok: true,
          data: {
            records: query.includes("FROM TaskStatus") ? [{ ApiName: "Done" }] : [record],
            done: true,
          },
        };
      }
      return { ok: true, data: { ...(request.path.includes("/Task/") ? task : record) } };
    },
  };
  const credentials = {
    activeAccountId: () => "owner",
    read: () => ({ credential, generation: 1 }),
  };
  const connector = createSalesforceConnector({
    api,
    auth,
    credentials,
    exports: store,
    getNote: async (id, owner) => (owner === "owner" ? (notes.get(id) ?? null) : null),
    i18n: i18nMain,
  });
  return {
    connector,
    api,
    auth,
    calls,
    notes,
    record,
    task,
    metadata,
    db,
    store,
    disconnect: () => {
      current = false;
    },
    setWriteResult: (result) => {
      writeResult = result;
    },
  };
}
const prepare = (fixture, action = "export_conversation", input = args) =>
  fixture.connector.prepare(action, input, { binding });
const commit = (fixture, preview, action = "export_conversation", edits = {}) =>
  fixture.connector.commit(action, preview.payload, edits, { binding });
const writes = (fixture) => fixture.calls.filter((call) => call.method && call.method !== "GET");

test("explicit object and record validation rejects mismatches without network calls", async () => {
  const fixtureState = fixture();
  for (const input of [
    { ...args, objectType: "Task" },
    { ...args, recordId: "001000000000001" },
    { ...args, recordId: "006000000000001'" },
  ]) {
    assert.equal((await prepare(fixtureState, "export_conversation", input)).status, "failed");
  }
  assert.equal(fixtureState.calls.length, 0);
});
test("search is bounded and escapes SOQL wildcard, quote and slash input", async () => {
  const fixtureState = fixture();
  const result = await fixtureState.connector.query(
    "search_records",
    { objectType: "Opportunity", query: "O'Hare_%\\" },
    { binding }
  );
  assert.equal(result.status, "ok");
  const query = new URL(
    fixtureState.calls.find((call) => call.path.includes("query?")).path,
    instanceUrl
  ).searchParams.get("q");
  assert.ok(query.includes("O\\'Hare\\_\\%\\\\"));
  assert.match(query, /LIMIT 11$/);
  assert.equal(writes(fixtureState).length, 0);
});
test("prepare reads only; approved save creates one completed Task and links note", async () => {
  const fixtureState = fixture();
  const preview = await prepare(fixtureState);
  assert.equal(preview.status, "ready");
  assert.equal(writes(fixtureState).length, 0);
  const result = await commit(fixtureState, preview, "export_conversation", {
    title: "Reviewed",
    body: "Approved body",
    recordId: "006000000000002",
  });
  assert.equal(result.state, "sent");
  assert.deepEqual(writes(fixtureState)[0].body, {
    Subject: "Reviewed",
    Description: "Approved body",
    Status: "Done",
    WhatId: recordId,
  });
  const briefing = await fixtureState.connector.query(
    "get_briefing",
    { objectType: "Opportunity", recordId, noteIds: [2] },
    { binding }
  );
  // A note the user chose comes first, so the note cap never drops it.
  assert.deepEqual(
    briefing.items.filter((item) => item.kind === "note").map((item) => item.noteId),
    [2, 1]
  );
});
test("concurrent approved cards create only one activity", async () => {
  const fixtureState = fixture();
  const previews = await Promise.all([prepare(fixtureState), prepare(fixtureState)]);
  const outcomes = await Promise.all(previews.map((preview) => commit(fixtureState, preview)));
  assert.equal(outcomes.filter((result) => result.state === "sent").length, 1);
  assert.equal(writes(fixtureState).length, 1);
});
const SOURCE_NOTE = {
  key: "connectors.salesforce.notes.sourceNote",
  values: { title: "Conversation" },
};
const UNCERTAIN_NOTE = { key: "connectors.salesforce.notes.earlierAttemptUncertain" };
test("an uncertain write is never retried on its own; a new card warns before the user sends again", async () => {
  const fixtureState = fixture();
  const preview = await prepare(fixtureState);
  fixtureState.setWriteResult({ ok: false, outcome: "unknown", errorCode: "network" });
  assert.equal((await commit(fixtureState, preview)).state, "unknown");
  assert.equal(writes(fixtureState).length, 1);
  const restarted = createSalesforceExports({ db: fixtureState.db });
  assert.equal(
    restarted.get({ ownerAccountId: "owner", organizationId: "org", instanceUrl, ...args })
      .activity_state,
    "unknown"
  );
  fixtureState.setWriteResult(null);
  assert.equal((await commit(fixtureState, preview)).errorCode, "duplicate_operation");
  assert.equal(writes(fixtureState).length, 1, "the card from before the write can't send");
  const retry = await prepare(fixtureState);
  assert.equal(retry.status, "ready");
  assert.deepEqual(retry.preview.notes, [SOURCE_NOTE, UNCERTAIN_NOTE]);
  assert.equal((await commit(fixtureState, retry)).state, "sent");
  assert.equal(writes(fixtureState).length, 2);
  assert.deepEqual((await prepare(fixtureState)).preview.notes, [
    SOURCE_NOTE,
    { key: "connectors.salesforce.notes.updateExisting" },
  ]);
});
test("repeat export updates known activity with concurrency condition", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  const repeat = await prepare(fixtureState);
  assert.equal(repeat.payload.activityId, activityId);
  assert.equal((await commit(fixtureState, repeat)).state, "sent");
  const update = writes(fixtureState)[1];
  assert.equal(update.method, "PATCH");
  assert.ok(update.path.endsWith(`/Task/${activityId}`));
  assert.equal(update.headers["If-Unmodified-Since"], new Date(modified).toUTCString());
});
test("changed Task and missing source reject a repeat before dispatch", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  const repeat = await prepare(fixtureState);
  fixtureState.task.Subject = "Someone else's change";
  assert.equal((await commit(fixtureState, repeat)).errorCode, "stale_record");
  fixtureState.notes.delete(1);
  assert.equal((await prepare(fixtureState)).errorCode, "source_unavailable");
  assert.equal(writes(fixtureState).length, 1);
});
test("account or connection switches and source removal after approval prevent dispatch", async () => {
  for (const change of [(state) => state.disconnect(), (state) => state.notes.delete(1)]) {
    const fixtureState = fixture();
    const preview = await prepare(fixtureState);
    change(fixtureState);
    assert.equal((await commit(fixtureState, preview)).state, "failed");
    assert.equal(writes(fixtureState).length, 0);
  }
});
test("field updates require a successful activity and only expose safe custom text fields", async () => {
  const fixtureState = fixture();
  const input = { ...args, fields: [{ name: "Notes__c", value: "After" }] };
  assert.equal((await prepare(fixtureState, "update_fields", input)).errorCode, "export_required");
  const described = await fixtureState.connector.query("describe_fields", args, { binding });
  assert.deepEqual(
    described.items.map((item) => item.name),
    ["Notes__c"]
  );
  await commit(fixtureState, await prepare(fixtureState));
  for (const name of ["StageName", "Rich__c", "Formula__c", "Number__c", "Name,Amount"]) {
    assert.equal(
      (await prepare(fixtureState, "update_fields", { ...input, fields: [{ name, value: "bad" }] }))
        .errorCode,
      "invalid_field"
    );
  }
  const preview = await prepare(fixtureState, "update_fields", input);
  assert.equal(preview.preview.salesforceFields[0].before, "Before");
  assert.equal(
    (await commit(fixtureState, preview, "update_fields", { value0: "Reviewed", include0: "yes" }))
      .state,
    "sent"
  );
  assert.deepEqual(writes(fixtureState)[1].body, { Notes__c: "Reviewed" });
  assert.equal(
    writes(fixtureState)[1].headers["If-Unmodified-Since"],
    new Date(modified).toUTCString()
  );
});
test("after a My Domain rename, a repeat export updates the same Task", async (t) => {
  const fixtureState = fixture();
  t.after(() => fixtureState.db.close());
  await commit(fixtureState, await prepare(fixtureState));
  const renamed = { ...binding, instanceUrl: "https://renamed.my.salesforce.com" };
  const repeat = await fixtureState.connector.prepare("export_conversation", args, {
    binding: renamed,
  });
  assert.equal(repeat.payload.activityId, activityId);
  assert.ok(
    repeat.preview.notes.some((note) => note.key === "connectors.salesforce.notes.updateExisting")
  );
  const result = await fixtureState.connector.commit(
    "export_conversation",
    repeat.payload,
    {},
    {
      binding: renamed,
    }
  );
  assert.equal(result.state, "sent");
  assert.equal(writes(fixtureState).length, 2);
  assert.equal(writes(fixtureState)[1].method, "PATCH");
  assert.match(writes(fixtureState)[1].path, new RegExp(`/sobjects/Task/${activityId}$`));
});
test("a repeat export leaves the Task's Status as it stands in Salesforce", async (t) => {
  const fixtureState = fixture();
  t.after(() => fixtureState.db.close());
  await commit(fixtureState, await prepare(fixtureState));
  fixtureState.task.Status = "In Progress";
  // Nothing about Status can stop a repeat export, since it no longer writes one.
  const status = fixtureState.metadata.Task.fields.find((item) => item.name === "Status");
  status.updateable = false;
  status.picklistValues = [];
  const repeat = await prepare(fixtureState);
  assert.equal(repeat.status, "ready");
  assert.equal((await commit(fixtureState, repeat)).state, "sent");
  assert.deepEqual(Object.keys(writes(fixtureState)[1].body).sort(), ["Description", "Subject"]);
  assert.equal(fixtureState.task.Status, "In Progress");
});
test("a create reply without a Task id and success is uncertain, never saved", async (t) => {
  for (const data of [
    { id: activityId },
    { id: "001000000000001", success: true },
    { success: true },
  ]) {
    const fixtureState = fixture();
    t.after(() => fixtureState.db.close());
    fixtureState.setWriteResult({ ok: true, data });
    const result = await commit(fixtureState, await prepare(fixtureState));
    assert.equal(result.state, "unknown");
    assert.equal(result.url, undefined);
  }
});
test("field stale checks, live metadata limits and omissions prevent unintended writes", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  const input = { ...args, fields: [{ name: "Notes__c", value: "After" }] };
  const preview = await prepare(fixtureState, "update_fields", input);
  fixtureState.record.Notes__c = "Changed";
  assert.equal((await commit(fixtureState, preview, "update_fields")).errorCode, "stale_record");
  fixtureState.record.Notes__c = "Before";
  assert.equal(
    (await commit(fixtureState, preview, "update_fields", { value0: "x".repeat(501) })).errorCode,
    "too_long"
  );
  assert.equal(
    (await commit(fixtureState, preview, "update_fields", { include0: "no" })).state,
    "failed"
  );
  assert.equal(writes(fixtureState).length, 1);
});
test("briefing excludes inaccessible linked notes and exposes only explicitly selected additional ids", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  fixtureState.notes.delete(1);
  const result = await fixtureState.connector.query("get_briefing", args, { binding });
  assert.equal(result.items.filter((item) => item.kind === "note").length, 0);
  assert.equal(result.items[0].unavailableNotes, 1);
  assert.equal(writes(fixtureState).length, 1);
});

test("briefing distinguishes an empty CRM field from a field not returned", async (t) => {
  const fixtureState = fixture();
  t.after(() => fixtureState.db.close());
  fixtureState.metadata.Opportunity.fields.push(field("Amount"), field("NextStep"));
  fixtureState.record.Amount = null;
  fixtureState.record.NextStep = "";
  const result = await fixtureState.connector.query("get_briefing", args, { binding });
  assert.equal(result.status, "ok");
  assert.equal(result.items[0].Amount, null);
  assert.equal(result.items[0].NextStep, "");
  assert.equal(Object.hasOwn(result.items[0], "AccountId"), false);
  assert.deepEqual(result.items[0].unavailableFields, [
    "CurrencyIsoCode",
    "CloseDate",
    "AccountId",
    "OwnerId",
  ]);
  assert.equal(result.items.length, 1, "no note context is invented without an association");
  assert.equal(writes(fixtureState).length, 0);
});

test("explicit additional notes do not inherit another note's activity link or dates", async (t) => {
  const fixtureState = fixture();
  t.after(() => fixtureState.db.close());
  await commit(fixtureState, await prepare(fixtureState));
  const result = await fixtureState.connector.query(
    "get_briefing",
    { objectType: "Opportunity", recordId, noteIds: [2] },
    { binding }
  );
  const linkedNote = result.items.find((item) => item.noteId === 1);
  assert.equal(
    linkedNote.activityUrl,
    "https://tenant.my.salesforce.com/lightning/r/Task/00T000000000001/view"
  );
  const extraNote = result.items.find((item) => item.noteId === 2);
  assert.equal(extraNote.activityUrl, null);
  assert.equal(extraNote.exportedAt, null);
});

test("15- and 18-character destination IDs share one association and read Salesforce's canonical response", async () => {
  const fixtureState = fixture();
  fixtureState.record.Id = `${recordId}AAA`;
  fixtureState.task.WhatId = `${recordId}AAA`;
  const first = await prepare(fixtureState);
  assert.equal(first.status, "ready");
  assert.equal((await commit(fixtureState, first)).state, "sent");
  const repeat = await prepare(fixtureState, "export_conversation", {
    ...args,
    recordId: `${recordId}AAA`,
  });
  assert.equal(repeat.status, "ready");
  assert.equal(repeat.payload.activityId, activityId);
  assert.equal((await commit(fixtureState, repeat)).state, "sent");
  assert.deepEqual(
    writes(fixtureState).map((call) => call.method),
    ["POST", "PATCH"]
  );
});

test("live Task relationship and field permissions are checked again before writing", async () => {
  const fixtureState = fixture();
  const preview = await prepare(fixtureState);
  fixtureState.metadata.Task.fields.find((field) => field.name === "WhatId").createable = false;
  assert.equal((await commit(fixtureState, preview)).errorCode, "forbidden");
  assert.equal(writes(fixtureState).length, 0);
  fixtureState.metadata.Task.fields.find((field) => field.name === "WhatId").createable = true;
  await commit(fixtureState, preview);
  const repeat = await prepare(fixtureState);
  fixtureState.task.WhatId = "006000000000002";
  assert.equal((await commit(fixtureState, repeat)).errorCode, "stale_record");
  assert.equal(writes(fixtureState).length, 1);
});

test("field-write failure and uncertainty preserve the saved activity", async () => {
  for (const outcome of ["failed", "unknown"]) {
    const fixtureState = fixture();
    await commit(fixtureState, await prepare(fixtureState));
    const input = { ...args, fields: [{ name: "Notes__c", value: "After" }] };
    const preview = await prepare(fixtureState, "update_fields", input);
    fixtureState.setWriteResult({
      ok: false,
      errorCode: outcome === "failed" ? "FIELD_CUSTOM_VALIDATION_EXCEPTION" : "network",
      outcome,
    });
    assert.equal((await commit(fixtureState, preview, "update_fields")).state, outcome);
    const saved = fixtureState.store.get({
      ownerAccountId: "owner",
      organizationId: "org",
      instanceUrl,
      ...args,
    });
    assert.equal(saved.activity_id, activityId);
    assert.equal(saved.activity_state, "succeeded");
    assert.equal(saved.fields_state, outcome);
    const again = await prepare(fixtureState, "update_fields", input);
    assert.equal(again.status, "ready");
    assert.deepEqual(
      again.preview.notes,
      outcome === "unknown" ? [SOURCE_NOTE, UNCERTAIN_NOTE] : [SOURCE_NOTE]
    );
  }
});

test("payload account, org and instance must match the bound login", async () => {
  const fixtureState = fixture();
  const preview = await prepare(fixtureState);
  for (const changed of [
    { ownerAccountId: "other" },
    { organizationId: "other" },
    { instanceUrl: "https://other.my.salesforce.com" },
  ]) {
    const result = await commit(fixtureState, {
      ...preview,
      payload: { ...preview.payload, ...changed },
    });
    assert.equal(result.errorCode, "connection_changed");
  }
  assert.equal(writes(fixtureState).length, 0);
});

test("activity preview exposes the complete reviewed title and source provenance", async () => {
  const fixtureState = fixture();
  fixtureState.notes.get(1).created_at = "2026-11-01T09:00:00Z";
  const preview = await prepare(fixtureState);
  assert.equal(preview.preview.title, args.title);
  assert.equal(preview.preview.fields, undefined);
  assert.match(preview.preview.body, /Source: OpenWhispr — Conversation \(2026-11-01\)/);
  assert.equal(preview.payload.body, preview.preview.body);
  await commit(fixtureState, preview);
  assert.equal(writes(fixtureState)[0].body.Description, preview.preview.body);
});

test("Account/Opportunity use WhatId and Contact/Lead use WhoId", async () => {
  for (const [objectType, prefix, relationship] of [
    ["Account", "001", "WhatId"],
    ["Opportunity", "006", "WhatId"],
    ["Contact", "003", "WhoId"],
    ["Lead", "00Q", "WhoId"],
  ]) {
    const fixtureState = fixture();
    const id = `${prefix}000000000001`;
    fixtureState.record.Id = id;
    fixtureState.metadata[objectType] = fixtureState.metadata.Opportunity;
    const preview = await prepare(fixtureState, "export_conversation", {
      ...args,
      objectType,
      recordId: id,
    });
    assert.equal(preview.status, "ready");
    assert.equal((await commit(fixtureState, preview)).state, "sent");
    assert.equal(writes(fixtureState)[0].body[relationship], id);
    assert.equal(
      Object.keys(writes(fixtureState)[0].body).filter((name) => ["WhoId", "WhatId"].includes(name))
        .length,
      1
    );
  }
});

test("source removed during token acquisition is rejected immediately before dispatch", async () => {
  const fixtureState = fixture();
  const preview = await prepare(fixtureState);
  const begin = fixtureState.store.begin;
  const getAccessToken = fixtureState.auth.getAccessToken;
  fixtureState.store.begin = (...params) => {
    const result = begin(...params);
    fixtureState.auth.getAccessToken = async () => {
      fixtureState.notes.delete(1);
      return getAccessToken();
    };
    return result;
  };
  assert.equal((await commit(fixtureState, preview)).errorCode, "source_unavailable");
  assert.equal(writes(fixtureState).length, 0);
});

test("in-flight query cannot return CRM data after switching the login", async () => {
  const fixtureState = fixture();
  const request = fixtureState.api.request;
  fixtureState.api.request = async (input) => {
    const result = await request(input);
    fixtureState.disconnect();
    return result;
  };
  const result = await fixtureState.connector.query("get_record", args, { binding });
  assert.equal(result.errorCode, "connection_changed");
  assert.equal(result.items, undefined);
});

test("ambiguous invalid-session failures are not retried", async () => {
  const fixtureState = fixture();
  const preview = await prepare(fixtureState);
  fixtureState.setWriteResult({ ok: false, errorCode: "INVALID_SESSION_ID", outcome: "unknown" });
  assert.equal((await commit(fixtureState, preview)).state, "unknown");
  assert.equal(writes(fixtureState).length, 1);
});

test("field permissions are re-read and server concurrency refusals remain definite failures", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  const input = { ...args, fields: [{ name: "Notes__c", value: "After" }] };
  const preview = await prepare(fixtureState, "update_fields", input);
  const field = fixtureState.metadata.Opportunity.fields.find((field) => field.name === "Notes__c");
  field.updateable = false;
  assert.equal((await commit(fixtureState, preview, "update_fields")).errorCode, "invalid_field");
  assert.equal(writes(fixtureState).length, 1);
  field.updateable = true;
  fixtureState.setWriteResult({ ok: false, errorCode: "http_412", outcome: "failed" });
  const result = await commit(fixtureState, preview, "update_fields");
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "stale_record");
});

test("default search preserves accessible matches and reports unavailable object scope", async () => {
  const fixtureState = fixture();
  const { normalizeQueryResult } = require("../../../src/helpers/connectors/queryResult");
  const request = fixtureState.api.request;
  fixtureState.api.request = async (input) => {
    if (input.path.includes("/Contact/describe"))
      return { ok: false, errorCode: "INVALID_TYPE", outcome: "failed" };
    if (input.path.includes("/Lead/describe"))
      return { ok: false, errorCode: "INSUFFICIENT_ACCESS", outcome: "failed" };
    if (input.path.includes("/Account/describe"))
      return { ok: true, data: fixtureState.metadata.Opportunity };
    if (input.path.includes("/query?") && decodeURIComponent(input.path).includes("FROM Account"))
      return {
        ok: true,
        data: { records: [{ Id: "001000000000001", Name: "Account match" }], done: true },
      };
    return request(input);
  };
  const result = normalizeQueryResult(
    await fixtureState.connector.query("search_records", { query: "match" }, { binding })
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.items.filter((item) => item.kind === "record").map((item) => item.objectType),
    ["Account", "Opportunity"]
  );
  const scope = result.items.find((item) => item.kind === "search_scope");
  assert.deepEqual(scope.unavailableObjects, ["Contact", "Lead"]);
  assert.equal(scope.unavailableObjectCount, 2);
  assert.equal(result.truncated, true);
  const explicit = await fixtureState.connector.query(
    "search_records",
    { query: "match", objectType: "Contact" },
    { binding }
  );
  assert.equal(explicit.errorCode, "forbidden");
});

test("cross-object search skips local query permission errors but preserves auth and network failures", async () => {
  for (const [errorCode, copyCode] of [
    ["INVALID_FIELD"],
    ["INVALID_SESSION_ID", "reconnect_needed"],
    ["network", "network"],
    ["REQUEST_LIMIT_EXCEEDED", "rate_limited"],
  ]) {
    const fixtureState = fixture();
    const request = fixtureState.api.request;
    fixtureState.api.request = async (input) => {
      if (input.path.includes("/Account/describe"))
        return { ok: true, data: fixtureState.metadata.Opportunity };
      if (input.path.includes("/query?") && decodeURIComponent(input.path).includes("FROM Account"))
        return { ok: false, errorCode, outcome: "failed" };
      return request(input);
    };
    const result = await fixtureState.connector.query(
      "search_records",
      { query: "match" },
      { binding }
    );
    if (errorCode === "INVALID_FIELD") {
      assert.equal(result.status, "ok");
      assert.equal(
        result.items.some((item) => item.kind === "record" && item.objectType === "Opportunity"),
        true
      );
      assert.ok(
        result.items
          .find((item) => item.kind === "search_scope")
          .unavailableObjects.includes("Account")
      );
    } else {
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, copyCode);
      assert.equal(fixtureState.auth.reconnects, errorCode === "INVALID_SESSION_ID" ? 1 : 0);
    }
  }
});

test("field-name and label filtering can reach metadata beyond the first twenty fields", async () => {
  const fixtureState = fixture();
  fixtureState.metadata.Opportunity.fields.push(
    ...Array.from({ length: 24 }, (_, index) =>
      field(`Custom${index}__c`, {
        custom: true,
        label: index === 23 ? "Customer requests" : `Custom ${index}`,
      })
    )
  );
  const first = await fixtureState.connector.query("describe_fields", args, { binding });
  assert.equal(first.items.length, 20);
  assert.equal(first.truncated, true);
  for (const query of ["  CUSTOM23  ", "customer REQUESTS"]) {
    const result = await fixtureState.connector.query(
      "describe_fields",
      { ...args, query },
      { binding }
    );
    assert.equal(result.status, "ok");
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.items.map((item) => item.name),
      ["Custom23__c"]
    );
  }
  for (const query of ["x".repeat(201), 42, { name: "Notes__c" }]) {
    const result = await fixtureState.connector.query(
      "describe_fields",
      { ...args, query },
      { binding }
    );
    assert.equal(result.errorCode, "invalid_input");
  }
  const empty = await fixtureState.connector.query(
    "describe_fields",
    { ...args, query: "  " },
    { binding }
  );
  assert.equal(empty.items.length, 20);
});

test("search completeness marker survives the twenty-item result bound", async () => {
  const fixtureState = fixture();
  const { normalizeQueryResult } = require("../../../src/helpers/connectors/queryResult");
  fixtureState.api.request = async (input) => {
    if (input.path.includes("/Contact/describe"))
      return { ok: false, errorCode: "INVALID_TYPE", outcome: "failed" };
    if (input.path.includes("/describe"))
      return { ok: true, data: fixtureState.metadata.Opportunity };
    const objectType = /FROM (Account|Lead|Opportunity)/.exec(decodeURIComponent(input.path))[1];
    const prefix = { Account: "001", Lead: "00Q", Opportunity: "006" }[objectType];
    return {
      ok: true,
      data: {
        records: Array.from({ length: 10 }, (_, index) => ({
          Id: `${prefix}${String(index).padStart(12, "0")}`,
          Name: `Record ${index}`,
        })),
        done: true,
      },
    };
  };
  const result = normalizeQueryResult(
    await fixtureState.connector.query("search_records", { query: "Record" }, { binding })
  );
  assert.equal(result.items.length, 20);
  assert.equal(result.items.filter((item) => item.kind === "record").length, 19);
  assert.deepEqual(result.items.at(-1), {
    kind: "search_scope",
    unavailableObjects: ["Contact"],
    unavailableObjectCount: 1,
  });
  assert.equal(result.truncated, true);
});

const taskGone = (fixtureState, failure) => {
  const request = fixtureState.api.request;
  fixtureState.api.request = async (input) =>
    input.method === "GET" && /\/sobjects\/Task\/00T/.test(input.path) ? failure : request(input);
};

test("a saved Task deleted or moved in Salesforce gets a new Task on the next export", async () => {
  for (const change of [
    (state) =>
      taskGone(state, { ok: false, errorCode: "NOT_FOUND", refused: true, outcome: "failed" }),
    (state) => {
      state.task.WhatId = "006000000000009";
    },
  ]) {
    const fixtureState = fixture();
    await commit(fixtureState, await prepare(fixtureState));
    change(fixtureState);
    const repeat = await prepare(fixtureState);
    assert.equal(repeat.status, "ready");
    assert.equal(repeat.payload.activityId, null);
    assert.deepEqual(repeat.preview.notes, [
      SOURCE_NOTE,
      { key: "connectors.salesforce.notes.replacesMissing" },
    ]);
    fixtureState.setWriteResult({ ok: true, data: { id: "00T000000000002", success: true } });
    assert.equal((await commit(fixtureState, repeat)).state, "sent");
    const created = writes(fixtureState)[1];
    assert.equal(created.method, "POST");
    assert.equal(created.body.WhatId, recordId);
    const saved = fixtureState.store.get({
      ownerAccountId: "owner",
      organizationId: "org",
      instanceUrl,
      ...args,
    });
    assert.equal(saved.activity_id, "00T000000000002");
  }
});

test("a Task deleted after its review asks for a fresh review instead of writing", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  const repeat = await prepare(fixtureState);
  taskGone(fixtureState, { ok: false, errorCode: "NOT_FOUND", refused: true, outcome: "failed" });
  assert.equal((await commit(fixtureState, repeat)).errorCode, "stale_record");
  assert.equal(writes(fixtureState).length, 1);
});

test("a Task deleted between the last check and the write asks for a fresh review", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  const repeat = await prepare(fixtureState);
  fixtureState.setWriteResult({
    ok: false,
    errorCode: "ENTITY_IS_DELETED",
    refused: true,
    outcome: "failed",
  });
  const result = await commit(fixtureState, repeat);
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "stale_record");
});

test("a refused re-export leaves field updates available for the Task already saved", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  fixtureState.setWriteResult({
    ok: false,
    errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION",
    refused: true,
    outcome: "failed",
  });
  const failure = await commit(fixtureState, await prepare(fixtureState));
  assert.equal(failure.errorCode, "validation_failed");
  fixtureState.setWriteResult(null);
  const input = { ...args, fields: [{ name: "Notes__c", value: "After" }] };
  const fields = await prepare(fixtureState, "update_fields", input);
  assert.equal(fields.status, "ready");
  assert.equal((await commit(fixtureState, fields, "update_fields")).state, "sent");
});

test("Salesforce error codes reach the card as codes it has copy for", async () => {
  for (const [salesforceCode, copyCode] of [
    ["ENTITY_IS_LOCKED", "record_locked"],
    ["ENTITY_IS_DELETED", "not_found"],
    ["NOT_FOUND", "not_found"],
    ["REQUIRED_FIELD_MISSING", "validation_failed"],
    ["INSUFFICIENT_ACCESS_OR_READONLY", "forbidden"],
    ["STRING_TOO_LONG", "too_long"],
    ["UNABLE_TO_LOCK_ROW", "rate_limited"],
    ["SOME_NEW_SALESFORCE_CODE", "refused"],
  ]) {
    const fixtureState = fixture();
    const preview = await prepare(fixtureState);
    fixtureState.setWriteResult({
      ok: false,
      errorCode: salesforceCode,
      refused: true,
      outcome: "failed",
    });
    const result = await commit(fixtureState, preview);
    assert.equal(result.state, "failed");
    assert.equal(result.errorCode, copyCode, salesforceCode);
    // The fallback wording is for codes with no copy of their own.
    if (copyCode !== "refused")
      assert.doesNotMatch(result.message, /^Salesforce refused this request/);
  }
});

const EDITED_NOTE = { key: "connectors.salesforce.notes.editedInSalesforce" };
test("a re-export says when the saved Task was edited in Salesforce since OpenWhispr wrote it", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  // Salesforce storing CRLF line breaks or trimming isn't an edit.
  fixtureState.task.Description = `  ${fixtureState.task.Description.replace(/\n/g, "\r\n")}  `;
  assert.deepEqual((await prepare(fixtureState)).preview.notes, [
    SOURCE_NOTE,
    { key: "connectors.salesforce.notes.updateExisting" },
  ]);
  fixtureState.task.Description = "Edited by a colleague in Salesforce";
  const repeat = await prepare(fixtureState);
  assert.deepEqual(repeat.preview.notes, [
    SOURCE_NOTE,
    { key: "connectors.salesforce.notes.updateExisting" },
    EDITED_NOTE,
  ]);
  assert.equal((await commit(fixtureState, repeat)).state, "sent");
  assert.deepEqual((await prepare(fixtureState)).preview.notes, [
    SOURCE_NOTE,
    { key: "connectors.salesforce.notes.updateExisting" },
  ]);
});

test("an unconfirmed re-export that landed isn't reported as an edit made in Salesforce", async () => {
  const fixtureState = fixture();
  await commit(fixtureState, await prepare(fixtureState));
  const repeat = await prepare(fixtureState, "export_conversation", {
    ...args,
    body: "Revised summary",
  });
  fixtureState.setWriteResult({ ok: false, outcome: "unknown", errorCode: "network" });
  assert.equal((await commit(fixtureState, repeat)).state, "unknown");
  // The write landed after all.
  fixtureState.task.Description = repeat.payload.body;
  fixtureState.setWriteResult(null);
  assert.deepEqual((await prepare(fixtureState)).preview.notes, [
    SOURCE_NOTE,
    { key: "connectors.salesforce.notes.updateExisting" },
    UNCERTAIN_NOTE,
  ]);
});

test("text a Salesforce Flow rewrites on save isn't reported as an edit at the next export", async () => {
  const fixtureState = fixture();
  const request = fixtureState.api.request;
  fixtureState.api.request = async (input) => {
    const result = await request(input);
    if (input.method && input.method !== "GET" && input.path.includes("/sobjects/Task"))
      fixtureState.task.Subject = `[Logged] ${fixtureState.task.Subject}`;
    return result;
  };
  assert.equal((await commit(fixtureState, await prepare(fixtureState))).state, "sent");
  // The stored text is read back after the result.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await prepare(fixtureState)).preview.notes, [
    SOURCE_NOTE,
    { key: "connectors.salesforce.notes.updateExisting" },
  ]);
});

test("the provenance line follows the app's language, with its untitled fallback", async (t) => {
  t.after(() => changeLanguage("en"));
  changeLanguage("de");
  const fixtureState = fixture();
  fixtureState.notes.get(1).title = "";
  const preview = await prepare(fixtureState);
  assert.match(preview.preview.body, /Quelle: OpenWhispr — Unbenannte Notiz$/);
});

test("a redirected data call flags the login for reconnect", async () => {
  const fixtureState = fixture();
  fixtureState.api.request = async () => ({
    ok: false,
    errorCode: "redirect_refused",
    outcome: "unknown",
  });
  const result = await fixtureState.connector.query(
    "get_record",
    { objectType: "Opportunity", recordId },
    { binding }
  );
  assert.equal(result.errorCode, "reconnect_needed");
  assert.equal(fixtureState.auth.reconnects, 1);
});

test("the card names the source note, and the provenance date is the note's local day", async () => {
  const fixtureState = fixture();
  // SQLite's UTC time without a zone: read as UTC, shown as the user's day.
  fixtureState.notes.get(1).created_at = "2026-11-01 23:30:00";
  const created = new Date("2026-11-01T23:30:00Z");
  const day = [created.getFullYear(), created.getMonth() + 1, created.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
  const preview = await prepare(fixtureState);
  assert.match(preview.preview.body, new RegExp(`Source: OpenWhispr — Conversation \\(${day}\\)$`));
  assert.deepEqual(preview.preview.notes, [SOURCE_NOTE]);
  fixtureState.notes.get(1).title = "";
  assert.deepEqual((await prepare(fixtureState)).preview.notes, [
    { key: "connectors.salesforce.notes.sourceNoteUntitled" },
  ]);
});
