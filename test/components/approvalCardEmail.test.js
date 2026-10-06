const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function dispatch(element, type, extra = {}) {
  element.dispatchEvent({
    type,
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
    ...extra,
  });
}

const click = (element) => dispatch(element, "click");

// React's change event reads the new value from the element, then an input event.
function type(element, value) {
  element.value = value;
  dispatch(element, "input");
}

// No i18next instance is initialized, so labels render as their keys.
function button(root, label) {
  const found = findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
  assert.ok(found, `button ${label} is rendered`);
  return found;
}

const field = (root, labelKey) =>
  findElement(
    root,
    (element) => element.getAttribute?.("aria-label") === `connectors.approval.email.${labelKey}`
  );

// The card's text naming what blocks Send (the fields and Send point at it);
// empty when nothing does.
const problemText = (root) =>
  findElement(root, (element) => element.tagName === "P" && element.getAttribute?.("id"))
    ?.textContent || null;

// The polite region a screen reader hears: the kind of problem only.
const announcement = (root) =>
  findElement(
    root,
    (element) =>
      element.getAttribute?.("aria-live") === "polite" &&
      element.getAttribute("class") === "sr-only"
  )?.textContent || null;

const PROPOSED = {
  to: ["josh@acme.test"],
  cc: ["sam@acme.test"],
  subject: "Q3 numbers",
  body: "Numbers attached.",
};

