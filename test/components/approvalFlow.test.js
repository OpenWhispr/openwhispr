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

// No i18next instance is initialized, so buttons render their keys.
function button(root, label) {
  const found = findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
  assert.ok(found, `button ${label} is rendered`);
  return found;
}

// Mounts a card for a real runApprovalAction turn; returns what the test drives.
async function mountApprovalTurn(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const commits = [];
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
            body: "Original text",
          },
        }),
        connectorCommit: async (actionId, edits) => {
          commits.push({ actionId, edits });
          return { state: "sent", url: "https://slack.test/p/1" };
        },
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-approval-flow-test-",
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
  const store = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const { runApprovalAction } = await vite.ssrLoadModule(
    "/services/tools/connectors/runApprovalAction.ts"
  );
  const { ApprovalCard } = await vite.ssrLoadModule("/components/chat/ApprovalCard.tsx");
  store.useConnectorApprovalStore.setState({ entries: {} });

  function Harness() {
    const entry = store.useConnectorApprovalStore((state) => state.entries["call-1"]);
    return entry ? React.createElement(ApprovalCard, { entry }) : null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  const controller = new AbortController();
  let toolResult;
  await React.act(async () => {
    toolResult = runApprovalAction(
      {
        toolCallId: "call-1",
        signal: controller.signal,
        onApprovalRequested() {},
        onHoldDelivery() {},
      },
      "slack",
      "send_message",
      { destination: "#eng", text: "Original text" }
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(container.textContent, /Original text/);
  return { container, store, commits, toolResult };
}

test("Edit, change, Done editing, Send: the reviewed text is what gets sent", async (t) => {
  const { container, store, commits, toolResult } = await mountApprovalTurn(t);
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  // Editing must not lose the direction-detection the static view gets:
  // an RTL draft opened for editing should still render right-to-left.
  const bodyField = findElement(container, (element) => element.tagName === "TEXTAREA");
  assert.ok(bodyField, "the body textarea is rendered in edit mode");
  assert.equal(bodyField.getAttribute("dir"), "auto");
  // What the textarea's onChange calls with the typed value.
  await React.act(async () => store.updateApprovalDraft("call-1", { body: "Edited text" }));
  await React.act(async () => click(button(container, "connectors.approval.doneEditing")));
  assert.match(container.textContent, /Edited text/);
  await React.act(async () => click(button(container, "connectors.approval.send")));

  const result = await toolResult;
  assert.deepEqual(commits, [{ actionId: "a1", edits: { body: "Edited text" } }]);
  assert.equal(result.data.status, "sent");
  assert.equal(result.data.finalText, "Edited text");
  assert.match(container.textContent, /connectors\.approval\.sent/);
});

test("Send while editing commits the edit and leaves edit mode", async (t) => {
  const { container, store, commits, toolResult } = await mountApprovalTurn(t);

  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => store.updateApprovalDraft("call-1", { body: "Edited text" }));
  await React.act(async () => click(button(container, "connectors.approval.send")));
  await toolResult;

  assert.deepEqual(commits, [{ actionId: "a1", edits: { body: "Edited text" } }]);
  // A boolean: a failing assert would otherwise try to print the fake DOM node.
  assert.ok(
    !findElement(container, (element) => element.tagName === "TEXTAREA"),
    "the card left edit mode"
  );
  assert.match(container.textContent, /Edited text/);
});
