const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Plan 1's final review asked for this once a real approval tool existed: a
// send whose stream throws while a Slack card waits must withdraw the card
// (not_sent, conversation_ended) rather than leave it for its 10-minute expiry.
// Same harness technique as useChatStreamingCancellation.test.js: one SSR
// render yields sendToAI, which is then called like any closure.
test("a send that throws withdraws a pending approval", async (t) => {
  const cancels = [];
  installBrowserGlobals(t, {
    initialStorage: { isSubscribed: "true" },
    window: {
      electronAPI: {
        connectorStatus: async () => [
          {
            id: "slack",
            connected: true,
            accountLabel: "chad",
            workspaceLabel: "Acme",
            needsReconnect: false,
          },
        ],
        onConnectorStatusChanged: () => () => {},
        connectorPrepare: async () => ({
          status: "ready",
          actionId: "a1",
          preview: {
            verbKey: "slackPost",
            destinationLabel: "#eng",
            accountLabel: "chad",
            workspaceLabel: "Acme",
            body: "Hi team",
          },
        }),
        connectorCancel: async (actionId, reason) => {
          cancels.push({ actionId, reason });
          return { cancelled: true };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-connectors-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const approvals = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  approvals.useConnectorApprovalStore.setState({ entries: {} });
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  // A tool-eligible self-hosted (LAN) agent, as in the cancellation tests.
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    chatAgentDisableThinking: true,
    isSignedIn: true,
  });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  let sawSlackTool = false;
  t.mock.method(
    reasoningService,
    "processTextStreamingAI",
    (_messages, _model, _provider, _config, tools) => {
      sawSlackTool = Boolean(tools?.slack_send_message);
      // Must stay an async generator so the hook's `for await` sees it; it
      // throws before ever reaching a yield, which is the point of this test.
      // eslint-disable-next-line require-yield
      return (async function* () {
        void tools.slack_send_message.execute(
          { destination: "#eng", text: "Hi team" },
          { toolCallId: "call-1", messages: [] }
        );
        while (Object.keys(approvals.useConnectorApprovalStore.getState().entries).length === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error("provider stream failed");
      })();
    }
  );

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  let captured = null;
  function Harness() {
    captured = useChatStreaming({ messages, setMessages, allowConnectors: true });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  await captured.sendToAI("post hi to eng", []).catch(() => {});

  assert.equal(sawSlackTool, true);
  const [entry] = Object.values(approvals.useConnectorApprovalStore.getState().entries);
  assert.equal(entry.state, "not_sent");
  assert.deepEqual(cancels, [{ actionId: "a1", reason: "conversation_ended" }]);
});
