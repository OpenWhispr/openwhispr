const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Real end-to-end coverage for useChatStreaming.ts's empty-response fallback
// and its interaction with cancellation (Esc/Stop, or an unmount mid-stream).
// A stream cancelled before any visible token must NOT leave the assistant
// message content set to the fallback string, while a stream that genuinely
// completes with no tokens still MUST get the fallback — otherwise a
// fabricated "The model returned no response." persists into a
// user-cancelled conversation as if the model said it.
//
// This drives the REAL useChatStreaming hook (not a copy of its guard
// logic): `renderToStaticMarkup` runs the hook body once synchronously,
// which is enough to obtain `sendToAI`/`cancelStream` — both plain
// (`useCallback`-wrapped) functions closing over refs, not requiring a live
// fiber to keep working afterward. `setMessages` is supplied by the test
// (useChatStreaming takes it as a prop, not internal state), so its calls
// are observed directly without needing any DOM or reconciliation. Confirmed
// empirically that this repo's harness supports it: no jsdom, no
// `@testing-library/react`, no `act` exist here (`assistantPanel.test.js`
// works around the same absence by stubbing `useChatStreaming` out entirely
// for its markup-only assertions), but this narrower technique — one
// synchronous render, then calling the returned functions like any other
// closures — does not need any of those. The one thing SSR genuinely cannot
// do is run `useEffect` bodies, so the unmount cleanup that also calls
// `cancelStream()` (see useChatStreaming.ts's mount/unmount effect) is
// exercised by code reading, not by this test: it is a single, unconditional
// call to the same `cancelStream` these tests already prove correct.
function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-cancellation-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-4b-q4_k_m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const EMPTY_RESPONSE_TEXT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
).agentMode.chat.emptyResponse;

async function renderChatStreaming(
  t,
  { electronAPI = {}, settings = {}, initialMessages = [] } = {}
) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-cancellation-test-",
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
  usePolicyStore.setState({
    accountId: "account-a",
    authGeneration: 1,
    status: "unmanaged",
    appVersion: "1.8.3",
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
  // A self-hosted (LAN) chat agent with no tools in play: 4B+ in the model
  // name makes it tool-eligible by the size heuristic, but the fixture
  // fetch never emits a tool call, so it stays on the plain-content path.
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    chatAgentDisableThinking: true,
    isSignedIn: false,
    ...settings,
  });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  // useChatStreaming imports ReasoningService.ts, whose default export is a
  // singleton constructed at import time; its API-key cache starts a real
  // setInterval that otherwise keeps the process alive after the test ends.
  t.after(() => reasoningService.destroy());

  let messages = [...initialMessages];
  let responseContentCalls = 0;
  const streamCompletions = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };

  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      messages,
      setMessages,
      onResponseContent: () => {
        responseContentCalls += 1;
      },
      onStreamComplete: (assistantId, content, toolCalls) => {
        streamCompletions.push({ assistantId, content, toolCalls });
      },
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  return {
    captured,
    getMessages: () => messages,
    getResponseContentCalls: () => responseContentCalls,
    getStreamCompletions: () => streamCompletions,
    changeAuthorization: () => {
      useEnterpriseIdentityStore.setState({
        accountId: "account-b",
        workspaceId: "workspace-b",
        authGeneration: 2,
      });
    },
  };
}

test("a genuine empty completion still shows the empty-response fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // No content deltas at all — just an immediate finish + [DONE], the
  // think-only/empty-completion shape the fallback exists for.
  globalThis.fetch = async () => {
    const finishEvent = `data: ${JSON.stringify(createOpenAiChunk({}, "stop"))}\n\n`;
    return new Response(`${finishEvent}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const { captured, getMessages } = await renderChatStreaming(t);

  await captured.sendToAI("hello", []);

  const [message] = getMessages();
  assert.equal(message.content, EMPTY_RESPONSE_TEXT);
  assert.equal(message.isStreaming, false);
});

test("cancelling during RAG setup does not start an assistant reply", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    const finishEvent = `data: ${JSON.stringify(createOpenAiChunk({}, "stop"))}\n\n`;
    return new Response(`${finishEvent}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  let resolveSearch;
  let searchStarted = false;
  const searchResults = new Promise((resolve) => {
    resolveSearch = resolve;
  });
  const { captured, getMessages } = await renderChatStreaming(t, {
    electronAPI: {
      semanticSearchNotes: () => {
        searchStarted = true;
        return searchResults;
      },
    },
  });

  const sendPromise = captured.sendToAI("hello", []);
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !searchStarted; i++) await waitForMicrotasks();
  assert.equal(searchStarted, true, "fixture setup: RAG search must be pending before cancelling");

  captured.cancelStream();
  resolveSearch([]);
  await sendPromise;

  assert.deepEqual(getMessages(), []);
});

