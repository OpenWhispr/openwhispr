const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-mounted-persistence-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-1.7b-q4_k_m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function mountPersistedChat(t) {
  const addedMessages = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        addAgentMessage: (...args) => addedMessages.push(args),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-mounted-chat-persistence-auth-test-",
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
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-1.7b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    chatAgentDisableThinking: true,
    isSignedIn: false,
  });
  usePolicyStore.setState({
    accountId: "account-a",
    authGeneration: 1,
    status: "unmanaged",
    appVersion: "1.8.4",
    policy: null,
  });
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: null,
    lastKnownLocalModels: null,
    lastKnownLocalModelsKnown: true,
    error: null,
    failClosed: false,
  });

  const [{ useChatPersistence }, { useChatStreaming }] = await Promise.all([
    vite.ssrLoadModule("/components/chat/useChatPersistence.ts"),
    vite.ssrLoadModule("/components/chat/useChatStreaming.ts"),
  ]);
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  let current;
  let root = createRoot(container);

  function Harness() {
    const persistence = useChatPersistence({ conversationId: 42 });
    const streaming = useChatStreaming({
      messages: persistence.messages,
      setMessages: persistence.setMessages,
      onStreamComplete: (_assistantId, content, toolCalls) => {
        persistence.saveAssistantMessage(content, toolCalls);
      },
    });
    current = { persistence, streaming };
    return null;
  }

  await React.act(async () => root.render(React.createElement(Harness)));
  t.after(() => reasoningService.destroy());
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const userMessage = { id: "user-mounted", role: "user", content: "hello", isStreaming: false };
  await React.act(async () => current.persistence.setMessages([userMessage]));

  return {
    addedMessages,
    getCurrent: () => current,
    unmount: async () => {
      if (!root) return;
      const mountedRoot = root;
      root = null;
      await React.act(async () => mountedRoot.unmount());
    },
    changeAuthorization: async () => {
      await React.act(async () => {
        useEnterpriseIdentityStore.setState({
          accountId: "account-b",
          workspaceId: "workspace-b",
          authGeneration: 2,
        });
      });
    },
    userMessage,
  };
}

function installPartialStream(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(createOpenAiChunk({ content: "partial" }))}\n\n`
          )
        );
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

async function startAndWaitForPartial(chat) {
  let sendPromise;
  await React.act(async () => {
    sendPromise = chat.getCurrent().streaming.sendToAI("hello", [chat.userMessage]);
    await new Promise((resolve) => setImmediate(resolve));
  });
  for (
    let i = 0;
    i < 50 && chat.getCurrent().persistence.messages.at(-1)?.content !== "partial";
    i++
  ) {
    await React.act(async () => new Promise((resolve) => setImmediate(resolve)));
  }
  assert.equal(
    chat.getCurrent().persistence.messages.at(-1)?.content,
    "partial",
    "fixture setup: mounted chat must render a partial assistant reply"
  );
  return { sendPromise };
}

test("mounted ChatView persistence never writes an assistant after authorization changes", async (t) => {
  installPartialStream(t);
  const chat = await mountPersistedChat(t);
  const { sendPromise } = await startAndWaitForPartial(chat);

  await chat.changeAuthorization();
  await React.act(async () => sendPromise);

  assert.deepEqual(chat.addedMessages, []);
  assert.deepEqual(chat.getCurrent().persistence.messages, [chat.userMessage]);
  await chat.unmount();
});

test("mounted manual Stop preserves partial assistant persistence", async (t) => {
  installPartialStream(t);
  const chat = await mountPersistedChat(t);
  const { sendPromise } = await startAndWaitForPartial(chat);

  React.act(() => chat.getCurrent().streaming.cancelStream());
  await React.act(async () => sendPromise);

  assert.deepEqual(chat.addedMessages, [[42, "assistant", "partial", undefined]]);
  await chat.unmount();
});

test("mounted unmount runs stream cleanup and preserves the partial reply lifecycle", async (t) => {
  installPartialStream(t);
  const chat = await mountPersistedChat(t);
  const { sendPromise } = await startAndWaitForPartial(chat);

  await chat.unmount();
  await sendPromise;

  assert.deepEqual(chat.addedMessages, [[42, "assistant", "partial", undefined]]);
});
