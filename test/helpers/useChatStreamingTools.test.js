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
async function renderChatStreaming(t, hookOptions = {}, { settings = {}, electronAPI = {} } = {}) {
  installBrowserGlobals(t, { initialStorage: { isSubscribed: "true" }, window: { electronAPI } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-chat-streaming-tools-test-" });
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
  t.mock.method(reasoningService, "processTextStreamingCloud", (_messages, config) => {
    offeredTools.push((config.tools ?? []).map((tool) => tool.name));
    return (async function* () {
      yield { type: "done", finishReason: "stop" };
    })();
  });

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
  return { captured, offeredTools, reasoningService, getMessages: () => messages };
}

test("a paid, signed-in chat offers the connector tools", async (t) => {
  const { captured, offeredTools } = await renderChatStreaming(t);
  await captured.sendToAI("Email Josh", []);
  assert.ok(offeredTools[0].includes("email_draft"));
  assert.ok(offeredTools[0].includes("find_contact"));
});

test("a surface that turns connectors off never offers them", async (t) => {
  const { captured, offeredTools } = await renderChatStreaming(t, {
    inferenceScope: "dictationAgent",
    allowConnectors: false,
  });
  await captured.sendToAI("Reply to Maria", []);
  assert.ok(offeredTools[0].length > 0);
  assert.equal(offeredTools[0].includes("email_draft"), false);
  assert.equal(offeredTools[0].includes("find_contact"), false);
});

test("on the AI SDK path a tool step shows the tool's own text, not a bare Done", async (t) => {
  const { captured, reasoningService, getMessages } = await renderChatStreaming(
    t,
    {},
    {
      settings: { chatAgentMode: "providers", chatAgentProvider: "openai", chatAgentModel: "gpt-5-mini" },
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
  t.mock.method(reasoningService, "processTextStreamingAI", (_messages, _model, _provider, _config, tools) =>
    (async function* () {
      yield { type: "tool_calls", calls: [{ id: "call-1", name: "find_contact", arguments: "{}" }] };
      await tools.find_contact.execute({ name: "Gab" }, { toolCallId: "call-1", messages: [] });
      // What ReasoningService yields for any object output.
      yield { type: "tool_result", callId: "call-1", toolName: "find_contact", displayText: "Done" };
      yield { type: "done", finishReason: "stop" };
    })()
  );

  await captured.sendToAI("Who is Gab?", []);

  const assistant = getMessages().find((message) => message.role === "assistant");
  assert.equal(assistant.toolCalls[0].result, "Contacts found: 2");
});
