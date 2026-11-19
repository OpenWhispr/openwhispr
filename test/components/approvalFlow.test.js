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

const SENT = { state: "sent", url: "https://slack.test/p/1" };

// Mounts a card for a real runApprovalAction turn; returns what the test drives.
// Commits answer with `replies` in turn; each prepare gets the next action id.
async function mountApprovalTurn(t, { replies = [SENT] } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // Ends the turn, so a card a failed test left waiting holds no timer.
  const controller = new AbortController();
  t.after(() => controller.abort());
  const commits = [];
  const connects = [];
  let prepares = 0;
  const slack = { id: "slack", connected: true, configured: true, needsReconnect: false };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: `a${(prepares += 1)}`,
          preview: {
            verbKey: "default",
            destinationLabel: "#eng",
            accountLabel: "chad",
            body: "Original text",
          },
        }),
        connectorCommit: async (actionId, edits) => {
          commits.push({ actionId, edits });
          return replies[Math.min(commits.length, replies.length) - 1];
        },
        connectorCancel: async () => ({ cancelled: true }),
        connectorConnect: async (target) => {
          connects.push(target);
          slack.needsReconnect = false;
          return { status: "connected" };
        },
        connectorStatus: async () => [slack],
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
    const entry = store.useConnectorApprovalStore(
      (state) => state.entries[store.approvalKey("m1", "call-1")]
    );
    return entry ? React.createElement(ApprovalCard, { entry }) : null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  // A layout change: the card goes away and comes back.
  const remount = async () => {
    await React.act(async () => root.render(null));
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  // Lets the card's IPC round trips (connect, prepare, commit) finish.
  const settle = () =>
    React.act(async () => {
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    });

  let toolResult;
  await React.act(async () => {
    toolResult = runApprovalAction(
      {
        messageId: "m1",
        toolCallId: "call-1",
        signal: controller.signal,
        claimTurnSlot: () => true,
        claimAction: () => true,
        releaseAction() {},
        sentEarlier: () => false,
        recordCompletedAction() {},
        releaseTurnSlot() {},
      },
      "slack",
      "send_message",
      { destination: "#eng", text: "Original text" }
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.ok(
    findElement(container, (element) => element.tagName === "TEXTAREA"),
    "the card shows the text, editable"
  );
  return { container, store, commits, connects, toolResult, remount, settle };
}

test("Change the text in place, Send: the reviewed text is what gets sent", async (t) => {
  const { container, store, commits, toolResult } = await mountApprovalTurn(t);
  // Editing must not lose the direction-detection the static view gets:
  // an RTL draft should still render right-to-left.
  const bodyField = findElement(container, (element) => element.tagName === "TEXTAREA");
  assert.ok(bodyField, "a pending card's body is edited in place");
  assert.equal(bodyField.getAttribute("dir"), "auto");
  // What the textarea's onChange calls with the typed value.
  await React.act(async () =>
    store.updateApprovalDraft(store.approvalKey("m1", "call-1"), { body: "Edited text" })
  );
  assert.equal(bodyField.value, "Edited text");
  await React.act(async () => click(button(container, "connectors.approval.send")));

  const result = await toolResult;
  assert.deepEqual(commits, [{ actionId: "a1", edits: { body: "Edited text" } }]);
  assert.equal(result.data.status, "sent");
  assert.equal(result.data.finalText, "Edited text");
  assert.match(container.textContent, /connectors\.approval\.sent/);
});

test("Send commits the edit and freezes the text", async (t) => {
  const { container, store, commits, toolResult } = await mountApprovalTurn(t);

  await React.act(async () =>
    store.updateApprovalDraft(store.approvalKey("m1", "call-1"), { body: "Edited text" })
  );
  await React.act(async () => click(button(container, "connectors.approval.send")));
  await toolResult;

  assert.deepEqual(commits, [{ actionId: "a1", edits: { body: "Edited text" } }]);
  // A boolean: a failing assert would otherwise try to print the fake DOM node.
  assert.ok(
    !findElement(container, (element) => element.tagName === "TEXTAREA"),
    "the sent text is no longer editable"
  );
  assert.match(container.textContent, /Edited text/);
});

test("edits on the card survive a remount", async (t) => {
  const { container, store, remount } = await mountApprovalTurn(t);
  await React.act(async () =>
    store.updateApprovalDraft(store.approvalKey("m1", "call-1"), { body: "Edited text" })
  );
  await remount();
  const bodyField = findElement(container, (element) => element.tagName === "TEXTAREA");
  // A fresh field: React mounts the text as its default value.
  assert.equal(bodyField.defaultValue, "Edited text");
});

test("Retry after a failed Send prepares a fresh card that waits for Send", async (t) => {
  const { container, commits, toolResult, settle } = await mountApprovalTurn(t, {
    replies: [{ state: "failed", errorCode: "rate_limited", message: "Busy" }, SENT],
  });
  await React.act(async () => click(button(container, "connectors.approval.send")));
  await settle();
  await React.act(async () => click(button(container, "common.retry")));
  await settle();
  assert.equal(commits.length, 1, "Retry has not sent the newly prepared action");
  await React.act(async () => click(button(container, "connectors.approval.send")));
  const result = await toolResult;
  assert.equal(result.data.status, "sent");
  assert.deepEqual(
    commits.map((commit) => commit.actionId),
    ["a1", "a2"]
  );
});

test("Yes on the connect prompt prepares a fresh card that waits for Send", async (t) => {
  const { container, commits, connects, toolResult, settle } = await mountApprovalTurn(t, {
    replies: [{ state: "failed", errorCode: "reconnect_needed", message: "Reconnect" }, SENT],
  });
  await React.act(async () => click(button(container, "connectors.approval.send")));
  await settle();
  assert.match(container.textContent, /connectors\.approval\.connectToSend/);
  const yes = findElement(
    container,
    (element) =>
      element.tagName === "BUTTON" &&
      element.textContent.includes("agentMode.interactions.connection.yes")
  );
  await React.act(async () => click(yes));
  await settle();
  assert.equal(commits.length, 1, "connecting has not sent the newly prepared action");
  await React.act(async () => click(button(container, "connectors.approval.send")));
  const result = await toolResult;
  assert.deepEqual(connects, ["slack"]);
  assert.equal(result.data.status, "sent");
  assert.deepEqual(
    commits.map((commit) => commit.actionId),
    ["a1", "a2"]
  );
});