async function mountEmailCard(
  t,
  { commitReply = { state: "sent", url: "https://mail.google.test/#sent/1" } } = {}
) {
  let root = null;
  let store;
  let key;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // A card left pending keeps the approval timer, and the process, alive.
  t.after(() => {
    if (store?.useConnectorApprovalStore.getState().entries[key]?.state === "pending") {
      store.cancelApproval(key);
    }
  });
  const calls = { commit: [], cancel: [] };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: "a1",
          preview: {
            verbKey: "email",
            destinationLabel: "josh@acme.test",
            accountLabel: "you@example.test",
            body: PROPOSED.body,
            fields: PROPOSED,
          },
        }),
        connectorCommit: async (actionId, edits) => {
          calls.commit.push({ actionId, edits });
          return commitReply;
        },
        connectorCancel: async (actionId, reason) => {
          calls.cancel.push({ actionId, reason });
          return { cancelled: true };
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-approval-card-email-test-",
    mockModules: {
      "/i18n": `export default { t: (key) => key };`,
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
    },
  });
  store = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const { runApprovalAction } = await vite.ssrLoadModule(
    "/services/tools/connectors/runApprovalAction.ts"
  );
  const { ApprovalCard } = await vite.ssrLoadModule("/components/chat/ApprovalCard.tsx");
  store.useConnectorApprovalStore.setState({ entries: {} });
  key = store.approvalKey("m1", "call-1");

  function Harness() {
    const entry = store.useConnectorApprovalStore((state) => state.entries[key]);
    return entry ? React.createElement(ApprovalCard, { entry }) : null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  let toolResult;
  await React.act(async () => {
    toolResult = runApprovalAction(
      {
        messageId: "m1",
        toolCallId: "call-1",
        signal: new AbortController().signal,
        onApprovalRequested() {},
        onHoldDelivery() {},
        claimTurnSlot: () => true,
        releaseTurnSlot() {},
      },
      "gmail",
      "send",
      { to: PROPOSED.to, cc: PROPOSED.cc, subject: PROPOSED.subject, body: PROPOSED.body }
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  const draftFields = () => store.useConnectorApprovalStore.getState().entries[key].draft.fields;
  return { container, calls, draftFields, toolResult: () => toolResult };
}

// One more than main accepts, To and Cc together.
const FIFTY_ONE = Array.from({ length: 51 }, (_, index) => `p${index}@acme.test`).join(", ");

test("a bad address, an empty To or Gmail's limits block Send with the reason on the card", async (t) => {
  const { container, calls } = await mountEmailCard(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));

  for (const [labelKey, value, reason] of [
    ["toLabel", "josh@acme.test, dana", "invalidAddress"],
    ["toLabel", "", "missingTo"],
    // Pasted from a mail app: sent to the bare address.
    ["toLabel", "Josh <josh@acme.test>", null],
    ["toLabel", FIFTY_ONE, "tooManyRecipients"],
    ["toLabel", "josh@acme.test", null],
    ["ccLabel", "sam@acme", "invalidAddress"],
    ["ccLabel", "", null],
    ["subjectLabel", "x".repeat(251), "subjectTooLong"],
    ["subjectLabel", "x".repeat(250), null],
    ["bodyLabel", "x".repeat(512 * 1024 + 1), "bodyTooLong"],
    ["bodyLabel", "Numbers attached.", null],
  ]) {
    await React.act(async () => type(field(container, labelKey), value));
    const send = button(container, "connectors.approval.send");
    if (reason) {
      assert.equal(problemText(container), `connectors.approval.email.${reason}`, value);
      const input = field(container, labelKey);
      assert.equal(input.getAttribute("aria-invalid"), "true", `${value}: the field says so`);
      const describedBy = input.getAttribute("aria-describedby");
      assert.ok(
        findElement(container, (element) => element.getAttribute?.("id") === describedBy),
        `${value}: the field points at the reason`
      );
      assert.equal(
        announcement(container),
        `connectors.approval.email.${reason === "invalidAddress" ? "invalidAddressAnnouncement" : reason}`,
        value
      );
      assert.equal(send.getAttribute("aria-disabled"), "true", `${value}: Send is disabled`);
      assert.equal(send.getAttribute("aria-describedby"), describedBy, `${value}: and says why`);
      await React.act(async () => click(send));
    } else {
      assert.equal(problemText(container), null, value);
      assert.equal(announcement(container), null, value);
      assert.equal(send.getAttribute("aria-disabled"), null, `${value}: Send is enabled`);
    }
  }
  assert.deepEqual(calls.commit, [], "a blocked Send never commits");
});

test("Send commits exactly the edited fields the card shows, and reports them to the model", async (t) => {
  const { container, calls, draftFields, toolResult } = await mountEmailCard(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => type(field(container, "toLabel"), "josh@acme.test, dana@acme.test"));
  await React.act(async () => type(field(container, "ccLabel"), ""));
  await React.act(async () =>
    type(field(container, "subjectLabel"), "Q3 numbers\nBcc: evil@attacker.test")
  );
  await React.act(async () => type(field(container, "bodyLabel"), "Numbers attached.\n\nChad"));
  const shown = draftFields();

  await React.act(async () => click(button(container, "connectors.approval.send")));
  const result = await toolResult();

  const edited = {
    to: ["josh@acme.test", "dana@acme.test"],
    cc: [],
    subject: "Q3 numbers Bcc: evil@attacker.test",
    body: "Numbers attached.\n\nChad",
  };
  assert.deepEqual(shown, edited);
  assert.deepEqual(calls.commit, [{ actionId: "a1", edits: edited }]);
  assert.equal(result.data.status, "sent");
  assert.deepEqual(result.data.final, edited);
  assert.equal("finalText" in result.data, false);
  // Out of edit mode, the card still shows what was sent.
  assert.match(container.textContent, /josh@acme\.test, dana@acme\.test/);
  assert.match(container.textContent, /Q3 numbers Bcc: evil@attacker\.test/);
});

test("after a recipient edit, the model and the card name who it actually went to", async (t) => {
  const { container, toolResult } = await mountEmailCard(t, {
    commitReply: {
      state: "sent",
      url: "https://mail.google.test/#sent/1",
      destinationLabel: "dana@acme.test +1",
    },
  });
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => type(field(container, "toLabel"), "dana@acme.test"));

  await React.act(async () => click(button(container, "connectors.approval.send")));
  const result = await toolResult();

  assert.equal(result.data.destination, "dana@acme.test +1", "not the proposed josh@acme.test");
  assert.deepEqual(result.data.final.to, ["dana@acme.test"]);
});

test("a send whose result names no recipients keeps the prepared label", async (t) => {
  const { container, toolResult } = await mountEmailCard(t);
  await React.act(async () => click(button(container, "connectors.approval.send")));
  assert.equal((await toolResult()).data.destination, "josh@acme.test");
});

test("Esc in an email field ends editing and keeps the edit", async (t) => {
  const { container, draftFields } = await mountEmailCard(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => type(field(container, "subjectLabel"), "Q3 (final)"));

  const event = { cancelBubble: false };
  await React.act(async () =>
    dispatch(field(container, "subjectLabel"), "keydown", {
      key: "Escape",
      stopPropagation() {
        event.cancelBubble = true;
        this.cancelBubble = true;
      },
    })
  );

  assert.equal(event.cancelBubble, true, "the panel never sees the Esc");
  assert.equal(field(container, "subjectLabel"), null, "edit mode ended");
  assert.equal(draftFields().subject, "Q3 (final)");
});

test("Esc on the Edit button, outside the fields, ends editing instead of cancelling the card", async (t) => {
  const { container, draftFields, calls } = await mountEmailCard(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => type(field(container, "toLabel"), "dana@acme.test"));

  // Focus stays on the button after clicking Edit; the panel's Esc would
  // cancel the turn and withdraw the card with the edit.
  const event = { cancelBubble: false };
  await React.act(async () =>
    dispatch(button(container, "connectors.approval.doneEditing"), "keydown", {
      key: "Escape",
      stopPropagation() {
        event.cancelBubble = true;
        this.cancelBubble = true;
      },
    })
  );

  assert.equal(event.cancelBubble, true, "the panel never sees the Esc");
  assert.equal(field(container, "toLabel"), null, "edit mode ended");
  assert.deepEqual(draftFields().to, ["dana@acme.test"]);
  assert.deepEqual(calls.cancel, []);
});

test("a stripped display name shows the addresses the email will go to", async (t) => {
  const { container, draftFields } = await mountEmailCard(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  const sendsTo = () =>
    findElement(
      container,
      (element) =>
        element.tagName === "P" && element.textContent === "connectors.approval.email.sendsTo"
    );

  await React.act(async () => type(field(container, "toLabel"), "josh@acme.test"));
  assert.equal(sendsTo(), null, "plain addresses are shown as typed");

  // "josh" reads as the start of Dana's name (Outlook's "Last, First"), so
  // the card has to show that only Dana is left.
  await React.act(async () => type(field(container, "toLabel"), "josh, Dana Lee <dana@acme.test>"));
  assert.deepEqual(draftFields().to, ["dana@acme.test"]);
  assert.ok(sendsTo(), "the resolved addresses are shown");
});
