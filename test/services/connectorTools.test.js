const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals, createRendererServer } = require("../lib/rendererTestHarness");

const loadEmail = () => import("../../src/services/tools/connectors/emailDraftTool.ts");
const loadContact = () => import("../../src/services/tools/connectors/findContactTool.ts");
const loadEligibility = () => import("../../src/utils/connectorEligibility.ts");
const loadRegistry = () => import("../../src/services/tools/index.ts");
// Tool-step text is localized; the UI language otherwise follows the machine's locale.
// (tsx loads its ESM default export through CommonJS interop.)
const useEnglish = async () => {
  const mod = await import("../../src/i18n.ts");
  await (mod.default.default ?? mod.default).changeLanguage("en");
};

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

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), [
    "email",
    "draft",
    { target: "gmail", to: ["gabe@example.com"], cc: [], subject: "Lunch", body: "Tomorrow at 1?" },
  ]);
  assert.equal(typeof calls[0][3], "string");
  assert.equal(result.data.status, "draft_opened");
  assert.equal(result.data.bodyCopied, false);
});

test("email_draft cancels its run in main when the turn is cancelled mid-call", async (t) => {
  const cancels = [];
  let finishRun;
  let runId;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: (_connector, _action, _args, id) => {
          runId = id;
          return new Promise((resolve) => {
            finishRun = resolve;
          });
        },
        connectorCancel: async (...args) => {
          cancels.push(args);
          return { cancelled: true };
        },
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  const controller = new AbortController();

  const pending = createEmailDraftTool("gmail").execute(
    { to: ["a@example.com"], subject: "s", body: "b" },
    countingContext(controller.signal)
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finishRun({ state: "not_sent", reason: "cancelled" });
  const result = await pending;

  assert.deepEqual(cancels, [[runId, "cancelled_by_user"]]);
  assert.equal(result.data.status, "not_sent");
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

function countingContext(signal = new AbortController().signal) {
  const context = {
    holds: 0,
    toolCallId: "call-1",
    signal,
    onApprovalRequested() {},
    onHoldDelivery() {
      context.holds += 1;
    },
    claimTurnSlot: () => true,
  };
  return context;
}

const loadScope = () => import("../../src/components/chat/toolExecutionScope.ts");

test("email_draft opens at most three drafts per turn", async (t) => {
  let opened = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: async () => {
          opened += 1;
          return { state: "sent", destinationLabel: "a@example.com", bodyCopied: false };
        },
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  const { createToolExecutionScope } = await loadScope();
  const scope = createToolExecutionScope();
  const tool = createEmailDraftTool("gmail");
  const draft = (id) =>
    tool.execute({ to: ["a@example.com"], subject: "s", body: "b" }, scope.createContext(id));

  // The AI SDK runs a step's tool calls in parallel.
  const results = await Promise.all(["1", "2", "3", "4"].map(draft));

  assert.equal(opened, 3);
  assert.deepEqual(
    results.map((result) => result.data.status),
    ["draft_opened", "draft_opened", "draft_opened", "not_sent"]
  );
  assert.equal(results[3].data.reason, "draft_limit");
  // A new turn starts over.
  const next = createToolExecutionScope().createContext("5");
  assert.equal((await tool.execute({ to: ["a@example.com"], subject: "s", body: "b" }, next)).data.status, "draft_opened");
});

test("only one draft per turn may put its text on the clipboard", async (t) => {
  const opened = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: async (_connector, _action, args) => {
          opened.push(args.to[0]);
          return { state: "sent", destinationLabel: args.to[0], bodyCopied: args.body.length > 1000 };
        },
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  const { createToolExecutionScope } = await loadScope();
  const scope = createToolExecutionScope();
  // mailto keeps a 2,000-character link on every platform.
  const tool = createEmailDraftTool("mailto");
  const longBody = "word ".repeat(600);

  const [first, second] = await Promise.all([
    tool.execute({ to: ["josh@example.com"], subject: "Recap", body: longBody }, scope.createContext("1")),
    tool.execute({ to: ["dana@example.com"], subject: "Recap", body: longBody }, scope.createContext("2")),
  ]);
  const short = await tool.execute(
    { to: ["kim@example.com"], subject: "Hi", body: "Short one." },
    scope.createContext("3")
  );

  assert.equal(first.data.status, "draft_opened");
  assert.equal(second.data.status, "not_sent");
  assert.equal(second.data.reason, "clipboard_in_use");
  assert.match(second.data.guidance, /paste/);
  // A draft that fits its link needs no clipboard, so it still opens.
  assert.equal(short.data.status, "draft_opened");
  assert.deepEqual(opened, ["josh@example.com", "kim@example.com"]);
});

test("email_draft tells the model when content went to the clipboard", async (t) => {
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
  await useEnglish();

  const result = await createEmailDraftTool("mailto").execute(
    { to: ["a@example.com"], subject: "s", body: "b" },
    countingContext()
  );

  assert.equal(result.data.bodyCopied, true);
  assert.equal(result.data.subjectCopied, true);
  assert.match(result.data.guidance, /clipboard/);
  assert.match(result.data.guidance, /subject/i);
  // The tool step tells the user too, in case the model doesn't.
  assert.equal(
    result.displayText,
    "Opened a draft to a@example.com. The subject and body are on your clipboard."
  );
});

test("email_draft keeps its turn out of the user's document, whatever the outcome", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: async () => ({ state: "sent", destinationLabel: "a@example.com", bodyCopied: false }),
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  const tool = createEmailDraftTool("gmail");

  // The compose window takes focus, so pasting the confirmation at the caret
  // would land in the draft or overwrite the clipboard.
  const opened = countingContext();
  await tool.execute({ to: ["a@example.com"], subject: "s", body: "b" }, opened);
  // A question back to the user must not be pasted into their document.
  const clarifying = countingContext();
  await tool.execute({ to: ["Gabe"], subject: "s", body: "b" }, clarifying);

  assert.equal(opened.holds, 1);
  assert.equal(clarifying.holds, 1);
});

test("email_draft opens nothing once its turn is cancelled", async (t) => {
  let ran = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRunDirect: async () => {
          ran += 1;
          return { state: "sent", destinationLabel: "a@example.com" };
        },
      },
    },
  });
  const { createEmailDraftTool } = await loadEmail();
  const controller = new AbortController();
  controller.abort();

  const result = await createEmailDraftTool("gmail").execute(
    { to: ["a@example.com"], subject: "s", body: "b" },
    countingContext(controller.signal)
  );

  assert.equal(ran, 0);
  assert.equal(result.data.status, "not_sent");
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
  await useEnglish();

  const none = await findContactTool.execute({ name: "Zed" });
  const several = await findContactTool.execute({ name: "Gab" });

  assert.match(none.data.guidance, /ask the user/i);
  assert.equal(several.data.contacts.length, 2);
  assert.match(several.data.guidance, /which one/i);
  assert.equal(several.displayText, "Contacts found: 2");
});

