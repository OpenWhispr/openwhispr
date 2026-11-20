const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  SIGNED_OUT_AUTH_MOCK,
  createRendererServer,
  installBrowserGlobals,
} = require("../lib/rendererTestHarness");

// Plan 1's final review asked for this once a real approval tool existed: a
// send whose stream throws while a Slack card waits must withdraw the card
// (not_sent, conversation_ended) rather than leave it for its 10-minute expiry.
// Same harness technique as useChatStreamingCancellation.test.js: one SSR
// render yields sendToAI, which is then called like any closure.
// Connector tools are offered per build: an upstream build (hosted cloud) needs the
// OpenWhispr session and plan; a fork build needs a Titanium account-bound license.
const MODES = {
  upstream: {
    env: {
      VITE_OPENWHISPR_API_URL: "https://api.connectors.test",
      VITE_AUTH_URL: "https://auth.connectors.test",
    },
    storage: { isSubscribed: "true" },
    openWhisprSignedIn: true,
    titanium: null,
  },
  fork: {
    // test/setup/forkEnv.js pre-sets the hosted-cloud URLs for the whole suite; a real
    // fork build has them empty (forkRuntime falls back to the empty fork config).
    env: { VITE_OPENWHISPR_API_URL: "", VITE_AUTH_URL: "" },
    storage: {},
    openWhisprSignedIn: false,
    titanium: { signedIn: true, accountBound: true, licensed: true },
  },
};

for (const [mode, config] of Object.entries(MODES)) {
  test(`a send that throws withdraws a pending approval (${mode} build)`, (t) =>
    runWithdrawsPendingApproval(t, config));
}

test("a fork build without a license offers no connector tools", async (t) => {
  const sawTools = await runOffered(t, {
    ...MODES.fork,
    titanium: { signedIn: true, accountBound: true, licensed: false },
  });
  assert.equal(sawTools, false);
});

test("a fork build signed in from a session with no account id offers no connector tools", async (t) => {
  const sawTools = await runOffered(t, {
    ...MODES.fork,
    titanium: { signedIn: true, accountBound: false, licensed: true },
  });
  assert.equal(sawTools, false);
});

function setEnv(t, env) {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() =>
      previous === undefined ? delete process.env[key] : (process.env[key] = previous)
    );
  }
}

async function runOffered(t, config) {
  let sawSlackTool = null;
  await runChat(t, config, {
    onTools: (tools) => {
      sawSlackTool = Boolean(tools?.slack_send_message);
    },
    throwAfterApproval: false,
  });
  return sawSlackTool;
}

async function runWithdrawsPendingApproval(t, config) {
  const { sawSlackTool, approvals, cancels } = await runChat(t, config, {
    throwAfterApproval: true,
  });
  assert.equal(sawSlackTool, true);
  const [entry] = Object.values(approvals.useConnectorApprovalStore.getState().entries);
  assert.equal(entry.state, "not_sent");
  assert.deepEqual(cancels, [{ actionId: "a1", reason: "conversation_ended" }]);
}

async function runChat(t, config, { onTools, throwAfterApproval }) {
  setEnv(t, config.env);
  const cancels = [];
  installBrowserGlobals(t, {
    initialStorage: config.storage,
    window: {
      electronAPI: {
        titaniumAuthGetState: async () => config.titanium,
        onTitaniumAuthChanged: () => () => {},
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
    mockModules: SIGNED_OUT_AUTH_MOCK,
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
    isSignedIn: config.openWhisprSignedIn,
  });
  // The Titanium hook reads its state asynchronously from main; let it settle.
  const { getTitaniumAuthState } = await vite.ssrLoadModule("/hooks/useTitaniumAuth.ts");
  getTitaniumAuthState();
  const expected = Boolean(config.titanium?.signedIn);
  for (let i = 0; i < 200 && getTitaniumAuthState().signedIn !== expected; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(getTitaniumAuthState().signedIn, expected, "Titanium state settled");

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  let sawSlackTool = null;
  t.mock.method(
    reasoningService,
    "processTextStreamingAI",
    (_messages, _model, _provider, _config, tools) => {
      sawSlackTool = Boolean(tools?.slack_send_message);
      onTools?.(tools);
      // Must stay an async generator so the hook's `for await` sees it; it
      // throws before ever reaching a yield, which is the point of this test.
      // eslint-disable-next-line require-yield
      return (async function* () {
        if (!throwAfterApproval) throw new Error("stop after the tool check");
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

  return { sawSlackTool, approvals, cancels };
}
