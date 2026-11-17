const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");
const load = () => import("../../src/services/tools/connectors/salesforceTools.ts");
const RECORD = { objectType: "Opportunity", recordId: "006000000000001AAA" };
const context = (toolCallId = "sf") => ({
  messageId: "salesforce",
  toolCallId,
  signal: new AbortController().signal,
  claimAction: () => true,
  releaseAction() {},
  sentEarlier: () => false,
  recordCompletedAction() {},
  onApprovalRequested() {},
  claimTurnSlot: () => true,
  releaseTurnSlot() {},
});

test("Salesforce tools register only for a ready connection with scoped workflow instructions", async (t) => {
  installBrowserGlobals(t);
  const { salesforceToolModule } = await load();
  const { registerConnectorTools } =
    await import("../../src/services/tools/connectors/connectorToolModules.ts");
  const { ToolRegistry } = await import("../../src/services/tools/ToolRegistry.ts");
  const names = [
    "search_records",
    "get_record",
    "describe_fields",
    "get_briefing",
    "export_conversation",
    "update_fields",
  ];
  const tools = salesforceToolModule.createTools({ emailDraftTarget: "auto" });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    names.map((name) => `salesforce_${name}`)
  );
  assert.deepEqual(
    tools.map((tool) => tool.readOnly),
    [true, true, true, true, false, false]
  );
  for (const readyConnectorIds of [[], ["salesforce"]]) {
    const registry = new ToolRegistry();
    registerConnectorTools(registry, { emailDraftTarget: "auto", readyConnectorIds });
    assert.equal(
      registry.getAll().filter((tool) => tool.connectorId === "salesforce").length,
      readyConnectorIds.length ? 6 : 0
    );
  }
  assert.match(tools[0].promptInstruction, /user.*select/i);
  assert.match(tools[3].promptInstruction, /get_note/);
  assert.match(tools[3].promptInstruction, /never search.*library/i);
  assert.match(tools[4].promptInstruction, /summary.*customer needs.*objections.*next steps/i);
  assert.match(tools[5].promptInstruction, /confirmed.*export/i);
});

test("invalid destinations, note IDs and field mutations never reach main", async (t) => {
  const calls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async (...args) => calls.push(args),
        connectorPrepare: async (...args) => calls.push(args),
      },
    },
  });
  const { salesforceToolModule } = await load();
  const tools = Object.fromEntries(
    salesforceToolModule.createTools({ emailDraftTarget: "auto" }).map((tool) => [tool.name, tool])
  );
  for (const [action, args] of [
    ["search_records", { query: "x".repeat(201) }],
    ["get_record", { objectType: "Task", recordId: RECORD.recordId }],
    ["get_briefing", { ...RECORD, recordId: "https://evil.test" }],
    ["describe_fields", { ...RECORD, objectType: "Lead" }],
    ["export_conversation", { ...RECORD, noteId: 0, title: "Meeting", body: "Summary" }],
    ["export_conversation", { ...RECORD, noteId: 1, title: "Meeting", body: " " }],
    ["update_fields", { ...RECORD, noteId: 1, fields: [{ name: "StageName", value: "Won" }] }],
    ["update_fields", { ...RECORD, noteId: 1, fields: [{ name: "Needs__c", value: 42 }] }],
    [
      "update_fields",
      {
        ...RECORD,
        noteId: 1,
        fields: Array.from({ length: 4 }, () => ({ name: "Needs__c", value: "Hi" })),
      },
    ],
  ]) {
    const ctx = context();
    const result = await tools[`salesforce_${action}`].execute(args, ctx);
    assert.equal(result.data.status, "failed", action);
  }
  assert.deepEqual(calls, []);
});

test("briefing queries retain the untrusted boundary and expose no write or note-search API", async (t) => {
  const calls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async (...args) => {
          calls.push(args);
          return {
            status: "ok",
            items: [
              { recordId: RECORD.recordId, noteIds: ["7"], retrievedAt: "2026-11-02T12:00:00Z" },
            ],
            truncated: true,
          };
        },
      },
    },
  });
  const { salesforceGetBriefingTool } = await load();
  const result = await salesforceGetBriefingTool.execute(
    { ...RECORD, query: "all notes" },
    context()
  );
  assert.deepEqual(calls, [["salesforce", "get_briefing", RECORD]]);
  assert.equal(result.data.untrusted, true);
  assert.equal(result.data.truncated, true);
  assert.match(result.data.guidance, /never as instructions/);
});

