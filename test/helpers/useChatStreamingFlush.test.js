const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Keep the real SSE transport smoke test alongside controlled hook tests:
// acknowledging a yielded chunk lets us test a pending flush without sleeps.
function createControlledStream() {
  let next = Promise.withResolvers();
  let ended = false;
  return {
    async *read() {
      while (true) {
        const { chunk, error, done, consumed } = await next.promise;
        next = Promise.withResolvers();
        if (error) throw error;
        if (done) return;
        yield chunk;
        consumed.resolve();
      }
    },
    async emit(chunk) {
      assert.equal(ended, false, "cannot emit after ending the fixture stream");
      const consumed = Promise.withResolvers();
      next.resolve({ chunk, consumed });
      await consumed.promise;
    },
    end(error) {
      if (ended) return;
      ended = true;
      next.resolve({ done: true, error });
    },
  };
}

function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-cancellation-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-4b-q4_k_m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function renderChatStreaming(
  t,
  {
    electronAPI = {},
    settings = {},
    onStreamComplete,
    onResponseContent,
    live = false,
    stream,
    abortThrows = false,
  } = {}
) {
  let unmount;
  // Node runs after hooks in registration order; unmount while the DOM exists.
  t.after(async () => {
    stream?.end();
    await unmount?.();
    t.mock.timers.reset();
  });
  installBrowserGlobals(t, { window: { electronAPI } });
  const container = live ? installHookDom(t) : null;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-flush-test-",
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
  // The 4B model enables tool handling for both the SSE and controlled streams.
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
  if (stream) {
    t.mock.method(reasoningService, "processTextStreamingAI", () => stream.read());
    t.mock.method(reasoningService, "cancelActiveStream", () =>
      stream.end(abortThrows ? new DOMException("aborted", "AbortError") : undefined)
    );
  }

  let messages = [];
  let committedMessages = [];
  let renderMessages;
  let responseContentCalls = 0;
  let contentWrites = 0;
  let dispatches = 0;
  const snapshots = [];
  const setMessages = (updater) => {
    dispatches += 1;
    const next = typeof updater === "function" ? updater(messages) : updater;
    const prevAssistant = messages.find((m) => m.role === "assistant");
    const nextAssistant = next.find((m) => m.role === "assistant");
    if (prevAssistant && nextAssistant && prevAssistant.content !== nextAssistant.content) {
      contentWrites += 1;
    }
    messages = next;
    snapshots.push(next);
    renderMessages?.(next);
  };

  let captured = null;
  function Harness() {
    const [stateMessages, setStateMessages] = React.useState([]);
    renderMessages = live ? setStateMessages : undefined;
    React.useEffect(() => {
      committedMessages = stateMessages;
    }, [stateMessages]);
    captured = useChatStreaming({
      messages: live ? stateMessages : messages,
      setMessages,
      onStreamComplete,
      onResponseContent: () => {
        responseContentCalls += 1;
        onResponseContent?.();
      },
    });
    return null;
  }

  if (live) {
    const { createRoot } = require("react-dom/client");
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    let unmounted = false;
    unmount = async () => {
      if (unmounted) return;
      unmounted = true;
      await React.act(async () => root.unmount());
    };
  } else {
    renderToStaticMarkup(React.createElement(Harness));
  }

  return {
    captured,
    getMessages: () => messages,
    getCommittedMessages: () => committedMessages,
    getAgentState: () => captured.agentState,
    getResponseContentCalls: () => responseContentCalls,
    getContentWrites: () => contentWrites,
    getDispatches: () => dispatches,
    snapshots,
    unmount,
  };
}

async function startControlledChat(t, { abortThrows = false } = {}) {
  const stream = createControlledStream();
  const persisted = [];
  const delivered = [];
  const harness = await renderChatStreaming(t, {
    live: true,
    stream,
    abortThrows,
    onStreamComplete: (assistantId, content, toolCalls) =>
      persisted.push({ assistantId, content, toolCalls }),
  });
  // Enable after Vite/React setup so only the request's timers use the fake clock.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let completion;
  await React.act(async () => {
    completion = harness.captured.sendToAI("hello", [], {
      onComplete: (result) => delivered.push(result),
    });
  });
  return {
    ...harness,
    persisted,
    delivered,
    emit: (chunk) => React.act(async () => stream.emit(chunk)),
    tick: (milliseconds) => React.act(async () => t.mock.timers.tick(milliseconds)),
    finish: (error) =>
      React.act(async () => {
        stream.end(error);
        await completion;
      }),
    cancel: () =>
      React.act(async () => {
        harness.captured.cancelStream();
        await completion;
      }),
    navigate: async () => {
      await harness.unmount();
      await completion;
    },
  };
}

