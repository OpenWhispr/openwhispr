const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function click(element) {
  element.dispatchEvent({
    type: "click",
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
  });
}

function keyDown(element, key) {
  const event = {
    type: "keydown",
    key,
    bubbles: true,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  };
  element.dispatchEvent(event);
  return event;
}

// No i18next instance is initialized, so buttons render their keys.
function button(root, label) {
  const found = findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
  assert.ok(found, `button ${label} is rendered`);
  return found;
}

const textarea = (root) => findElement(root, (element) => element.tagName === "TEXTAREA");

const field = (root, labelKey) =>
  findElement(
    root,
    (element) => element.getAttribute?.("aria-label") === `connectors.approval.${labelKey}`
  );

async function mountPendingCard(t, options = {}) {
  const {
    preview = {
      verbKey: "default",
      destinationLabel: "#eng",
      accountLabel: "chad",
      body: "Original text",
    },
    connectorId = "slack",
    action = "send_message",
    args = { destination: "#eng", text: "Original text" },
  } = options;
  let root = null;
  let store;
  let key;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // A test that never Sends or Cancels leaves the entry pending, which
  // leaves the store's approval-TTL timer running and the process alive.
  // Registered before installBrowserGlobals's own cleanup, which removes
  // window (and with it window.electronAPI) below.
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
          preview,
        }),
        connectorCommit: async (actionId, edits) => {
          calls.commit.push({ actionId, edits });
          return { state: "sent", url: "https://slack.test/p/1" };
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
    cachePrefix: "openwhispr-approval-card-keyboard-test-",
    mockModules: {
      // toolOutcome.ts localizes tool-step text through the app's i18n
      // module, which would initialize react-i18next; keep keys as labels.
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
      connectorId,
      action,
      args
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  return { container, store, key, calls, toolResult: () => toolResult };
}

test("Esc in the text field ends editing, keeps the draft, and never reaches the panel", async (t) => {
  const { container, store, key, calls } = await mountPendingCard(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => store.updateApprovalDraft(key, { body: "Edited text" }));

  let event;
  await React.act(async () => {
    event = keyDown(textarea(container), "Escape");
  });

  // The panel listens on document, above React's root: a stopped event never gets there.
  assert.equal(event.cancelBubble, true);
  assert.ok(!textarea(container), "edit mode ended");
  assert.match(container.textContent, /Edited text/);
  assert.equal(store.useConnectorApprovalStore.getState().entries[key].state, "pending");
  assert.deepEqual(calls.cancel, []);
});

test("Esc in an issue title field ends editing and never reaches the panel", async (t) => {
  const { container, store, key, calls } = await mountPendingCard(t, {
    connectorId: "linear",
    action: "create_issue",
    args: {},
    preview: {
      verbKey: "issue",
      destinationLabel: "ENG",
      accountLabel: "chad",
      workspaceLabel: "Acme",
      body: "Safari users can't sign in.",
      fields: { title: "Fix login", body: "Safari users can't sign in." },
    },
  });
  await React.act(async () => click(button(container, "connectors.approval.edit")));

  let event;
  await React.act(async () => {
    event = keyDown(field(container, "issue.titleLabel"), "Escape");
  });

  assert.equal(event.cancelBubble, true);
  assert.ok(!field(container, "issue.titleLabel"), "edit mode ended");
  assert.match(container.textContent, /Fix login/);
  assert.equal(store.useConnectorApprovalStore.getState().entries[key].state, "pending");
  assert.deepEqual(calls.cancel, []);
});

test("Esc in a comment body field ends editing and never reaches the panel", async (t) => {
  const { container, store, key, calls } = await mountPendingCard(t, {
    connectorId: "github",
    action: "comment",
    args: {},
    preview: {
      verbKey: "comment",
      destinationLabel: "acme/app#12",
      accountLabel: "chad",
      body: "Fixed in 1.9.",
      fields: { body: "Fixed in 1.9." },
    },
  });
  await React.act(async () => click(button(container, "connectors.approval.edit")));

  let event;
  await React.act(async () => {
    event = keyDown(field(container, "comment.bodyLabel"), "Escape");
  });

  assert.equal(event.cancelBubble, true);
  assert.ok(!field(container, "comment.bodyLabel"), "edit mode ended");
  assert.match(container.textContent, /Fixed in 1\.9\./);
  assert.equal(store.useConnectorApprovalStore.getState().entries[key].state, "pending");
  assert.deepEqual(calls.cancel, []);
});

test("Send while editing sends the edit, leaves edit mode and keeps focus on the card", async (t) => {
  const { container, store, key, calls, toolResult } = await mountPendingCard(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => store.updateApprovalDraft(key, { body: "Edited text" }));

  await React.act(async () => click(button(container, "connectors.approval.send")));
  await toolResult();

  assert.deepEqual(calls.commit, [{ actionId: "a1", edits: { body: "Edited text" } }]);
  assert.ok(!textarea(container), "no editable field after Send");
  assert.equal(globalThis.document.activeElement?.getAttribute("data-approval-card"), key);
});