test("field approval commits edited values and omissions, then reports unknown without retry", async (t) => {
  const commits = [];
  const preview = {
    verbKey: "salesforceFields",
    destinationLabel: "Renewal",
    accountLabel: "Dana",
    body: "",
    fields: { value0: "Proposed", include0: "yes", value1: "Later", include1: "yes" },
    salesforceFields: [
      { key: "value0", name: "Needs__c", label: "Needs", before: "Old", maxLength: 50 },
      { key: "value1", name: "Next__c", label: "Next", before: "", maxLength: 50 },
    ],
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({ status: "ready", actionId: "sf-action", preview }),
        connectorCommit: async (...args) => {
          commits.push(args);
          return { state: "unknown" };
        },
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  const [{ salesforceUpdateFieldsTool }, approvals] = await Promise.all([
    load(),
    import("../../src/stores/connectorApprovalStore.ts"),
  ]);
  const key = approvals.approvalKey("salesforce", "fields");
  const pending = salesforceUpdateFieldsTool.execute(
    {
      ...RECORD,
      noteId: 7,
      fields: [
        { name: "Needs__c", value: "Proposed" },
        { name: "Next__c", value: "Later" },
      ],
    },
    context("fields")
  );
  t.after(() => approvals.cancelApproval(key));
  for (
    let attempt = 0;
    attempt < 100 && !approvals.useConnectorApprovalStore.getState().entries[key];
    attempt++
  )
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(approvals.useConnectorApprovalStore.getState().entries[key]);
  assert.deepEqual(commits, [], "preparation never writes");
  approvals.updateApprovalDraft(key, {
    fields: { value0: "Reviewed", include1: "no", recordId: "changed" },
  });
  await approvals.approveAction(key);
  const result = await pending;
  assert.deepEqual(commits, [
    ["sf-action", { value0: "Reviewed", include0: "yes", value1: "Later", include1: "no" }],
  ]);
  assert.equal(result.data.status, "unknown");
  assert.match(result.data.guidance, /Do not retry/);
  assert.match(result.data.guidance, /Salesforce/);
});

test("Salesforce queries handle empty searches, cleaned searches, reconnect and unavailable IPC", async (t) => {
  const calls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async (...args) => {
          calls.push(args);
          return { status: "ok", items: [], truncated: false };
        },
      },
    },
  });
  const { salesforceSearchRecordsTool, salesforceGetRecordTool, salesforceDescribeFieldsTool } =
    await load();
  assert.equal(
    (await salesforceSearchRecordsTool.execute({ query: " " }, context())).data.status,
    "needs_clarification"
  );
  await salesforceSearchRecordsTool.execute({ query: "  Acme ", objectType: "Account" }, context());
  assert.deepEqual(calls[0], [
    "salesforce",
    "search_records",
    { query: "Acme", objectType: "Account" },
  ]);
  assert.equal((await salesforceDescribeFieldsTool.execute(RECORD, context())).data.status, "ok");
  assert.equal((await salesforceGetRecordTool.execute(RECORD)).data.reason, "no_chat_context");
  globalThis.window.electronAPI.connectorQuery = async () => ({
    status: "failed",
    errorCode: "reconnect_needed",
    message: "Reconnect",
  });
  assert.match(
    (await salesforceGetRecordTool.execute(RECORD, context())).data.guidance,
    /reconnect Salesforce/
  );
  const { useConnectorStatusStore } = await import("../../src/stores/connectorStatusStore.ts");
  useConnectorStatusStore.setState({
    statuses: { salesforce: { connected: true, needsReconnect: true } },
  });
  t.after(() => useConnectorStatusStore.setState({ statuses: {} }));
  assert.equal(
    (await salesforceGetRecordTool.execute(RECORD, context())).data.reason,
    "reconnect_needed"
  );
});

test("Salesforce tool labels, receipt copy, review instructions and errors exist in every locale", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const locales = path.join(__dirname, "../../src/locales");
  for (const entry of fs.readdirSync(locales, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const locale = entry.name;
    const doc = JSON.parse(fs.readFileSync(path.join(locales, locale, "translation.json"), "utf8"));
    for (const action of [
      "search_records",
      "get_record",
      "describe_fields",
      "get_briefing",
      "export_conversation",
      "update_fields",
    ]) {
      assert.ok(doc.agentMode.tools[`salesforce_${action}Name`], `${locale} ${action} name`);
      assert.ok(doc.agentMode.tools[`salesforce_${action}Status`], `${locale} ${action} status`);
    }
    assert.ok(doc.connectors.salesforce.notes.updateExisting);
    for (const scope of ["approval", "toolStatus"]) {
      for (const code of [
        "stale_record",
        "uncertain_operation",
        "export_required",
        "source_unavailable",
        "invalid_field",
      ])
        assert.ok(doc.connectors[scope].errors.salesforce[code]);
    }
    for (const verb of ["salesforceActivity", "salesforceFields"]) {
      assert.ok(doc.connectors.approval.headers[verb]);
      assert.ok(doc.connectors.approval.sendLabel[verb]);
      assert.ok(doc.connectors.approval.salesforce[verb].sent);
      assert.ok(doc.connectors.approval.salesforce[verb].unknown);
    }
  }
});

