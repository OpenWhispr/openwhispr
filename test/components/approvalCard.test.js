const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim, so assertions match keys.
async function renderCard(t, entry) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-approval-card-test-",
    mockModules: {
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
    },
  });
  const { ApprovalCard } = await vite.ssrLoadModule("/components/chat/ApprovalCard.tsx");
  return renderToStaticMarkup(createElement(ApprovalCard, { entry }));
}

const PREVIEW = {
  verbKey: "default",
  destinationLabel: "#eng",
  accountLabel: "chad",
  workspaceLabel: "Acme",
  body: "Quarterly numbers attached",
};

test("a pending card shows the exact content and Send, Edit, Cancel", async (t) => {
  const markup = await renderCard(t, {
    toolCallId: "call-1",
    actionId: "a1",
    connectorId: "slack",
    preview: PREVIEW,
    draft: { body: PREVIEW.body },
    state: "pending",
  });
  assert.match(markup, /Quarterly numbers attached/);
  assert.match(markup, /connectors\.approval\.headers\.default/);
  assert.match(markup, /connectors\.approval\.identityWithWorkspace/);
  assert.match(markup, /connectors\.approval\.send/);
  assert.match(markup, /connectors\.approval\.edit/);
  assert.match(markup, /connectors\.approval\.cancel/);
  assert.doesNotMatch(markup, /autofocus/i);
});

test("an unknown outcome tells the user to check, with no retry", async (t) => {
  const markup = await renderCard(t, {
    toolCallId: "call-2",
    actionId: "a2",
    connectorId: "slack",
    preview: PREVIEW,
    draft: { body: PREVIEW.body },
    state: "unknown",
  });
  assert.match(markup, /connectors\.approval\.unknown/);
  assert.doesNotMatch(markup, /connectors\.approval\.send/);
});

test("a sent card offers Open", async (t) => {
  const markup = await renderCard(t, {
    toolCallId: "call-3",
    actionId: "a3",
    connectorId: "slack",
    preview: PREVIEW,
    draft: { body: PREVIEW.body },
    state: "sent",
    url: "https://slack.test/p/1",
  });
  assert.match(markup, /connectors\.approval\.sent/);
  assert.match(markup, /connectors\.approval\.open/);
});
