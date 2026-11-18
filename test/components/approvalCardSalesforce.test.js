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
  // Native inputs default to text; the lightweight DOM has no default type.
  if (element.tagName === "INPUT" && !element.type) element.type = "text";
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

const FIELDS = { value0: "New", include0: "yes", value1: "Later", include1: "yes" };
const PREVIEW = {
  verbKey: "salesforceFields",
  destinationLabel: "Renewal",
  accountLabel: "Dana",
  workspaceLabel: "Acme",
  body: "",
  fields: FIELDS,
  salesforceFields: [
    { key: "value0", name: "Needs__c", label: "Needs", before: "Old", maxLength: 8 },
    { key: "value1", name: "Next__c", label: "Next", before: "Earlier", maxLength: 8 },
  ],
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
        claimAction: () => true,
        releaseAction() {},
        sentEarlier: () => false,
        recordCompletedAction() {},
        onApprovalRequested() {},
        onHoldDelivery() {},
        claimTurnSlot: () => true,
        releaseTurnSlot() {},
      },
      "salesforce",
      "update_fields",
      {}
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  return { container, calls, toolResult: () => toolResult };
}

test("Salesforce field cards show current values, edit replacements and omit changes before saving", async (t) => {
  const { container, calls, toolResult } = await mountCard(t, { preview: PREVIEW });
  assert.match(container.textContent, /Old/);
  assert.match(container.textContent, /Earlier/);
  assert.match(container.textContent, /Needs__c/);
  const textareas = [];
  function collect(node) {
    if (node.tagName === "TEXTAREA") textareas.push(node);
    for (const child of node.childNodes ?? []) collect(child);
  }
  collect(container);
  assert.equal(textareas.length, 2);
  await React.act(async () => type(textareas[0], "123456789"));
  assert.equal(problemText(container), "connectors.approval.salesforce.tooLong");
  await React.act(async () => click(button(container, "connectors.approval.send")));
  assert.deepEqual(calls.commit, []);
  await React.act(async () => type(textareas[0], "Reviewed"));
  // The card's own checkbox, named by the field it includes.
  const omit = findElement(
    container,
    (element) =>
      element.getAttribute?.("role") === "checkbox" && /Needs__c/.test(element.textContent)
  );
  assert.ok(omit);
  assert.equal(omit.getAttribute("aria-label"), "connectors.approval.salesforce.include");
  // Each replacement box is named after its own field, not just "Proposed replacement".
  const labelOf = (textarea) =>
    textarea
      .getAttribute("aria-labelledby")
      .split(" ")
      .map((id) => findElement(container, (element) => element.getAttribute?.("id") === id))
      .map((element) => element.textContent)
      .join(" ");
  assert.deepEqual(textareas.map(labelOf), [
    "Needs connectors.approval.salesforce.after",
    "Next connectors.approval.salesforce.after",
  ]);
  assert.equal(omit.getAttribute("aria-checked"), "true");
  await React.act(async () => click(omit));
  assert.equal(omit.getAttribute("aria-checked"), "false");
  await React.act(async () => click(button(container, "connectors.approval.send")));
  const result = await toolResult();
  assert.equal(result.data.status, "sent");
  assert.match(container.textContent, /connectors\.approval\.salesforce\.savedLabel/);
  assert.doesNotMatch(container.textContent, /connectors\.approval\.sentLabel/);
  assert.deepEqual(calls.commit[0].edits, {
    value0: "Reviewed",
    include0: "no",
    value1: "Later",
    include1: "yes",
  });
});

test("an activity card edits title and body without changing its selected destination", async (t) => {
  const preview = {
    verbKey: "salesforceActivity",
    destinationLabel: "Renewal",
    accountLabel: "Dana",
    title: "Meeting",
    body: "Summary: Old",
  };
  const { container, calls, toolResult } = await mountCard(t, { preview });
  await React.act(async () => type(field(container, "titleLabel"), "Customer meeting"));
  await React.act(async () => type(field(container, "bodyLabel"), "Summary: Reviewed"));
  await React.act(async () => click(button(container, "connectors.approval.send")));
  assert.equal((await toolResult()).data.status, "sent");
  assert.deepEqual(calls.commit[0].edits, { title: "Customer meeting", body: "Summary: Reviewed" });
});
