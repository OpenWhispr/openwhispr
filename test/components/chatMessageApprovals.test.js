const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const PREVIEW = {
  verbKey: "default",
  destinationLabel: "#eng",
  accountLabel: "chad",
  body: "Hello team",
};

function hasApprovalCard(container) {
  return Boolean(
    findElement(container, (element) => element.getAttribute?.("data-approval-card") != null)
  );
}

// zustand's react binding renders the SSR snapshot (api.getInitialState(),
// frozen at module load) under renderToStaticMarkup, so setting state on the
// real store before an SSR render never reaches a reactive selector. Mount
// with createRoot instead, like approvalFlow.test.js, to see live state.
test("a card shows only on the message whose tool call requested it", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-message-approvals-test-",
    mockModules: {
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
    },
  });
  const store = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const { ChatMessage } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  const key = store.approvalKey("msg-new", "call-1");
  store.useConnectorApprovalStore.setState({
    entries: {
      [key]: {
        key,
        messageId: "msg-new",
        toolCallId: "call-1",
        actionId: "a1",
        connectorId: "slack",
        preview: PREVIEW,
        draft: { body: PREVIEW.body },
        state: "pending",
      },
    },
  });
  const toolCalls = [
    { id: "call-1", name: "slack_send_message", arguments: "{}", status: "completed" },
  ];
  root = createRoot(container);
  const render = async (messageId) => {
    const element = React.createElement(ChatMessage, {
      messageId,
      role: "assistant",
      content: "",
      isStreaming: false,
      toolCalls,
    });
    await React.act(async () => root.render(element));
  };

  await render("msg-new");
  assert.ok(hasApprovalCard(container), "the message whose tool call requested it shows a card");

  await render("msg-old");
  assert.ok(
    !hasApprovalCard(container),
    "a different message reusing the same tool-call id shows no card"
  );
});
