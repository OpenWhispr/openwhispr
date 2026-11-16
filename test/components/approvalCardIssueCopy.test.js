const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Kept apart from approvalCardIssue.test.js: this file initializes i18next,
// one shared SSR module instance, which would change the raw-key tests there.
async function loadTranslatedCard(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-approval-card-issue-copy-test-",
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
  return (entry) => renderToStaticMarkup(createElement(ApprovalCard, { entry }));
}

const BASE = { key: "m1::call-1", messageId: "m1", toolCallId: "call-1", actionId: "a1" };
const ISSUE_FIELDS = { title: "Fix login", body: "Safari users can't sign in." };

const issueCard = (patch = {}) => ({
  ...BASE,
  connectorId: "linear",
  preview: {
    verbKey: "issue",
    destinationLabel: "ENG",
    accountLabel: "chad",
    workspaceLabel: "Acme",
    body: ISSUE_FIELDS.body,
    fields: ISSUE_FIELDS,
    notes: [
      { key: "connectors.approval.issue.notes.labels", values: { labels: "bug, auth" } },
      { key: "connectors.approval.issue.notes.priority", values: { priority: "High" } },
      {
        key: "connectors.approval.issue.notes.droppedLabels",
        values: { destination: "ENG", labels: "wontfix" },
      },
    ],
  },
  draft: { body: ISSUE_FIELDS.body, fields: ISSUE_FIELDS },
  state: "pending",
  ...patch,
});

const commentCard = (patch = {}) => ({
  ...BASE,
  connectorId: "github",
  preview: {
    verbKey: "comment",
    destinationLabel: "acme/app#12",
    accountLabel: "chad",
    body: "Fixed in 1.9.",
    fields: { body: "Fixed in 1.9." },
    notes: [
      { key: "connectors.approval.comment.notes.targetTitle", values: { title: "Fix login" } },
    ],
  },
  draft: { body: "Fixed in 1.9.", fields: { body: "Fixed in 1.9." } },
  state: "pending",
  ...patch,
});

test("a pending issue card names the team, its button, its fields and its notes", async (t) => {
  const render = await loadTranslatedCard(t);
  const markup = render(issueCard());

  assert.match(markup, /Create issue in ENG/);
  assert.match(markup, /As chad in Acme/);
  assert.match(markup, />Create issue<\/button>/);
  assert.match(markup, /Fix login/);
  assert.match(markup, /Safari users can&#x27;t sign in\./);
  assert.match(markup, /Labels: bug, auth/);
  assert.match(markup, /Priority: High/);
  assert.match(markup, /Not added \(not in ENG\): wontfix/);
  assert.doesNotMatch(markup, /connectors\.approval/);
});

// Spec §5.1 lists `labels` as the connector's only value for
// `droppedLabels`; §5.3's copy also needs `{{destination}}`. The card must
// supply it itself rather than relying on the connector to pass it along.
test("a droppedLabels note with only labels still shows the card's destination", async (t) => {
  const render = await loadTranslatedCard(t);
  const markup = render(
    issueCard({
      preview: {
        ...issueCard().preview,
        notes: [
          { key: "connectors.approval.issue.notes.droppedLabels", values: { labels: "wontfix" } },
        ],
      },
    })
  );

  assert.match(markup, /Not added \(not in ENG\): wontfix/);
  assert.doesNotMatch(markup, /connectors\.approval/);
});

test("a pending comment card names what it comments on", async (t) => {
  const render = await loadTranslatedCard(t);
  const markup = render(commentCard());

  assert.match(markup, /Comment on acme\/app#12/);
  assert.match(markup, />Comment<\/button>/);
  assert.match(markup, /On &quot;Fix login&quot;/);
  assert.doesNotMatch(markup, /connectors\.approval/);
});

test("created, commented and unconfirmed cards say so in their own words", async (t) => {
  const render = await loadTranslatedCard(t);

  assert.match(
    render(
      issueCard({ state: "sent", url: "https://linear.test/ENG-124", resultLabel: "ENG-124" })
    ),
    /Created ENG-124\./
  );
  assert.match(render(issueCard({ state: "sent" })), /Created an issue in ENG\./);
  assert.match(render(commentCard({ state: "sent" })), /Commented on acme\/app#12\./);
  assert.match(
    render(issueCard({ state: "unknown" })),
    /Couldn&#x27;t confirm the issue was created\. Check ENG before trying again\./
  );
  assert.match(
    render(commentCard({ state: "unknown" })),
    /Couldn&#x27;t confirm the comment was posted\. Check acme\/app#12 before trying again\./
  );
});

test("every other card keeps Send and its own lines", async (t) => {
  const render = await loadTranslatedCard(t);
  const slack = (patch) => ({
    ...BASE,
    connectorId: "slack",
    preview: { verbKey: "slackPost", destinationLabel: "#eng", accountLabel: "chad", body: "hi" },
    draft: { body: "hi" },
    state: "pending",
    ...patch,
  });

  assert.match(render(slack()), />Send<\/button>/);
  assert.match(render(slack({ state: "sent" })), /Sent to #eng\./);
});