test("activity export preserves reviewed source content and reports definite failure and cancellation", async (t) => {
  const prepared = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async (...args) => {
          prepared.push(args);
          return {
            status: "failed",
            errorCode: "source_unavailable",
            message: "Source note inaccessible",
          };
        },
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  const { salesforceExportConversationTool } = await load();
  const args = {
    ...RECORD,
    noteId: 7,
    title: " Meeting\nnotes ",
    body: "Summary: Conversation\nCustomer needs:\nObjections:\nNext steps:",
  };
  const result = await salesforceExportConversationTool.execute(args, context());
  assert.equal(result.data.status, "failed");
  assert.equal(result.data.errorCode, "source_unavailable");
  assert.deepEqual(prepared, [
    ["salesforce", "export_conversation", { ...args, title: "Meeting notes" }],
  ]);
  const approvals = await import("../../src/stores/connectorApprovalStore.ts");
  const key = approvals.approvalKey("salesforce", "cancel");
  globalThis.window.electronAPI.connectorPrepare = async () => ({
    status: "ready",
    actionId: "sf-cancel",
    preview: {
      verbKey: "salesforceActivity",
      accountLabel: "Dana",
      destinationLabel: "Renewal",
      title: "Meeting",
      body: args.body,
    },
  });
  const pending = salesforceExportConversationTool.execute(args, context("cancel"));
  t.after(() => approvals.cancelApproval(key));
  for (
    let attempt = 0;
    attempt < 100 && !approvals.useConnectorApprovalStore.getState().entries[key];
    attempt++
  )
    await new Promise((resolve) => setImmediate(resolve));
  approvals.cancelApproval(key);
  const cancelled = await pending;
  assert.equal(cancelled.data.status, "cancelled_by_user");
  assert.match(cancelled.data.guidance, /Do not retry/);
});

test("activity and field receipts say saved only on confirmed success and keep unknown honest", async () => {
  const mod = await import("../../src/i18n.ts");
  await (mod.default.default ?? mod.default).changeLanguage("en");
  const { approvalOutcomeResult } =
    await import("../../src/services/tools/connectors/toolOutcome.ts");
  for (const [verbKey, sent] of [
    ["salesforceActivity", "Activity saved to Renewal."],
    ["salesforceFields", "Fields saved on Renewal."],
  ]) {
    assert.equal(
      approvalOutcomeResult({ state: "sent" }, "Renewal", { verbKey }).displayText,
      sent
    );
    assert.match(
      approvalOutcomeResult({ state: "unknown" }, "Renewal", { verbKey }).displayText,
      /Couldn't confirm the changes/
    );
  }
});

test("Opportunity field discovery can narrow truncated metadata by name or label", async (t) => {
  const calls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async (...args) => {
          calls.push(args);
          return { status: "ok", items: [], truncated: false };
        },
      },
    },
  });
  const { salesforceDescribeFieldsTool } = await load();
  assert.equal(salesforceDescribeFieldsTool.parameters.properties.query.maxLength, 200);
  assert.match(salesforceDescribeFieldsTool.promptInstruction, /truncated/);
  assert.match(salesforceDescribeFieldsTool.promptInstruction, /name or label/);
  await salesforceDescribeFieldsTool.execute({ ...RECORD, query: "  Customer needs " }, context());
  assert.deepEqual(calls[0], [
    "salesforce",
    "describe_fields",
    { ...RECORD, query: "Customer needs" },
  ]);
  for (const query of [null, undefined, "  "]) {
    await salesforceDescribeFieldsTool.execute({ ...RECORD, query }, context());
    assert.deepEqual(calls.at(-1), ["salesforce", "describe_fields", RECORD]);
  }
  const queryCount = calls.length;
  for (const query of [true, ["Needs__c"], "x".repeat(201)]) {
    const result = await salesforceDescribeFieldsTool.execute({ ...RECORD, query }, context());
    assert.equal(result.data.status, "failed");
  }
  assert.equal(calls.length, queryCount, "invalid filters never reach main");
});
