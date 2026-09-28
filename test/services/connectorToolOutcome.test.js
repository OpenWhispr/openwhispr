const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const loadOutcome = () => import("../../src/services/tools/connectors/toolOutcome.ts");
// tsx loads the ESM default export of src/i18n.ts through CommonJS interop.
const loadI18n = async () => {
  const mod = await import("../../src/i18n.ts");
  return mod.default.default ?? mod.default;
};
const loadRun = () => import("../../src/services/tools/connectors/runApprovalAction.ts");
const loadStore = () => import("../../src/stores/connectorApprovalStore.ts");

test("every approval outcome tells the model what happened and whether to retry", async () => {
  const { approvalOutcomeResult } = await loadOutcome();

  assert.deepEqual(
    approvalOutcomeResult({ state: "sent", url: "u", finalText: "edited" }, "#eng").data,
    {
      status: "sent",
      url: "u",
      destination: "#eng",
      finalText: "edited",
    }
  );
  assert.equal(
    approvalOutcomeResult({ state: "cancelled" }, "#eng").data.status,
    "cancelled_by_user"
  );
  assert.match(approvalOutcomeResult({ state: "cancelled" }, "#eng").data.guidance, /Do not retry/);
  assert.deepEqual(
    approvalOutcomeResult({ state: "not_sent", reason: "expired" }, "#eng").data.reason,
    "expired"
  );
  assert.equal(
    approvalOutcomeResult(
      { state: "failed", errorCode: "not_in_channel", message: "Not a member" },
      "#eng"
    ).data.error,
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
    window: {
      electronAPI: {
        connectorPrepare: async () => {
          prepared += 1;
        },
      },
    },
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
    { messageId: "m1", toolCallId: "call-1", signal: controller.signal, onApprovalRequested() {} },
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
          preview: {
            verbKey: "default",
            destinationLabel: "#eng",
            accountLabel: "chad",
            body: "hi",
          },
        }),
        connectorCommit: async () => ({ state: "sent", url: "https://slack.test/p/9" }),
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  const { runApprovalAction } = await loadRun();
  const { approvalKey, approveAction, useConnectorApprovalStore } = await loadStore();
  useConnectorApprovalStore.setState({ entries: {} });
  const controller = new AbortController();

  const pending = runApprovalAction(
    { messageId: "m1", toolCallId: "call-2", signal: controller.signal, onApprovalRequested() {} },
    "slack",
    "send_message",
    { destination: "#eng", text: "hi" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  await approveAction(approvalKey("m1", "call-2"));

  const result = await pending;
  assert.equal(result.data.status, "sent");
  assert.equal(result.data.url, "https://slack.test/p/9");
});

test("tool steps show the user plain, localized outcomes instead of codes", async () => {
  const {
    unavailableResult,
    failedResult,
    needsClarificationResult,
    notSentResult,
    approvalOutcomeResult,
  } = await loadOutcome();
  // The UI language otherwise follows the machine's locale.
  await (await loadI18n()).changeLanguage("en");

  assert.equal(
    unavailableResult("policy_blocked").displayText,
    "Connectors are turned off by your organization."
  );
  assert.equal(
    unavailableResult("policy_unavailable").displayText,
    "Connectors aren't available right now."
  );
  assert.equal(
    failedResult("open_failed", "Couldn't open your email app.").displayText,
    "Couldn't open your email app."
  );
  // A code with no toolStatus.errors translation falls back to the generic text.
  assert.equal(failedResult("mystery_error", "raw provider text").displayText, "That didn't work.");
  // The tool step maps codes exactly as the card does.
  assert.equal(failedResult("token_revoked", "raw").displayText, "Slack needs to be reconnected.");
  assert.equal(failedResult("ratelimited", "raw").displayText, "Slack is busy.");
  assert.equal(
    failedResult("ENOTFOUND", "raw").displayText,
    "Couldn't reach Slack. Nothing was sent."
  );
  assert.equal(
    failedResult("user_not_found", "raw").displayText,
    "Couldn't open the direct message. Nothing was sent."
  );
  assert.equal(
    failedResult("restricted_action", "raw").displayText,
    "That channel is read-only or restricted."
  );
  assert.equal(
    failedResult("credential_save_failed", "raw").displayText,
    "Couldn't save the Slack login on this computer. Nothing was sent."
  );
  // The model still gets the connector's own code and message.
  assert.deepEqual(failedResult("token_revoked", "raw").data, {
    status: "failed",
    errorCode: "token_revoked",
    error: "raw",
  });
  assert.equal(
    needsClarificationResult("Call find_contact first.").displayText,
    "Needs more details."
  );
  assert.equal(notSentResult("cancelled").displayText, "Not sent.");
  assert.equal(
    approvalOutcomeResult({ state: "sent", url: "u" }, "#eng").displayText,
    "Sent to #eng."
  );
  // The model still gets the precise codes and guidance.
  assert.equal(unavailableResult("policy_blocked").data.reason, "policy_blocked");
  assert.equal(
    needsClarificationResult("Call find_contact first.").data.message,
    "Call find_contact first."
  );
});