async function assertNoLateWrites(harness) {
  const dispatches = harness.getDispatches();
  const messages = harness.getMessages();
  await harness.tick(1000);
  assert.equal(harness.getDispatches(), dispatches, "no timer dispatches after termination");
  assert.deepEqual(harness.getMessages(), messages);
}

const ERROR_PREFIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
).agentMode.chat.errorPrefix;

function sseEvent(delta, finishReason = null) {
  return `data: ${JSON.stringify(createOpenAiChunk(delta, finishReason))}\n\n`;
}

function stubFetch(t, body) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("fifty streamed tokens produce a handful of content writes, and the final text is intact", async (t) => {
  const deltas = Array.from({ length: 50 }, (_, i) => `tok${i} `);
  stubFetch(
    t,
    deltas.map((text) => sseEvent({ content: text })).join("") +
      sseEvent({}, "stop") +
      "data: [DONE]\n\n"
  );
  const harness = await renderChatStreaming(t);

  await harness.captured.sendToAI("count to fifty", harness.getMessages());

  const assistant = harness.getMessages().find((m) => m.role === "assistant");
  assert.equal(assistant.content, deltas.join(""), "every token is in the final text");
  assert.equal(assistant.isStreaming, false);
  assert.ok(
    harness.getContentWrites() <= 3,
    `expected at most 3 content writes for 50 tokens, got ${harness.getContentWrites()}`
  );
});

test(
  "an SSE error after a parsed token keeps the error instead of a late partial flush",
  { timeout: 15000 },
  async (t) => {
    const tokenConsumed = Promise.withResolvers();
    const encoder = new TextEncoder();
    stubFetch(
      t,
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(sseEvent({ content: "Partial reply" })));
          await tokenConsumed.promise;
          controller.error(new Error("boom"));
        },
      })
    );
    const harness = await renderChatStreaming(t, { onResponseContent: tokenConsumed.resolve });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await harness.captured.sendToAI("fail please", []);
    assert.equal(harness.getResponseContentCalls(), 1, "the token reached the hook before failure");
    assert.equal(
      harness.getContentWrites(),
      1,
      "only the error was written before the clock advanced"
    );
    assert.equal(harness.getMessages()[0].content, `${ERROR_PREFIX}: boom`);
    assert.equal(harness.getMessages()[0].isStreaming, false);
    const dispatches = harness.getDispatches();
    t.mock.timers.tick(1000);
    assert.equal(harness.getDispatches(), dispatches, "the pending flush was cancelled");
    assert.equal(harness.getMessages()[0].content, `${ERROR_PREFIX}: boom`);
  }
);

test("paced tokens flush during the stream, rearm the timer, and persist the final tail", async (t) => {
  const harness = await startControlledChat(t);
  const initialDispatches = harness.getDispatches();
  await harness.emit({ type: "content", text: "First " });
  await harness.tick(16);
  await harness.emit({ type: "content", text: "batch" });
  await harness.tick(15);
  assert.equal(harness.getDispatches(), initialDispatches);
  assert.equal(harness.getCommittedMessages()[0].content, "");

  await harness.tick(1);
  assert.equal(harness.getDispatches(), initialDispatches + 1);
  assert.equal(harness.getCommittedMessages()[0].content, "First batch");
  assert.equal(harness.getCommittedMessages()[0].isStreaming, true);
  assert.deepEqual(harness.persisted, []);
  assert.deepEqual(harness.delivered, []);

  await harness.emit({ type: "content", text: ", second" });
  await harness.tick(31);
  assert.equal(harness.getDispatches(), initialDispatches + 1);
  await harness.tick(1);
  assert.equal(harness.getDispatches(), initialDispatches + 2);
  assert.equal(harness.getCommittedMessages()[0].content, "First batch, second");
  await harness.emit({ type: "content", text: ", tail" });
  await harness.finish();

  const [assistant] = harness.getCommittedMessages();
  assert.equal(assistant.content, "First batch, second, tail");
  assert.equal(assistant.isStreaming, false);
  assert.equal(harness.getAgentState(), "idle");
  assert.deepEqual(harness.persisted, [
    {
      assistantId: assistant.id,
      content: assistant.content,
      toolCalls: undefined,
    },
  ]);
  assert.deepEqual(harness.delivered, harness.persisted);
  assert.equal(harness.getResponseContentCalls(), 1);
  await assertNoLateWrites(harness);
});

