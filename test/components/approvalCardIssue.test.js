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
    (element) => element.getAttribute?.("aria-label") === `connectors.approval.${labelKey}`
  );

const problemText = (root) =>
  findElement(root, (element) => element.tagName === "P" && element.getAttribute?.("id"))
    ?.textContent || null;

const ISSUE_FIELDS = { title: "Fix login", body: "Safari users can't sign in." };
const ISSUE_PREVIEW = {
  verbKey: "issue",
  destinationLabel: "ENG",
  accountLabel: "chad",
  workspaceLabel: "Acme",
  body: ISSUE_FIELDS.body,
  fields: ISSUE_FIELDS,
};
const COMMENT_PREVIEW = {
  verbKey: "comment",
  destinationLabel: "ENG-123",
  accountLabel: "chad",
  body: "Fixed in 1.9.",
  fields: { body: "Fixed in 1.9." },
};

async function mountCard(
  t,
  {
    preview,
    commitReply = { state: "sent", url: "https://linear.test/ENG-124", resultLabel: "ENG-124" },
  }
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
  const calls = { commit: [] };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({ status: "ready", actionId: "a1", preview }),
        connectorCommit: async (actionId, edits) => {
          calls.commit.push({ actionId, edits });
          return commitReply;
        },
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-approval-card-issue-test-",
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
      "linear",
      preview.verbKey === "issue" ? "create_issue" : "comment",
      {}
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  return { container, calls, toolResult: () => toolResult };
}

test("an issue card blocks Send on a missing or long title and a long description, and says why", async (t) => {
  const { container, calls } = await mountCard(t, { preview: ISSUE_PREVIEW });
  await React.act(async () => click(button(container, "connectors.approval.edit")));

  for (const [labelKey, value, reason] of [
    ["issue.titleLabel", "   ", "issue.missingTitle"],
    ["issue.titleLabel", "x".repeat(257), "issue.titleTooLong"],
    ["issue.titleLabel", "Fix login", null],
    ["issue.bodyLabel", "y".repeat(65537), "issue.bodyTooLong"],
    ["issue.bodyLabel", "Safari users can't sign in.", null],
  ]) {
    await React.act(async () => type(field(container, labelKey), value));
    const send = button(container, "connectors.approval.send");
    if (reason) {
      assert.equal(problemText(container), `connectors.approval.${reason}`, reason);
      assert.equal(field(container, labelKey).getAttribute("aria-invalid"), "true", reason);
      assert.equal(send.getAttribute("aria-disabled"), "true", `${reason}: Send is blocked`);
      await React.act(async () => click(send));
    } else {
      assert.equal(problemText(container), null, labelKey);
      assert.equal(send.getAttribute("aria-disabled"), null, `${labelKey}: Send is enabled`);
    }
  }
  assert.deepEqual(calls.commit, [], "a blocked Send never commits");
});

test("Send commits the edited title and description, and the model hears what was created", async (t) => {
  const { container, calls, toolResult } = await mountCard(t, { preview: ISSUE_PREVIEW });
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  await React.act(async () => type(field(container, "issue.titleLabel"), "Fix login\non Safari"));
  await React.act(async () => type(field(container, "issue.bodyLabel"), "Steps:\n1. Open Safari"));

  await React.act(async () => click(button(container, "connectors.approval.send")));
  const result = await toolResult();

  const edited = { title: "Fix login on Safari", body: "Steps:\n1. Open Safari" };
  assert.deepEqual(calls.commit, [{ actionId: "a1", edits: edited }]);
  assert.equal(result.data.status, "sent");
  assert.deepEqual(result.data.final, edited);
  assert.equal(result.data.reference, "ENG-124");
});

test("a comment card edits only its text and won't send an empty comment", async (t) => {
  const { container, calls } = await mountCard(t, { preview: COMMENT_PREVIEW });
  assert.match(container.textContent, /Fixed in 1\.9\./);
  await React.act(async () => click(button(container, "connectors.approval.edit")));

  assert.ok(!field(container, "issue.titleLabel"), "a comment has no title");
  await React.act(async () => type(field(container, "comment.bodyLabel"), " \n "));
  assert.equal(problemText(container), "connectors.approval.comment.missingBody");
  assert.equal(field(container, "comment.bodyLabel").getAttribute("aria-invalid"), "true");
  const send = button(container, "connectors.approval.send");
  assert.equal(send.getAttribute("aria-disabled"), "true");
  await React.act(async () => click(send));
  assert.deepEqual(calls.commit, []);
});

test("an issue preview without a usable title falls back to the plain layout", async (t) => {
  const { container } = await mountCard(t, {
    preview: { ...ISSUE_PREVIEW, body: "Only a body", fields: { body: "Only a body" } },
  });
  assert.match(container.textContent, /Only a body/);
  await React.act(async () => click(button(container, "connectors.approval.edit")));

  assert.ok(!field(container, "issue.titleLabel"));
  assert.ok(field(container, "bodyLabel"), "the plain layout's message field");
});
