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

test("a pending card after a failed policy check says why nothing was sent", async (t) => {
  const markup = await renderCard(t, {
    key: "m1::call-1",
    messageId: "m1",
    toolCallId: "call-1",
    actionId: "a1",
    connectorId: "slack",
    preview: PREVIEW,
    draft: { body: PREVIEW.body },
    state: "pending",
    notice: "policy_retry",
  });
  assert.match(
    markup,
    /aria-live="polite"[^>]*>(?:(?!<\/div>).)*connectors\.approval\.policyRetry/
  );
  assert.match(markup, /connectors\.approval\.send/);
});

test("every outcome is announced from one live region", async (t) => {
  for (const [state, textKey] of [
    ["committing", "sending"],
    ["sent", "sent"],
    ["failed", "failed"],
    ["unknown", "unknown"],
    ["cancelled", "cancelled"],
    ["not_sent", "notSent"],
  ]) {
    const markup = await renderCard(t, {
      key: "m1::call-1",
      messageId: "m1",
      toolCallId: "call-1",
      actionId: "a1",
      connectorId: "slack",
      preview: PREVIEW,
      draft: { body: PREVIEW.body },
      state,
      message: "reason",
    });
    assert.match(
      markup,
      new RegExp(
        `role="status" aria-live="polite"[^>]*>(?:(?!</div>).)*connectors\\.approval\\.${textKey}`
      ),
      state
    );
  }
});

const EMAIL_PREVIEW = {
  verbKey: "email",
  destinationLabel: "josh@acme.test +1",
  accountLabel: "you@example.test",
  body: "Numbers attached.",
  fields: {
    to: ["josh@acme.test", "dana@acme.test"],
    cc: ["sam@acme.test"],
    subject: "Q3 numbers",
    body: "Numbers attached.",
  },
};

const emailEntry = (fields = EMAIL_PREVIEW.fields, state = "pending") => ({
  key: "m1::call-1",
  messageId: "m1",
  toolCallId: "call-1",
  actionId: "a1",
  connectorId: "gmail",
  preview: EMAIL_PREVIEW,
  draft: { body: EMAIL_PREVIEW.body, fields },
  state,
});

test("an email card shows who it's from, To, Cc, Subject and Body, with Send enabled", async (t) => {
  const markup = await renderCard(t, emailEntry());
  assert.match(markup, /connectors\.approval\.email\.from/);
  assert.doesNotMatch(markup, /connectors\.approval\.identity/);
  assert.match(markup, /josh@acme\.test, dana@acme\.test/);
  assert.match(markup, /sam@acme\.test/);
  assert.match(markup, /Q3 numbers/);
  assert.match(markup, /Numbers attached\./);
  assert.match(markup, /aria-live="polite"[^>]*><\/p>/, "the reason region is empty");
  assert.doesNotMatch(markup, /<button[^>]*disabled/);
});

test("an email card with a bad or missing recipient, or past Gmail's limits, disables Send and says why", async (t) => {
  const many = Array.from({ length: 51 }, (_, index) => `p${index}@acme.test`);
  for (const [to, cc, problem, subject = "Q3 numbers"] of [
    [["Josh <josh@acme.test>"], [], "invalidAddress"],
    [["josh"], [], "invalidAddress"],
    [["josh@acme.test"], ["sam@acme"], "invalidAddress"],
    [[], ["sam@acme.test"], "missingTo"],
    [many, [], "tooManyRecipients"],
    [["josh@acme.test"], [], "subjectTooLong", "x".repeat(251)],
  ]) {
    const markup = await renderCard(t, emailEntry({ ...EMAIL_PREVIEW.fields, to, cc, subject }));
    const reasonId = markup.match(
      new RegExp(`<p id="([^"]+)"[^>]*>connectors\\.approval\\.email\\.${problem}<`)
    )?.[1];
    assert.ok(reasonId, `${JSON.stringify({ to, cc })}: the card says why`);
    // The live region names the kind of problem, never a half-typed address.
    const announced = problem === "invalidAddress" ? "invalidAddressAnnouncement" : problem;
    assert.match(
      markup,
      new RegExp(`aria-live="polite"[^>]*>connectors\\.approval\\.email\\.${announced}<`)
    );
    // Still focusable, and it says why it can't send.
    const send = markup.match(/<button[^>]*>connectors\.approval\.send</)?.[0] ?? "";
    assert.match(send, /aria-disabled="true"/);
    assert.match(send, new RegExp(`aria-describedby="${reasonId}"`));
    assert.doesNotMatch(send, /\sdisabled=""/);
  }
});

test("an email preview without fields falls back to the plain card", async (t) => {
  const { fields, ...plain } = EMAIL_PREVIEW;
  assert.ok(fields);
  const markup = await renderCard(t, {
    ...emailEntry(),
    preview: plain,
    draft: { body: plain.body },
  });
  assert.match(markup, /Numbers attached\./);
  assert.doesNotMatch(markup, /connectors\.approval\.email\./);
  assert.doesNotMatch(markup, /<button[^>]*disabled/);
});

// Shows each call's destination, so the header's recipients can be read.
async function renderCardWithDestinations(t, entry) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-approval-card-destination-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
      "react-i18next": `
        export function useTranslation() {
          return {
            t: (key, values) => (values?.destination ? key + "[" + values.destination + "]" : key),
          };
        }
      `,
    },
  });
  const { ApprovalCard } = await vite.ssrLoadModule("/components/chat/ApprovalCard.tsx");
  return renderToStaticMarkup(createElement(ApprovalCard, { entry }));
}

test("an email card names the recipients it shows, and after Send the ones main reports", async (t) => {
  const edited = { ...EMAIL_PREVIEW.fields, to: ["dana@acme.test"], cc: [] };
  const pending = await renderCardWithDestinations(t, emailEntry(edited));
  assert.match(pending, /connectors\.approval\.headers\.email\[dana@acme\.test\]/);
  assert.doesNotMatch(pending, /josh@acme\.test/);

  const sent = await renderCardWithDestinations(t, {
    ...emailEntry(edited, "sent"),
    destinationLabel: "dana@acme.test",
  });
  assert.match(sent, /connectors\.approval\.sent\[dana@acme\.test\]/);

  const emptied = await renderCardWithDestinations(
    t,
    emailEntry({ ...EMAIL_PREVIEW.fields, to: [], cc: [] })
  );
  assert.match(
    emptied,
    /connectors\.approval\.headers\.email\[josh@acme\.test \+1\]/,
    "with no recipients left, the header keeps the prepared label"
  );
});
