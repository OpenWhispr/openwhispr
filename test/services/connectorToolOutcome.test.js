const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const loadOutcome = () => import("../../src/services/tools/connectors/toolOutcome.ts");
const loadRun = () => import("../../src/services/tools/connectors/runApprovalAction.ts");
const loadStore = () => import("../../src/stores/connectorApprovalStore.ts");

test("every approval outcome tells the model what happened and whether to retry", async () => {
  const { approvalOutcomeResult } = await loadOutcome();

  assert.deepEqual(approvalOutcomeResult({ state: "sent", url: "u", finalText: "edited" }, "#eng").data, {
    status: "sent",
    url: "u",
    destination: "#eng",
    finalText: "edited",
  });
  assert.equal(approvalOutcomeResult({ state: "cancelled" }, "#eng").data.status, "cancelled_by_user");
  assert.match(approvalOutcomeResult({ state: "cancelled" }, "#eng").data.guidance, /Do not retry/);
  assert.deepEqual(approvalOutcomeResult({ state: "not_sent", reason: "expired" }, "#eng").data.reason, "expired");
  assert.equal(
    approvalOutcomeResult({ state: "failed", errorCode: "not_in_channel", message: "Not a member" }, "#eng").data.error,
    "Not a member"
  );
  const unknown = approvalOutcomeResult({ state: "unknown" }, "#eng").data;
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.guidance, /may or may not have been sent/);
  assert.match(unknown.guidance, /#eng/);
});

test("runApprovalAction without a chat context refuses to prepare", async (t) => {
  let prepared = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorPrepare: async () => { prepared += 1; } } },
  });
  const { runApprovalAction } = await loadRun();
  const result = await runApprovalAction(undefined, "slack", "send_message", {});
  assert.equal(result.data.status, "unavailable");
  assert.equal(prepared, 0);
});

test("runApprovalAction passes clarifications straight back to the model", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({
          status: "needs_clarification",
          message: "Which channel?",
          candidates: ["#eng-web", "#eng-ios"],
        }),
      },
    },
  });
  const { runApprovalAction } = await loadRun();
  const controller = new AbortController();
  const result = await runApprovalAction(
    { toolCallId: "call-1", signal: controller.signal, onApprovalRequested() {} },
    "slack",
    "send_message",
    { destination: "#eng" }
  );
  assert.deepEqual(result.data, {
    status: "needs_clarification",
    message: "Which channel?",
    candidates: ["#eng-web", "#eng-ios"],
  });
});

test("runApprovalAction waits for the card and returns the send", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: "a1",
          preview: { verbKey: "default", destinationLabel: "#eng", accountLabel: "chad", body: "hi" },
        }),
        connectorCommit: async () => ({ state: "sent", url: "https://slack.test/p/9" }),
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  const { runApprovalAction } = await loadRun();
  const { approveAction, useConnectorApprovalStore } = await loadStore();
  useConnectorApprovalStore.setState({ entries: {} });
  const controller = new AbortController();

  const pending = runApprovalAction(
    { toolCallId: "call-2", signal: controller.signal, onApprovalRequested() {} },
    "slack",
    "send_message",
    { destination: "#eng", text: "hi" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  await approveAction("call-2");

  const result = await pending;
  assert.equal(result.data.status, "sent");
  assert.equal(result.data.url, "https://slack.test/p/9");
});
