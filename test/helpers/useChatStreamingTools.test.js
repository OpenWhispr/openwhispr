const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Drives the real useChatStreaming hook (one synchronous render, then its
// sendToAI closure; see useChatStreamingCancellation.test.js) on the
// OpenWhispr Cloud path, with the stream itself stubbed so the test can see
// which tools a send offers the model.
async function renderChatStreaming(
  t,
  hookOptions = {},
  { settings = {}, electronAPI = {}, subscribed = true } = {}
) {
  installBrowserGlobals(t, {
    initialStorage: { isSubscribed: String(subscribed) },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-tools-test-",
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  useSettingsStore.setState({ chatAgentMode: "openwhispr", isSignedIn: true, ...settings });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  // The app's i18n module (loaded with the tools) follows the machine's locale.
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  const offeredTools = [];
  const endStream = async function* () {
    yield { type: "done", finishReason: "stop" };
  };
  t.mock.method(reasoningService, "processTextStreamingCloud", (_messages, config) => {
    offeredTools.push((config.tools ?? []).map((tool) => tool.name));
    return endStream();
  });
  t.mock.method(
    reasoningService,
    "processTextStreamingAI",
    (_messages, _model, _provider, _config, tools) => {
      offeredTools.push(Object.keys(tools ?? {}));
      return endStream();
    }
  );

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  let captured = null;
  function Harness() {
    captured = useChatStreaming({ messages, setMessages, ...hookOptions });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  return { captured, offeredTools, reasoningService, usePolicyStore, getMessages: () => messages };
}

// Typed chat and the voice panel opt in; every other surface leaves it off.
const CONNECTOR_SURFACE = { allowConnectors: true };
const BYOK_SETTINGS = {
  chatAgentMode: "providers",
  chatAgentProvider: "openai",
  chatAgentModel: "gpt-5-mini",
};
const MANAGED_POLICY = {
  version: 1,
  transcription: { allowedModes: ["openwhispr"], allowedByokProviders: [] },
  llm: { allowedModes: ["openwhispr"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: true, webSearchEnabled: true, connectorsEnabled: true },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: null,
};

function offersConnectors(tools) {
  return tools.includes("email_draft") || tools.includes("find_contact");
}

test("a paid, signed-in chat offers the connector tools", async (t) => {
  const { captured, offeredTools } = await renderChatStreaming(t, CONNECTOR_SURFACE);
  await captured.sendToAI("Email Josh", []);
  assert.ok(offeredTools[0].includes("email_draft"));
  assert.ok(offeredTools[0].includes("find_contact"));
});

test("a surface that doesn't opt in (note or container chat) never offers them", async (t) => {
  const { captured, offeredTools } = await renderChatStreaming(t);
  await captured.sendToAI("Reply to Maria", []);
  assert.ok(offeredTools[0].length > 0);
  assert.equal(offersConnectors(offeredTools[0]), false);
});

test("a signed-out chat never offers them", async (t) => {
  const { captured, offeredTools } = await renderChatStreaming(t, CONNECTOR_SURFACE, {
    settings: { ...BYOK_SETTINGS, isSignedIn: false },
  });
  await captured.sendToAI("Email Josh", []);
  assert.ok(offeredTools[0].length > 0);
  assert.equal(offersConnectors(offeredTools[0]), false);
});

test("a free plan never offers them", async (t) => {
  const { captured, offeredTools } = await renderChatStreaming(t, CONNECTOR_SURFACE, {
    subscribed: false,
  });
  await captured.sendToAI("Email Josh", []);
  assert.ok(offeredTools[0].length > 0);
  assert.equal(offersConnectors(offeredTools[0]), false);
});

test("an org that turns connectors off mid-session removes them from the next send", async (t) => {
  const { captured, offeredTools, usePolicyStore } = await renderChatStreaming(
    t,
    CONNECTOR_SURFACE
  );
  usePolicyStore.setState({ status: "managed", appVersion: "1.10.0", policy: MANAGED_POLICY });
  await captured.sendToAI("Email Josh", []);
  usePolicyStore.setState({
    policy: {
      ...MANAGED_POLICY,
      features: { ...MANAGED_POLICY.features, connectorsEnabled: false },
    },
  });
  await captured.sendToAI("Email Josh again", []);

  assert.equal(offersConnectors(offeredTools[0]), true);
  assert.ok(offeredTools[1].length > 0);
  assert.equal(offersConnectors(offeredTools[1]), false);
});

test("on the AI SDK path a tool step shows the tool's own text, not a bare Done", async (t) => {
  const { captured, reasoningService, getMessages } = await renderChatStreaming(
    t,
    CONNECTOR_SURFACE,
    {
      settings: BYOK_SETTINGS,
      electronAPI: {
        connectorFindContacts: async () => ({
          contacts: [
            { name: "Gabe Torres", email: "gabe@example.com", lastMet: null },
            { name: "Gabriel Stone", email: "gabriel@acme.test", lastMet: null },
          ],
        }),
      },
    }
  );
  reasoningService.processTextStreamingAI.mock.mockImplementation(
    (_messages, _model, _provider, _config, tools) =>
      (async function* () {
        yield {
          type: "tool_calls",
          calls: [{ id: "call-1", name: "find_contact", arguments: "{}" }],
        };
        await tools.find_contact.execute({ name: "Gab" }, { toolCallId: "call-1", messages: [] });
        // What ReasoningService yields for any object output.
        yield {
          type: "tool_result",
          callId: "call-1",
          toolName: "find_contact",
          displayText: "Done",
        };
        yield { type: "done", finishReason: "stop" };
      })()
  );

  let holds = 0;
  await captured.sendToAI("Who is Gab?", [], { onHoldDelivery: () => (holds += 1) });

  const assistant = getMessages().find((message) => message.role === "assistant");
  assert.equal(assistant.toolCalls[0].result, "Contacts found: 2");
  // The AI SDK tools carry the turn's scope, so a tool's hold reaches the caller.
  assert.equal(holds, 1);
});

test("on the cloud path a tool's hold reaches the caller through the turn's scope", async (t) => {
  const { captured, reasoningService } = await renderChatStreaming(t, CONNECTOR_SURFACE, {
    electronAPI: { connectorFindContacts: async () => ({ contacts: [] }) },
  });
  reasoningService.processTextStreamingCloud.mock.mockImplementation((_messages, config) =>
    (async function* () {
      yield {
        type: "tool_calls",
        calls: [{ id: "srv-1", name: "find_contact", arguments: '{"name":"Zed"}' }],
      };
      const result = await config.executeToolCall("find_contact", '{"name":"Zed"}', "srv-1");
      yield {
        type: "tool_result",
        callId: "srv-1",
        toolName: "find_contact",
        displayText: result.displayText,
      };
      yield { type: "done", finishReason: "stop" };
    })()
  );

  let holds = 0;
  await captured.sendToAI("Who is Zed?", [], { onHoldDelivery: () => (holds += 1) });

  assert.equal(holds, 1);
});

test("Esc settles a send whose tool never finishes, and a late result is dropped", async (t) => {
  let finishLookup;
  const { captured, reasoningService } = await renderChatStreaming(t, CONNECTOR_SURFACE, {
    electronAPI: {
      connectorFindContacts: () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    },
  });
  let toolResult;
  reasoningService.processTextStreamingCloud.mock.mockImplementation((_messages, config) =>
    (async function* () {
      yield {
        type: "tool_calls",
        calls: [{ id: "srv-2", name: "find_contact", arguments: '{"name":"Zed"}' }],
      };
      toolResult = await config.executeToolCall("find_contact", '{"name":"Zed"}', "srv-2");
      yield { type: "done", finishReason: "stop" };
    })()
  );

  const sending = captured.sendToAI("Who is Zed?", []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  captured.cancelStream();
  const outcome = await Promise.race([
    sending.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting on the tool"), 1000)),
  ]);
  finishLookup({ contacts: [{ name: "Zed", email: "zed@example.com", lastMet: null }] });

  assert.equal(outcome, "settled");
  assert.equal(toolResult.displayText, "");
});

test("an error before the stream starts still rejects the send and adds no messages", async (t) => {
  const { captured, getMessages } = await renderChatStreaming(
    t,
    {},
    {
      // Snippet triggers are read while the tool registry is built, before any stream.
      settings: { snippets: null },
    }
  );
  await assert.rejects(() => captured.sendToAI("hi", []), TypeError);
  assert.equal(getMessages().length, 0);
});

// A draft still waiting on main when its turn ends is released through the
// turn's signal (the cancel names its run), however the send ended.
const STREAM_ENDINGS = {
  completes: () => [{ type: "done", finishReason: "stop" }],
  fails: () => {
    throw new Error("stream dropped");
  },
};
for (const [ending, finishStream] of Object.entries(STREAM_ENDINGS)) {
  test(`a send that ${ending} releases a tool still running in its turn`, async (t) => {
    const cancels = [];
    const { captured, reasoningService } = await renderChatStreaming(t, CONNECTOR_SURFACE, {
      electronAPI: {
        connectorRunDirect: () => new Promise(() => {}),
        connectorCancel: async (runId, reason) => cancels.push(reason),
      },
    });
    reasoningService.processTextStreamingCloud.mock.mockImplementation((_messages, config) =>
      (async function* () {
        void config.executeToolCall(
          "email_draft",
          JSON.stringify({ to: ["zed@example.com"], subject: "Hi", body: "Hello" }),
          "srv-3"
        );
        yield* finishStream();
      })()
    );

    await captured.sendToAI("Email Zed", []);

    assert.deepEqual(cancels, ["cancelled_by_user"]);
  });
}

// Sends that each wait on an email draft main never finishes, so a turn only
// ends once its tool scope is aborted. Returns the run ids main was asked to
// open and to cancel, in order.
async function renderDraftTurns(t, streamForSend) {
  const opened = [];
  const cancelled = [];
  let notifyOpened = () => {};
  const { captured, reasoningService } = await renderChatStreaming(t, CONNECTOR_SURFACE, {
    electronAPI: {
      connectorRunDirect: (_connector, _action, _draft, runId) => {
        opened.push(runId);
        notifyOpened();
        return new Promise(() => {});
      },
      connectorCancel: async (runId) => cancelled.push(runId),
    },
  });
  let sends = 0;
  reasoningService.processTextStreamingCloud.mock.mockImplementation((_messages, config) =>
    streamForSend(sends++, config)
  );
  const nextDraftOpened = () =>
    new Promise((resolve) => {
      notifyOpened = resolve;
    });
  return { captured, opened, cancelled, nextDraftOpened };
}

function awaitDraft(config, callId) {
  return (async function* () {
    await config.executeToolCall(
      "email_draft",
      JSON.stringify({ to: ["zed@example.com"], subject: "Hi", body: "Hello" }),
      callId
    );
    yield { type: "done", finishReason: "stop" };
  })();
}

const settlesWithin = (promise, ms = 1000) =>
  Promise.race([
    promise.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), ms)),
  ]);

test("a newer send releases the tools of the send it replaces", async (t) => {
  const { captured, opened, cancelled, nextDraftOpened } = await renderDraftTurns(
    t,
    (send, config) =>
      send === 0
        ? awaitDraft(config, "srv-old")
        : (async function* () {
            yield { type: "done", finishReason: "stop" };
          })()
  );

  const draftOpened = nextDraftOpened();
  const first = captured.sendToAI("Email Zed", []);
  await draftOpened;
  await captured.sendToAI("Never mind", []);

  assert.equal(await settlesWithin(first), "settled");
  assert.deepEqual(cancelled, opened);
});

test("a replaced send that ends leaves the newer send cancellable", async (t) => {
  const { captured, opened, cancelled, nextDraftOpened } = await renderDraftTurns(
    t,
    (send, config) => awaitDraft(config, `srv-${send}`)
  );

  let draftOpened = nextDraftOpened();
  const first = captured.sendToAI("Email Zed", []);
  await draftOpened;
  draftOpened = nextDraftOpened();
  const second = captured.sendToAI("Email Zed again", []);
  await draftOpened;
  // The first send's cleanup runs now; it must not drop the second's scope.
  assert.equal(await settlesWithin(first), "settled");
  captured.cancelStream();

  assert.equal(await settlesWithin(second), "settled");
  assert.deepEqual(cancelled, opened);
});
