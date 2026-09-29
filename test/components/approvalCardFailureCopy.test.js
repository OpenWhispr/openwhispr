const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Kept out of approvalCard.test.js: this test initializes i18next, and
// i18next is one shared SSR module instance, so running it in the same file
// as approvalCard.test.js's raw-key tests would make their outcome depend on
// test order.
async function loadTranslatedCard(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-approval-card-errors-test-",
    mockModules: {
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
    },
  });
  const [{ default: i18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!i18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  const { ApprovalCard } = await vite.ssrLoadModule("/components/chat/ApprovalCard.tsx");
  return ApprovalCard;
}

const failed = (errorCode, message, destinationLabel = "#eng") => ({
  key: "m1::call-1",
  messageId: "m1",
  toolCallId: "call-1",
  actionId: "a1",
  connectorId: "slack",
  preview: {
    verbKey: "slackPost",
    destinationLabel,
    accountLabel: "chad",
    workspaceLabel: "Acme",
    body: "hi",
  },
  draft: { body: "hi" },
  state: "failed",
  errorCode,
  message,
});

// The connector's message is English written for the model; the card never
// shows it, whatever the code.
const MODEL_TEXT = "MODEL-ONLY TEXT";

test("a failed card explains every failure in translated copy, never the connector's message", async (t) => {
  const ApprovalCard = await loadTranslatedCard(t);
  const render = (errorCode, destinationLabel) =>
    renderToStaticMarkup(
      createElement(ApprovalCard, { entry: failed(errorCode, MODEL_TEXT, destinationLabel) })
    );

  for (const [errorCode, expected, destinationLabel] of [
    ["not_in_channel", /Couldn&#x27;t send: You&#x27;re not a member of #eng\./],
    ["invalid_auth", /Slack needs to be reconnected in Settings\./],
    ["token_revoked", /Slack needs to be reconnected in Settings\./],
    ["ratelimited", /Slack is busy\. Try again shortly\./],
    ["ENOTFOUND", /Slack couldn&#x27;t be reached\. Nothing was sent\./],
    ["network_error", /Slack couldn&#x27;t be reached\. Nothing was sent\./],
    ["timeout", /Slack couldn&#x27;t be reached\. Nothing was sent\./],
    ["credential_save_failed", /couldn&#x27;t be saved on this computer\. Nothing was sent\./],
    [
      "user_not_found",
      /The direct message to Gabe Smith couldn&#x27;t be opened\. Nothing was sent\./,
      "Gabe Smith",
    ],
    ["restricted_action_read_only_channel", /#eng is read-only or restricted for you\./],
    ["weird_code", /Couldn&#x27;t send: Something went wrong\. Nothing was sent\./],
    [undefined, /Something went wrong\. Nothing was sent\./],
  ]) {
    const markup = render(errorCode, destinationLabel);
    assert.match(markup, expected, String(errorCode));
    assert.doesNotMatch(markup, /MODEL-ONLY TEXT/, String(errorCode));
    assert.doesNotMatch(markup, /connectors\.approval/, String(errorCode));
  }
});
