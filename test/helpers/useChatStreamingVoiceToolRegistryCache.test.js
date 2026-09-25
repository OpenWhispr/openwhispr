const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const fs = require("node:fs");
const path = require("node:path");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Task 5 / controller ruling R4: the tool registry is cached in toolRegistryRef
// under a cache key built from settings alone. voiceReplies changes which tools
// the registry may offer (voice turns exclude update_snippets — see
// voiceToolPolicy.ts), but voiceReplies isn't a "settings" value, so a registry
// built for a typed turn (no exclusion) could get reused for a later voice turn
// on the SAME hook instance, unless voiceReplies is folded into the cache key.
//
// This drives the real hook across two renders of the same component instance
// (refs, including toolRegistryRef, persist across a re-render) so the second
// sendToAI call sees whatever registry the first call's cache entry left behind.
test("a typed turn's cached registry is not reused for a later voice turn (update_snippets stays excluded)", async (t) => {
  // Registered before installBrowserGlobals/installHookDom so it runs first on
  // cleanup (Node's t.after runs in registration order) — the root must unmount
  // while window/document still exist.
  let unmount;
  t.after(async () => {
    await unmount?.();
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-tool-registry-cache-test-",
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
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  // Self-hosted 4B+ model: tool-eligible by the size heuristic, matching the
  // recipe other useChatStreaming tests use to exercise the registry path.
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    chatAgentDisableThinking: true,
    isSignedIn: false,
  });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  // Registry creation happens before the stream starts; an empty stream is
  // enough to let sendToAI run to completion without exercising tool calls.
  t.mock.method(reasoningService, "processTextStreamingAI", async function* () {});

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  const toolsAvailableCalls = [];
  const options = { voiceReplies: false };

  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      messages,
      setMessages,
      voiceReplies: options.voiceReplies,
      onToolsAvailable: (toolNames) => toolsAvailableCalls.push(toolNames),
    });
    return null;
  }

  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  unmount = () => React.act(async () => root.unmount());

  // First turn: typed chat. Populates toolRegistryRef's cache with a registry
  // that has NOT excluded update_snippets (voiceReplies was false when built).
  await React.act(async () => {
    await captured.sendToAI("edit my snippets", []);
  });
  assert.deepEqual(toolsAvailableCalls, [], "onToolsAvailable only fires for voice turns");

  // Re-render the SAME component instance as a voice turn — refs (including
  // toolRegistryRef) persist across this re-render, only their values change.
  options.voiceReplies = true;
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => {
    await captured.sendToAI("read my snippet back", []);
  });

  assert.equal(toolsAvailableCalls.length, 1);
  assert.ok(
    !toolsAvailableCalls[0].includes("update_snippets"),
    `voice turn must not offer update_snippets, got: ${toolsAvailableCalls[0].join(", ")}`
  );
});