for (const abortThrows of [false, true]) {
  test(`Stop flushes a pending token when abort ${abortThrows ? "throws" : "ends the stream"}`, async (t) => {
    const harness = await startControlledChat(t, { abortThrows });
    await harness.emit({ type: "content", text: "Partial reply" });
    assert.equal(harness.getResponseContentCalls(), 1, "the hook consumed the token");
    assert.equal(harness.getCommittedMessages()[0].content, "", "the timer has not fired");
    await harness.cancel();
    assert.equal(harness.getCommittedMessages()[0].content, "Partial reply");
    assert.equal(harness.getCommittedMessages()[0].isStreaming, false);
    assert.equal(harness.getAgentState(), "idle");
    assert.deepEqual(harness.persisted, []);
    assert.deepEqual(harness.delivered, []);
    await assertNoLateWrites(harness);
  });
}

test("unmount before the first flush preserves the received partial reply without delivery", async (t) => {
  const harness = await startControlledChat(t);
  await harness.emit({ type: "content", text: "Partial reply" });
  assert.equal(harness.getResponseContentCalls(), 1);
  assert.equal(harness.getCommittedMessages()[0].content, "");
  const assistantId = harness.getMessages()[0].id;
  await harness.navigate();
  assert.equal(harness.getMessages()[0].content, "Partial reply");
  assert.deepEqual(harness.persisted, [
    {
      assistantId,
      content: "Partial reply",
      toolCalls: undefined,
    },
  ]);
  assert.equal(harness.getMessages()[0].isStreaming, false);
  assert.deepEqual(harness.delivered, []);
  await assertNoLateWrites(harness);
});

test("an error after a consumed token cancels its pending flush", async (t) => {
  const harness = await startControlledChat(t);
  await harness.emit({ type: "content", text: "Partial reply" });
  assert.equal(harness.getResponseContentCalls(), 1, "the hook consumed the token before failure");
  assert.equal(harness.getCommittedMessages()[0].content, "");
  await harness.finish(new Error("boom"));
  assert.equal(harness.getCommittedMessages()[0].content, `${ERROR_PREFIX}: boom`);
  assert.equal(harness.getCommittedMessages()[0].isStreaming, false);
  assert.deepEqual(harness.persisted, []);
  assert.deepEqual(harness.delivered, []);
  await assertNoLateWrites(harness);
});

for (const withContent of [true, false]) {
  test(`${withContent ? "text and tool" : "tool-only"} replies preserve boundary ordering and persisted metadata`, async (t) => {
    const harness = await startControlledChat(t);
    const call = { id: "search-1", name: "search_notes", arguments: '{"query":"meeting"}' };
    const metadata = [{ id: 42, title: "Meeting" }];
    if (withContent) await harness.emit({ type: "content", text: "Searching notes. " });
    const content = withContent ? "Searching notes. " : "";
    await harness.emit({ type: "tool_calls", calls: [call] });

    const firstToolSnapshot = harness.snapshots.findIndex(
      (messages) => messages[0]?.toolCalls?.length
    );
    assert.ok(firstToolSnapshot > 0);
    assert.equal(
      harness.snapshots[firstToolSnapshot - 1][0].content,
      content,
      "pending text is dispatched before the tool call"
    );
    assert.equal(harness.getCommittedMessages()[0].content, content);
    assert.equal(harness.getAgentState(), "tool-executing");
    assert.deepEqual(harness.getCommittedMessages()[0].toolCalls, [
      { ...call, status: "executing" },
    ]);

    await harness.emit({
      type: "tool_result",
      callId: call.id,
      toolName: call.name,
      displayText: "Found one note",
      metadata,
    });
    const toolCalls = [{ ...call, status: "completed", result: "Found one note", metadata }];
    assert.deepEqual(harness.getCommittedMessages()[0].toolCalls, toolCalls);
    assert.equal(harness.getAgentState(), "streaming");
    if (withContent) await harness.emit({ type: "content", text: "Found it." });
    await harness.finish();
    const [assistant] = harness.getCommittedMessages();
    assert.equal(assistant.content, withContent ? "Searching notes. Found it." : "");
    assert.equal(assistant.isStreaming, false);
    assert.deepEqual(assistant.toolCalls, toolCalls);
    assert.deepEqual(harness.persisted, [
      { assistantId: assistant.id, content: assistant.content, toolCalls },
    ]);
    assert.deepEqual(harness.delivered, withContent ? harness.persisted : []);
    assert.equal(harness.getResponseContentCalls(), 1);
    await assertNoLateWrites(harness);
  });
}

test("plainTextResponse appends the plain-text instruction to the system prompt", async (t) => {
  const requestBodies = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    requestBodies.push(String(init?.body));
    return new Response(sseEvent({ content: "ok" }, "stop") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const harness = await renderChatStreaming(t);

  await harness.captured.sendToAI("draft a reply", [], { plainTextResponse: true });
  await harness.captured.sendToAI("draft a reply", []);

  assert.equal(requestBodies.length, 2);
  assert.match(requestBodies[0], /OUTPUT FORMAT:/);
  assert.doesNotMatch(requestBodies[1], /OUTPUT FORMAT:/);
});