test("an authorization change during RAG keeps the user message and never starts a reply", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    const finishEvent = `data: ${JSON.stringify(createOpenAiChunk({}, "stop"))}\n\n`;
    return new Response(`${finishEvent}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  let resolveSearch;
  let searchStarted = false;
  const searchResults = new Promise((resolve) => {
    resolveSearch = resolve;
  });
  const userMessage = { id: "user-rag", role: "user", content: "hello", isStreaming: false };
  const {
    captured,
    getMessages,
    getResponseContentCalls,
    getStreamCompletions,
    changeAuthorization,
  } = await renderChatStreaming(t, {
    initialMessages: [userMessage],
    electronAPI: {
      semanticSearchNotes: () => {
        searchStarted = true;
        return searchResults;
      },
    },
  });

  const sendPromise = captured.sendToAI("hello", [userMessage]);
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !searchStarted; i++) await waitForMicrotasks();
  assert.equal(searchStarted, true, "fixture setup: RAG search must be pending");

  changeAuthorization();
  resolveSearch([]);
  await sendPromise;

  assert.deepEqual(getMessages(), [userMessage]);
  assert.equal(fetchCalls, 0);
  assert.equal(getResponseContentCalls(), 0);
  assert.equal(getStreamCompletions().length, 0);
});

test("cancelling before any token arrives never shows the empty-response fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchStarted = false;
  // A stream that never emits anything, only ending (with an abort error)
  // once the request's AbortSignal fires — i.e. once cancelStream() runs.
  globalThis.fetch = async (_input, init) => {
    fetchStarted = true;
    const body = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const { captured, getMessages, getStreamCompletions } = await renderChatStreaming(t);

  const sendPromise = captured.sendToAI("hello", []);

  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !fetchStarted; i++) await waitForMicrotasks();
  assert.equal(fetchStarted, true, "fixture setup: fetch must have started before cancelling");

  // The same primitive both Esc/Stop and an unmount mid-stream route
  // through — see useChatStreaming.ts's cancelStream and its mount/unmount
  // effect, which now calls cancelStream() instead of cancelling the
  // ReasoningService stream directly.
  captured.cancelStream();

  await sendPromise;

  const [message] = getMessages();
  assert.notEqual(message.content, EMPTY_RESPONSE_TEXT);
  assert.equal(message.content, "");
  assert.equal(message.isStreaming, false);
  assert.equal(
    getStreamCompletions().length,
    1,
    "manual Stop keeps the existing partial-reply persistence lifecycle"
  );
});

test("an authorization change discards a partial local reply without persisting it", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let tokenSent = false;
  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(createOpenAiChunk({ content: "partial" }))}\n\n`
          )
        );
        tokenSent = true;
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const userMessage = { id: "user-partial", role: "user", content: "hello", isStreaming: false };
  const {
    captured,
    getMessages,
    getResponseContentCalls,
    getStreamCompletions,
    changeAuthorization,
  } = await renderChatStreaming(t, { initialMessages: [userMessage] });
  const sendPromise = captured.sendToAI("hello", [userMessage]);
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !getMessages().some((message) => message.content === "partial"); i++) {
    await waitForMicrotasks();
  }
  assert.equal(tokenSent, true, "fixture setup: the local stream must emit a token");
  assert.equal(getMessages().at(-1)?.content, "partial");

  changeAuthorization();
  await sendPromise;

  assert.deepEqual(getMessages(), [userMessage]);
  assert.equal(getResponseContentCalls(), 1, "already displayed content is announced exactly once");
  assert.equal(getStreamCompletions().length, 0);
});

