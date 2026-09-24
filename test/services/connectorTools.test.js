const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals, createRendererServer } = require("../lib/rendererTestHarness");

const loadEmail = () => import("../../src/services/tools/connectors/emailDraftTool.ts");
const loadContact = () => import("../../src/services/tools/connectors/findContactTool.ts");
const loadEligibility = () => import("../../src/utils/connectorEligibility.ts");
const loadRegistry = () => import("../../src/services/tools/index.ts");

test("email_draft opens a draft through the main process", async (t) => {
  const calls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: async (...args) => {
          calls.push(args);
          return { state: "sent", destinationLabel: "gabe@example.com", bodyCopied: false };
        },
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  const result = await createEmailDraftTool("gmail").execute({
    to: ["gabe@example.com"],
    subject: "Lunch",
    body: "Tomorrow at 1?",
  });

  assert.deepEqual(calls, [
    ["email", "draft", { target: "gmail", to: ["gabe@example.com"], cc: [], subject: "Lunch", body: "Tomorrow at 1?" }],
  ]);
  assert.equal(result.data.status, "draft_opened");
  assert.equal(result.data.bodyCopied, false);
});

test("email_draft asks for addresses instead of guessing", async (t) => {
  let ran = 0;
  installBrowserGlobals(t, { window: { electronAPI: { connectorRunDirect: async () => { ran += 1; } } } });
  const { createEmailDraftTool } = await loadEmail();

  const result = await createEmailDraftTool("gmail").execute({ to: ["Gabe"], subject: "x", body: "y" });

  assert.equal(result.data.status, "needs_clarification");
  assert.deepEqual(result.data.candidates, ["Gabe"]);
  assert.match(result.data.message, /find_contact/);
  assert.equal(ran, 0);
});

test("email_draft reserves the clipboard and tells the model when content went there", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: async () => ({
          state: "sent",
          destinationLabel: "a@example.com",
          bodyCopied: true,
          subjectCopied: true,
        }),
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  let reserved = 0;
  const context = {
    toolCallId: "call-1",
    signal: new AbortController().signal,
    onApprovalRequested() {},
    onClipboardReserved() {
      reserved += 1;
    },
  };

  const result = await createEmailDraftTool("mailto").execute(
    { to: ["a@example.com"], subject: "s", body: "b" },
    context
  );

  assert.equal(reserved, 1);
  assert.equal(result.data.bodyCopied, true);
  assert.equal(result.data.subjectCopied, true);
  assert.match(result.data.guidance, /clipboard/);
  assert.match(result.data.guidance, /subject/i);
});

test("email_draft leaves the clipboard alone when everything fit in the link", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: async () => ({ state: "sent", destinationLabel: "a@example.com", bodyCopied: false }),
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  let reserved = 0;
  await createEmailDraftTool("gmail").execute(
    { to: ["a@example.com"], subject: "s", body: "b" },
    {
      toolCallId: "call-2",
      signal: new AbortController().signal,
      onApprovalRequested() {},
      onClipboardReserved() {
        reserved += 1;
      },
    }
  );
  assert.equal(reserved, 0);
});

test("email_draft reports a blocked policy without retrying", async (t) => {
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorRunDirect: async () => ({ state: "unavailable", reason: "policy_blocked" }) } },
  });
  const { createEmailDraftTool } = await loadEmail();
  const result = await createEmailDraftTool("gmail").execute({ to: ["a@example.com"], subject: "s", body: "b" });
  assert.equal(result.data.status, "unavailable");
  assert.equal(result.data.reason, "policy_blocked");
});

test("find_contact returns matches and guidance for zero or several", async (t) => {
  const responses = [
    { contacts: [] },
    {
      contacts: [
        { name: "Gabe Torres", email: "gabe@example.com", lastMet: null },
        { name: "Gabriel Stone", email: "gabriel@acme.test", lastMet: null },
      ],
    },
  ];
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorFindContacts: async () => responses.shift() } },
  });
  const { findContactTool } = await loadContact();

  const none = await findContactTool.execute({ name: "Zed" });
  const several = await findContactTool.execute({ name: "Gab" });

  assert.match(none.data.guidance, /ask the user/i);
  assert.equal(several.data.contacts.length, 2);
  assert.match(several.data.guidance, /which one/i);
});

test("connector plan eligibility uses usage data, then the shared paid-access flag", async () => {
  const { hasConnectorPlan } = await loadEligibility();
  const success = (isSubscribed, isTrial) => ({
    status: "success",
    accountId: "acct",
    data: { isSubscribed, isTrial },
    isRefreshing: false,
  });
  assert.equal(hasConnectorPlan(success(false, true), false), true);
  assert.equal(hasConnectorPlan(success(false, false), true), false);
  // A fresh voice-window session: it never loads usage, so the flag the
  // control panel wrote for a trial user is what grants access.
  assert.equal(hasConnectorPlan({ status: "idle", accountId: null }, true), true);
  assert.equal(hasConnectorPlan({ status: "idle", accountId: null }, false), false);
  assert.equal(hasConnectorPlan({ status: "loading", accountId: "acct" }, false), false);
});

test("connector paid-access flag falls back to either persisted flag before usage loads", async (t) => {
  installBrowserGlobals(t, { initialStorage: { isSubscribed: "true" } });
  const { readConnectorPaidAccessFlag } = await loadEligibility();
  assert.equal(readConnectorPaidAccessFlag(), true);
});

test("connector paid-access flag reads hasPaidAccess when isSubscribed is unset", async (t) => {
  installBrowserGlobals(t, { initialStorage: { hasPaidAccess: "true" } });
  const { readConnectorPaidAccessFlag } = await loadEligibility();
  assert.equal(readConnectorPaidAccessFlag(), true);
});

test("connector paid-access flag is false when neither persisted flag is set", async (t) => {
  installBrowserGlobals(t, {});
  const { readConnectorPaidAccessFlag } = await loadEligibility();
  assert.equal(readConnectorPaidAccessFlag(), false);
});

test("connector tools register only when connectors are available", async () => {
  const { createToolRegistry } = await loadRegistry();
  const base = { isSignedIn: true, calendarConnected: false, cloudBackupEnabled: false, webSearchEnabled: false };

  const without = createToolRegistry(base).getAll().map((tool) => tool.name);
  const withConnectors = createToolRegistry({ ...base, connectors: { emailDraftTarget: "gmail" } })
    .getAll()
    .map((tool) => tool.name);

  assert.equal(without.includes("email_draft"), false);
  assert.ok(withConnectors.includes("email_draft"));
  assert.ok(withConnectors.includes("find_contact"));
});

test("the system prompt adds connector rules only when a connector tool is present", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-connector-prompts-test-" });
  const { getAgentSystemPrompt } = await vite.ssrLoadModule("/config/prompts.ts");

  const withEmail = getAgentSystemPrompt(["find_contact", "email_draft"]);
  const withoutEmail = getAgentSystemPrompt(["search_notes"]);

  assert.match(withEmail, /Use find_contact/);
  assert.match(withEmail, /Use email_draft/);
  assert.match(withEmail, /needs_clarification/);
  assert.doesNotMatch(withoutEmail, /needs_clarification/);
});