test("find_contact reports an org policy refusal instead of an empty result", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorFindContacts: async () => ({ contacts: [], unavailableReason: "policy_blocked" }),
      },
    },
  });
  const { findContactTool } = await loadContact();
  const result = await findContactTool.execute({ name: "Gabe" });
  assert.equal(result.data.status, "unavailable");
  assert.equal(result.data.reason, "policy_blocked");
});

test("find_contact keeps its turn out of the user's document, whatever it finds", async (t) => {
  const one = [{ name: "Gabe Torres", email: "gabe@example.com", lastMet: null }];
  const two = [...one, { name: "Gabriel Stone", email: "gabriel@acme.test", lastMet: null }];
  const responses = [{ contacts: [] }, { contacts: two }, { contacts: one }];
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorFindContacts: async () => responses.shift() } },
  });
  const { findContactTool } = await loadContact();

  const holdsFor = async (name) => {
    const context = countingContext();
    await findContactTool.execute({ name }, context);
    return context.holds;
  };

  assert.equal(await holdsFor("Zed"), 1);
  assert.equal(await holdsFor("Gab"), 1);
  // One match is usually followed by a question ("What should it say?"),
  // which must not be pasted at the caret either.
  assert.equal(await holdsFor("Gabe Torres"), 1);
});

test("connector plan eligibility uses usage data, then the persisted isSubscribed flag", async () => {
  const { hasConnectorPlan } = await loadEligibility();
  const success = (isSubscribed, isTrial) => ({
    status: "success",
    accountId: "acct",
    data: { isSubscribed, isTrial },
    isRefreshing: false,
  });
  assert.equal(hasConnectorPlan(success(false, true), false), true);
  assert.equal(hasConnectorPlan(success(false, false), true), false);
  // A fresh voice-window session never loads usage, so the isSubscribed flag
  // the control panel persisted (the API sets it for trials too) decides.
  assert.equal(hasConnectorPlan({ status: "idle", accountId: null }, true), true);
  assert.equal(hasConnectorPlan({ status: "idle", accountId: null }, false), false);
  assert.equal(hasConnectorPlan({ status: "loading", accountId: "acct" }, false), false);
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