test("an authorization change during an AI-SDK tool setup blocks its later side effect", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls += 1;
    const toolEvent = `data: ${JSON.stringify(
      createOpenAiChunk({
        tool_calls: [
          {
            index: 0,
            id: "create-note-1",
            type: "function",
            function: {
              name: "create_note",
              arguments: JSON.stringify({ title: "Private", content: "Do not persist" }),
            },
          },
        ],
      })
    )}\n\n`;
    const finishEvent = `data: ${JSON.stringify(createOpenAiChunk({}, "tool_calls"))}\n\n`;
    return new Response(`${toolEvent}${finishEvent}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  let resolveSpaces;
  let spacesStarted = false;
  const spaces = new Promise((resolve) => {
    resolveSpaces = resolve;
  });
  const saveNoteCalls = [];
  const userMessage = { id: "user-ai-tool", role: "user", content: "create", isStreaming: false };
  const { captured, getMessages, getStreamCompletions, changeAuthorization } =
    await renderChatStreaming(t, {
      initialMessages: [userMessage],
      electronAPI: {
        getSpaces: () => {
          spacesStarted = true;
          return spaces;
        },
        saveNote: (...args) => {
          saveNoteCalls.push(args);
          return Promise.resolve({ success: false });
        },
      },
    });

  const sendPromise = captured.sendToAI("create", [userMessage]);
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !spacesStarted; i++) await waitForMicrotasks();
  assert.equal(spacesStarted, true, "fixture setup: the AI-SDK tool must be awaiting space setup");

  changeAuthorization();
  resolveSpaces([]);
  await sendPromise;

  assert.equal(
    saveNoteCalls.length,
    0,
    "no tool side effect may start after authorization changes"
  );
  assert.equal(modelCalls, 1, "the tool result must not start another model step");
  assert.deepEqual(getMessages(), [userMessage]);
  assert.equal(getStreamCompletions().length, 0);
});

test("cancelling a tool-ineligible raw stream after reading starts shows no error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let readerStarted = false;
  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream({
      pull() {
        readerStarted = true;
      },
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const { captured, getMessages, getResponseContentCalls } = await renderChatStreaming(t, {
    settings: { chatAgentModel: "qwen3-1.7b-q4_k_m" },
  });
  const sendPromise = captured.sendToAI("hello", []);
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !readerStarted; i++) await waitForMicrotasks();
  assert.equal(readerStarted, true, "fixture setup: the raw response reader must be pending");

  captured.cancelStream();
  await sendPromise;

  const [message] = getMessages();
  assert.equal(message.content, "");
  assert.equal(message.isStreaming, false);
  assert.equal(getResponseContentCalls(), 0, "a user cancellation must not announce an error");
});

test("cloud screen context is sent without claiming the screenshot is already attached", async (t) => {
  let streamEndListener;
  let streamOptions;
  const electronAPI = {
    onAgentStreamChunk() {
      return () => {};
    },
    onAgentStreamError() {
      return () => {};
    },
    onAgentStreamEnd(listener) {
      streamEndListener = listener;
      return () => {};
    },
    startAgentStream(requestId, _messages, options) {
      streamOptions = options;
      streamEndListener({ requestId });
    },
    cancelAgentStream() {},
  };
  const { captured } = await renderChatStreaming(t, {
    electronAPI,
    settings: {
      chatAgentMode: "openwhispr",
      chatAgentCloudMode: "openwhispr",
      isSignedIn: true,
    },
  });

  await captured.sendToAI(
    "What is on screen?",
    [{ id: "user-1", role: "user", content: "What is on screen?", isStreaming: false }],
    { attachment: { image: "base64-image", mediaType: "image/png" } }
  );

  assert.deepEqual(streamOptions.screenContext, {
    data: "base64-image",
    mediaType: "image/png",
  });
  assert.doesNotMatch(streamOptions.systemPrompt, /SCREEN CONTEXT:/);
});

test("an authorization change during a cloud tool prevents the next model step and persistence", async (t) => {
  let streamChunkListener;
  let streamEndListener;
  const startCalls = [];
  let resolveClipboard;
  let clipboardStarted = false;
  const clipboard = new Promise((resolve) => {
    resolveClipboard = resolve;
  });
  const electronAPI = {
    onAgentStreamChunk(listener) {
      streamChunkListener = listener;
      return () => {};
    },
    onAgentStreamError() {
      return () => {};
    },
    onAgentStreamEnd(listener) {
      streamEndListener = listener;
      return () => {};
    },
    startAgentStream(requestId) {
      startCalls.push(requestId);
      streamChunkListener({
        requestId,
        chunk: {
          type: "tool_call",
          id: "tool-call-1",
          name: "copy_to_clipboard",
          arguments: JSON.stringify({ text: "sensitive output" }),
        },
      });
      streamEndListener({ requestId });
    },
    cancelAgentStream() {},
    async writeClipboard() {
      clipboardStarted = true;
      await clipboard;
    },
  };
  const userMessage = { id: "user-tool", role: "user", content: "copy it", isStreaming: false };
  const { captured, getMessages, getStreamCompletions, changeAuthorization } =
    await renderChatStreaming(t, {
      electronAPI,
      initialMessages: [userMessage],
      settings: {
        chatAgentMode: "openwhispr",
        chatAgentCloudMode: "openwhispr",
        isSignedIn: true,
      },
    });

  const sendPromise = captured.sendToAI("copy it", [userMessage]);
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !clipboardStarted; i++) await waitForMicrotasks();
  assert.equal(clipboardStarted, true, "fixture setup: cloud tool execution must be pending");
  assert.equal(startCalls.length, 1);

  changeAuthorization();
  resolveClipboard();
  await sendPromise;

  assert.deepEqual(getMessages(), [userMessage]);
  assert.equal(startCalls.length, 1, "authorization invalidation must prevent another model step");
  assert.equal(getStreamCompletions().length, 0);
});

test("an authorization change after genuine completion leaves the completed reply intact", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    const contentEvent = `data: ${JSON.stringify(createOpenAiChunk({ content: "complete" }))}\n\n`;
    return new Response(`${contentEvent}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const userMessage = { id: "user-complete", role: "user", content: "hello", isStreaming: false };
  const { captured, getMessages, getStreamCompletions, changeAuthorization } =
    await renderChatStreaming(t, { initialMessages: [userMessage] });

  await captured.sendToAI("hello", [userMessage]);
  const completedMessages = structuredClone(getMessages());
  assert.equal(getStreamCompletions().length, 1);

  changeAuthorization();

  assert.deepEqual(getMessages(), completedMessages);
  assert.equal(getStreamCompletions().length, 1);
});
