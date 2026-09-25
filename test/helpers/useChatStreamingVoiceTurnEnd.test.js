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

// A voice turn ends when the panel reports the response done. A failed request
// never reached onStreamComplete, so the turn stayed open: nothing was spoken,
// the session never went back to listening and its idle stop never fired.

async function mountChatStreaming(t, { settings, electronAPI = {}, hookOptions = {} }) {
  let unmount;
  t.after(async () => {
    await unmount?.();
  });
  installBrowserGlobals(t, { window: { electronAPI } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-turn-end-test-",
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
  useSettingsStore.setState(settings);

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  const turnEnds = { failed: 0, completed: 0 };
  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      messages,
      setMessages,
      voiceReplies: true,
      onStreamComplete: () => (turnEnds.completed += 1),
      onStreamFailed: () => (turnEnds.failed += 1),
      ...hookOptions,
    });
    return null;
  }
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  unmount = () => React.act(async () => root.unmount());

  return { hook: () => captured, reasoningService, usePolicyStore, turnEnds };
}

// Stands in for a real stream: `run` is where it would call tools or fail.
async function* streamAfter(run) {
  await run();
  yield { type: "content", text: "" };
}

const LOCAL_TOOL_MODEL = {
  chatAgentMode: "self-hosted",
  chatAgentProvider: "lan",
  chatAgentModel: "qwen3-4b-q4_k_m",
  chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
  chatAgentDisableThinking: true,
  isSignedIn: false,
};

test("a failed request ends the voice turn", async (t) => {
  const { hook, reasoningService, turnEnds } = await mountChatStreaming(t, {
    settings: LOCAL_TOOL_MODEL,
  });
  t.mock.method(reasoningService, "processTextStreamingAI", () =>
    streamAfter(() => {
      throw new Error("llama-server failed to start");
    })
  );

  await React.act(async () => {
    await hook().sendToAI("what's on my calendar", []);
  });

  assert.deepEqual(turnEnds, { failed: 1, completed: 0 });
});

test("a request the org policy blocks ends the voice turn", async (t) => {
  const { hook, usePolicyStore, turnEnds } = await mountChatStreaming(t, {
    settings: LOCAL_TOOL_MODEL,
  });
  usePolicyStore.setState({ status: "managed", policy: null });

  await React.act(async () => {
    await hook().sendToAI("what's on my calendar", []);
  });

  assert.deepEqual(turnEnds, { failed: 1, completed: 0 });
});

test("a cancelled request is not reported as failed (barge-in already ended that turn)", async (t) => {
  const { hook, reasoningService, turnEnds } = await mountChatStreaming(t, {
    settings: LOCAL_TOOL_MODEL,
  });
  t.mock.method(reasoningService, "processTextStreamingAI", () =>
    streamAfter(() => {
      hook().cancelStream();
      throw new Error("aborted");
    })
  );

  await React.act(async () => {
    await hook().sendToAI("what's on my calendar", []);
  });

  assert.equal(turnEnds.failed, 0);
});

test("harness dry-run writes change nothing on the OpenWhispr Cloud path either", async (t) => {
  const savedNotes = [];
  const { hook, reasoningService } = await mountChatStreaming(t, {
    settings: { chatAgentMode: "openwhispr", chatAgentModel: "", isSignedIn: true },
    electronAPI: {
      saveNote: async (...args) => {
        savedNotes.push(args);
        return { success: true, note: { id: 1 } };
      },
    },
    hookOptions: { voiceDryRunWrites: true },
  });
  const toolResults = [];
  t.mock.method(reasoningService, "processTextStreamingCloud", (_messages, options) =>
    streamAfter(async () => {
      const args = JSON.stringify({ title: "Dentist", content: "Call the dentist on Friday" });
      toolResults.push(await options.executeToolCall("create_note", args));
    })
  );

  await React.act(async () => {
    await hook().sendToAI("make a note to call the dentist", []);
  });

  assert.equal(toolResults.length, 1);
  assert.match(toolResults[0].data, /"dryRun":true/);
  assert.deepEqual(savedNotes, [], "the harness must not write the user's notes");
});
