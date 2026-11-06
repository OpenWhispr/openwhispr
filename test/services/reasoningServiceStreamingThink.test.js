const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function createRawSseResponse(chunks, { includeDone = true } = {}) {
  const events = chunks
    .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    .join("");
  const done = includeDone ? "data: [DONE]\n\n" : "";
  return new Response(`${events}${done}`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-streaming-think-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-4b-q4_k_m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function createOpenAiSseResponse(chunks, { finishReason = "stop", toolCall } = {}) {
  const events = chunks
    .map((content) => `data: ${JSON.stringify(createOpenAiChunk({ content }))}\n\n`)
    .join("");
  const toolEvent = toolCall
    ? `data: ${JSON.stringify(
        createOpenAiChunk({
          tool_calls: [
            {
              index: 0,
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.arguments },
            },
          ],
        })
      )}\n\n`
    : "";
  const finishEvent = `data: ${JSON.stringify(createOpenAiChunk({}, finishReason))}\n\n`;
  return new Response(`${events}${toolEvent}${finishEvent}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function loadReasoningService(t, cachePrefix, { window = {} } = {}) {
  installBrowserGlobals(t, { window });
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  t.after(() => reasoningService.destroy());
  return { reasoningService, vite };
}

async function collectRawText(stream) {
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}

async function collectAgentText(stream) {
  let output = "";
  for await (const chunk of stream) {
    if (chunk.type === "content") output += chunk.text;
  }
  return output;
}

test("local streams reject buffered old-policy and old-identity deltas on both transports", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-buffered-policy-stream-test-",
    {
      window: { electronAPI: { llamaServerStart: async () => ({ success: true, port: 11434 }) } },
    }
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { managedPolicy } = require("../helpers/harness/policyFixtures");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const sdk of [false, true]) {
    for (const changeIdentity of [false, true]) {
      for (const completion of [false, true]) {
        await t.test(
          `${sdk ? "SDK" : "raw"} ${changeIdentity ? "identity switch" : "model revocation"} ${completion ? "completion" : "content"}`,
          async () => {
            usePolicyStore.setState({
              status: "unmanaged",
              policy: null,
              accountId: "first",
              authGeneration: 1,
            });
            globalThis.fetch = async () =>
              sdk
                ? createOpenAiSseResponse(completion ? ["first"] : ["first", "forbidden"])
                : createRawSseResponse(completion ? ["first"] : ["first", "forbidden"]);
            const args = [
              [{ role: "user", content: "hi" }],
              "qwen3-4b-q4_k_m",
              "local",
              { systemPrompt: "s", disableThinking: true },
            ];
            const stream = sdk
              ? reasoningService.processTextStreamingAI(...args, {})
              : reasoningService.processTextStreaming(...args);
            t.after(() => stream.return());
            const first = await stream.next();
            assert.equal(sdk ? first.value.text : first.value, "first");
            if (changeIdentity) usePolicyStore.setState({ accountId: "second", authGeneration: 2 });
            else
              usePolicyStore.setState({
                status: "managed",
                policy: {
                  ...managedPolicy({ llm: { allowedModes: ["local"], allowedLocalModels: [] } }),
                  features: { agentEnabled: true, webSearchEnabled: false },
                },
              });
            await assert.rejects(stream.next(), {
              code: changeIdentity ? "POLICY_UNRESOLVABLE" : "POLICY_MODEL_BLOCKED",
            });
          }
        );
      }
    }
  }
});

test("a same-account token rotation never ends a running stream, whatever its transport", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-rotation-stream-test-",
    {
      window: {
        electronAPI: {
          llamaServerStart: async () => ({ success: true, port: 11434 }),
          // A rotated credential's verdict is still on its way.
          getWorkspacePolicy: () => new Promise(() => {}),
          getAppVersion: async () => ({ version: "1.11.1" }),
        },
      },
    }
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let generation = 1;
  for (const sdk of [false, true]) {
    for (const [label, provider, lanUrl] of [
      ["local", "local", undefined],
      ["LAN", "lan", "http://192.168.1.20:8080"],
      ["BYOK", "custom", undefined],
    ]) {
      await t.test(`${sdk ? "SDK" : "raw"} ${label}`, async () => {
        usePolicyStore.setState({
          status: "unmanaged",
          policy: null,
          accountId: "same",
          authGeneration: generation,
        });
        globalThis.fetch = async () =>
          sdk
            ? createOpenAiSseResponse(["first", "second"])
            : createRawSseResponse(["first", "second"]);
        const args = [
          [{ role: "user", content: "hi" }],
          "qwen3-4b-q4_k_m",
          provider,
          {
            systemPrompt: "s",
            disableThinking: true,
            ...(lanUrl ? { lanUrl } : {}),
            ...(provider === "custom"
              ? { baseUrl: "http://192.168.1.20:8080/v1", customApiKey: "k" }
              : {}),
          },
        ];
        const stream = sdk
          ? reasoningService.processTextStreamingAI(...args, {})
          : reasoningService.processTextStreaming(...args);
        t.after(() => stream.return());
        const first = await stream.next();
        assert.equal(sdk ? first.value.text : first.value, "first");

        generation += 1;
        void usePolicyStore.getState().fetchPolicy("same", generation);
        assert.equal(usePolicyStore.getState().authGeneration, generation);
        assert.equal(usePolicyStore.getState().status, "unmanaged");
        const second = await stream.next();
        assert.equal(sdk ? second.value.text : second.value, "second");
      });
    }
  }
});

test("a stream ends only on a settled denial or a lost account, and then closes its request", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-stream-unresolved-test-",
    {
      window: {
        electronAPI: {
          llamaServerStart: async () => ({ success: true, port: 11434 }),
          getAppVersion: async () => ({ version: "1.11.1" }),
        },
      },
    }
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const sdk of [false, true]) {
    for (const [label, change, ending] of [
      ["an unresolved verdict keeps it", () => ({ status: "error" }), null],
      ["a suspended policy keeps it", () => ({ status: "loading", accountId: null }), null],
      ["signing in from a guest keeps it", () => ({ accountId: "new" }), null],
      ["signing out ends it", () => ({ status: "idle", accountId: null }), "POLICY_UNRESOLVABLE"],
      ["another account ends it", () => ({ accountId: "other" }), "POLICY_UNRESOLVABLE"],
    ]) {
      await t.test(`${sdk ? "SDK" : "raw"}: ${label}`, async () => {
        const startsAsGuest = label.startsWith("signing in");
        usePolicyStore.setState({
          status: startsAsGuest ? "idle" : "unmanaged",
          managed: false,
          policy: null,
          accountId: startsAsGuest ? null : "same",
          authGeneration: 1,
        });
        let requestSignal;
        globalThis.fetch = async (_url, init) => {
          requestSignal = init?.signal;
          return sdk
            ? createOpenAiSseResponse(["first", "second"])
            : createRawSseResponse(["first", "second"]);
        };
        const args = [
          [{ role: "user", content: "hi" }],
          "m",
          "lan",
          { systemPrompt: "s", disableThinking: true, lanUrl: "http://192.168.1.20:8080" },
        ];
        const stream = sdk
          ? reasoningService.processTextStreamingAI(...args, {})
          : reasoningService.processTextStreaming(...args);
        t.after(() => stream.return());
        const first = await stream.next();
        assert.equal(sdk ? first.value.text : first.value, "first");

        usePolicyStore.setState(change());
        if (ending) {
          await assert.rejects(stream.next(), (error) => {
            assert.equal(error.code, ending);
            assert.equal(error.messageKey, "common.policyAccountChanged");
            return true;
          });
          assert.equal(requestSignal?.aborted, true);
        } else {
          const second = await stream.next();
          assert.equal(sdk ? second.value.text : second.value, "second");
        }
      });
    }
  }
});

test("local streaming transport shutdown retains a newly learned policy refusal", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-policy-stream-error-test-",
    {
      window: { electronAPI: { llamaServerStart: async () => ({ success: true, port: 11434 }) } },
    }
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { managedPolicy } = require("../helpers/harness/policyFixtures");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const sdk of [false, true]) {
    await t.test(sdk ? "SDK shutdown" : "raw shutdown", async () => {
      usePolicyStore.setState({ status: "unmanaged", policy: null });
      let fail;
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const event = sdk
                ? createOpenAiChunk({ content: "first" })
                : { choices: [{ delta: { content: "first" } }] };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
              fail = () => controller.error(new TypeError("server stopped"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      const args = [
        [{ role: "user", content: "hi" }],
        "qwen3-4b-q4_k_m",
        "local",
        { systemPrompt: "s", disableThinking: true },
      ];
      const stream = sdk
        ? reasoningService.processTextStreamingAI(...args, {})
        : reasoningService.processTextStreaming(...args);
      await stream.next();
      usePolicyStore.setState({
        status: "managed",
        policy: {
          ...managedPolicy({ llm: { allowedModes: ["local"], allowedLocalModels: [] } }),
          features: { agentEnabled: true, webSearchEnabled: false },
        },
      });
      fail();
      await assert.rejects(stream.next(), { code: "POLICY_MODEL_BLOCKED" });
    });
  }
});

test("an identity switch during local stream setup prevents either transport from dispatching", async (t) => {
  let finishSetup;
  let startedSetup;
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-policy-stream-setup-test-",
    {
      window: {
        electronAPI: {
          llamaServerStart: () => {
            startedSetup();
            return new Promise((resolve) => {
              finishSetup = resolve;
            });
          },
        },
      },
    }
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return createOpenAiSseResponse(["old account"]);
  };
  for (const sdk of [false, true]) {
    await t.test(sdk ? "SDK setup" : "raw setup", async () => {
      usePolicyStore.setState({
        status: "unmanaged",
        policy: null,
        accountId: "old",
        authGeneration: 1,
      });
      const setupStarted = new Promise((resolve) => {
        startedSetup = resolve;
      });
      const args = [
        [{ role: "user", content: "hi" }],
        "qwen3-4b-q4_k_m",
        "local",
        { systemPrompt: "s" },
      ];
      const stream = sdk
        ? reasoningService.processTextStreamingAI(...args, {})
        : reasoningService.processTextStreaming(...args);
      t.after(() => stream.return());
      const first = stream.next();
      await setupStarted;
      usePolicyStore.setState({ accountId: "new", authGeneration: 2 });
      finishSetup({ success: true, port: 11434 });
      await assert.rejects(first, { code: "POLICY_UNRESOLVABLE" });
    });
  }
  assert.equal(requests, 0);
});

function createAgentStreamBridge() {
  const startCalls = [];
  const cancelCalls = [];
  const listeners = { chunk: null, error: null, end: null };
  const cleanupCounts = { chunk: 0, error: 0, end: 0 };
  const subscribe = (kind, callback) => {
    listeners[kind] = callback;
    return () => {
      cleanupCounts[kind] += 1;
      if (listeners[kind] === callback) listeners[kind] = null;
    };
  };

  return {
    electronAPI: {
      startAgentStream: (...args) => startCalls.push(args),
      cancelAgentStream: (requestId) => cancelCalls.push(requestId),
      onAgentStreamChunk: (callback) => subscribe("chunk", callback),
      onAgentStreamError: (callback) => subscribe("error", callback),
      onAgentStreamEnd: (callback) => subscribe("end", callback),
    },
    startCalls,
    cancelCalls,
    cleanupCounts,
    emitChunk: (payload) => listeners.chunk?.(payload),
    emitEnd: (payload) => listeners.end?.(payload),
  };
}

const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("raw self-hosted streaming filters split tags and flushes visible trailing text", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-raw-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createRawSseResponse(["<thi", "nk>hidden</thi", "nk>Answer<"]);

  const stream = reasoningService.processTextStreaming(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    }
  );

  assert.equal(await collectRawText(stream), "Answer<");
});

test("raw self-hosted streaming flushes visible trailing text at body EOF", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-raw-streaming-think-eof-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createRawSseResponse(["Answer<"], { includeDone: false });

  const stream = reasoningService.processTextStreaming(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    }
  );

  assert.equal(await collectRawText(stream), "Answer<");
});

test("tool-enabled self-hosted streaming filters nested tags", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-tool-streaming-think-test-"
  );
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "No-op test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ success: true, data: "ok", displayText: "ok" }),
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    createOpenAiSseResponse(["<thi", "nk>a<think>b</think>c</thi", "nk>Answer"]);

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    registry.toAISDKFormat()
  );

  assert.equal(await collectAgentText(stream), "Answer");
});

test("tool-loop filtering resets after an unterminated reasoning block", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-tool-step-streaming-think-test-"
  );
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "No-op test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ success: true, data: "ok", displayText: "ok" }),
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return createOpenAiSseResponse(["<think>secret"], {
        finishReason: "tool_calls",
        toolCall: { id: "call-noop", name: "noop", arguments: "{}" },
      });
    }
    return createOpenAiSseResponse(["Answer"]);
  };

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    registry.toAISDKFormat()
  );

  assert.equal(await collectAgentText(stream), "Answer");
  assert.equal(fetchCalls, 2);
});

test("tool-enabled streaming does not flush buffered text after abort", async (t) => {
  const streamOwner = new AbortController();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-abort-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify(createOpenAiChunk({ content: "Answer<thi" }))}\n\n`
          )
        );
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

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    {},
    streamOwner.signal
  );

  const first = await stream.next();
  assert.deepEqual(first.value, { type: "content", text: "Answer" });
  streamOwner.abort();
  assert.equal(await collectAgentText(stream), "");
});

test("cancelling during local model setup stops before streaming begins", async (t) => {
  const streamOwner = new AbortController();
  let resolveServer;
  let serverStarted = false;
  const serverReady = new Promise((resolve) => {
    resolveServer = resolve;
  });
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-model-setup-cancel-test-",
    {
      window: {
        electronAPI: {
          llamaServerStart: () => {
            serverStarted = true;
            return serverReady;
          },
        },
      },
    }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createOpenAiSseResponse(["late answer"]);

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "local",
    { systemPrompt: "Answer the user.", disableThinking: true },
    {},
    streamOwner.signal
  );
  const first = stream.next();
  for (let i = 0; i < 50 && !serverStarted; i++) await waitForMicrotasks();
  assert.equal(serverStarted, true, "fixture setup: local model setup must be pending");

  streamOwner.abort();
  resolveServer({ success: true, port: 11434 });

  assert.deepEqual(await first, {
    value: { type: "done", finishReason: "abort" },
    done: false,
  });
  assert.equal((await stream.next()).done, true);
});

test("cancelling tool-ineligible local setup prevents raw streaming", async (t) => {
  const streamOwner = new AbortController();
  let resolveServer;
  let serverStarted = false;
  const serverReady = new Promise((resolve) => {
    resolveServer = resolve;
  });
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-tool-ineligible-model-setup-cancel-test-",
    {
      window: {
        electronAPI: {
          llamaServerStart: () => {
            serverStarted = true;
            return serverReady;
          },
        },
      },
    }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return createOpenAiSseResponse(["late answer"]);
  };

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-1.7b-q4_k_m",
    "local",
    { systemPrompt: "Answer the user.", disableThinking: true },
    undefined,
    streamOwner.signal
  );
  const first = stream.next();
  for (let i = 0; i < 50 && !serverStarted; i++) await waitForMicrotasks();
  assert.equal(serverStarted, true, "fixture setup: raw model setup must be pending");

  streamOwner.abort();
  resolveServer({ success: true, port: 11434 });

  const firstResult = await first;
  const chunks = firstResult.done ? [] : [firstResult.value];
  for await (const chunk of stream) chunks.push(chunk);

  assert.deepEqual(chunks, [{ type: "done", finishReason: "abort" }]);
  assert.equal(fetchCalls, 0);
});

test("cancelling a raw stream after its reader starts ends normally", async (t) => {
  const streamOwner = new AbortController();
  const { reasoningService } = await loadReasoningService(t, "openwhispr-raw-reader-cancel-test-");
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

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-1.7b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    undefined,
    streamOwner.signal
  );
  const output = collectAgentText(stream);
  for (let i = 0; i < 50 && !readerStarted; i++) await waitForMicrotasks();
  assert.equal(readerStarted, true, "fixture setup: the response reader must be pending");

  streamOwner.abort();

  assert.equal(await output, "");
});

test("a timeout-owned abort during raw response reading remains a timeout error", async (t) => {
  const { reasoningService } = await loadReasoningService(t, "openwhispr-raw-reader-timeout-test-");
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 60_000 ? 0 : delay, ...args);
  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream({
      start(controller) {
        // The first bytes switch from the startup allowance to the idle timeout.
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
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

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-1.7b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    undefined
  );

  // A LAN/self-hosted timeout is now classified instead of the generic message.
  await assert.rejects(collectAgentText(stream), (err) => {
    assert.equal(err.code, "PROVIDER_TIMEOUT");
    assert.equal(err.messageKey, "providerErrors.selfHosted.timeout");
    return true;
  });
});

// Was "does not flush buffered text after error" and asserted the stream
// silently ended with "". A provider-reported error part must now reject the
// generator instead; buffered text must still never leak into that rejection.
test("tool-enabled streaming rejects instead of flushing buffered text after a stream error", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-error-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let failResponse;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify(createOpenAiChunk({ content: "Answer<thi" }))}\n\n`
          )
        );
        failResponse = () => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message: "stream failed" } })}\n\n`)
          );
          controller.close();
        };
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    {}
  );

  const first = await stream.next();
  assert.deepEqual(first.value, { type: "content", text: "Answer" });
  failResponse();

  let received = "";
  await assert.rejects(
    (async () => {
      for await (const chunk of stream) {
        if (chunk.type === "content") received += chunk.text;
      }
    })()
  );
  assert.equal(received, "");
});

test("self-hosted streaming preserves think tags when thinking is enabled", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-enabled-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createOpenAiSseResponse(["<think>visible</think>Answer"]);

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: false,
    },
    {}
  );

  assert.equal(await collectAgentText(stream), "<think>visible</think>Answer");
});

test("non-local streaming remains unfiltered", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-streaming-think-test-",
    { window: { electronAPI: { getGroqKey: async () => "test-key" } } }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createOpenAiSseResponse(["<think>visible</think>Answer"]);

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "llama-3.3-70b-versatile",
    "groq",
    { systemPrompt: "Answer the user.", disableThinking: true },
    {}
  );

  assert.equal(await collectAgentText(stream), "<think>visible</think>Answer");
});

test("chat cancellation leaves single-shot reasoning alive until all requests are cancelled", async (t) => {
  const streamOwner = new AbortController();
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-non-streaming-reason-cancel-test-",
    { window: { electronAPI: { getGroqKey: async () => "test-key", ...bridge.electronAPI } } }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestStarted = false;
  let requestSignal;
  let fetchCalls = 0;
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    requestStarted = true;
    requestSignal = init?.signal;
    return await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    });
  };

  const reasoning = reasoningService.processText(
    "clean this text",
    "llama-3.3-70b-versatile",
    null,
    { provider: "groq" }
  );
  while (!requestStarted) await waitForMicrotasks();
  const cancelled = assert.rejects(reasoning, /cancelled/i);

  const chatStream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hi" }],
    { systemPrompt: "Answer" },
    streamOwner.signal
  );
  const chatEnded = chatStream.next();
  while (bridge.startCalls.length === 0) await waitForMicrotasks();
  streamOwner.abort();
  await chatEnded;
  assert.equal(bridge.cancelCalls.length, 1, "the chat stream itself was cancelled");
  assert.equal(requestSignal?.aborted, false);

  reasoningService.cancelAllRequests();

  await cancelled;
  assert.equal(fetchCalls, 1);
});

test("cloud action requests supply source fidelity once through every tool step", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService, vite } = await loadReasoningService(t, "openwhispr-cloud-fidelity-", {
    window: { electronAPI: bridge.electronAPI },
  });
  const { getAgentSystemPrompt } = await vite.ssrLoadModule("/config/prompts.ts");
  const { compileChatActionPrompt } = await vite.ssrLoadModule("/helpers/templatePrompts.js");
  const { SOURCE_FIDELITY_RULE } = await vite.ssrLoadModule("/helpers/sourceFidelity.js");
  const systemPrompt = getAgentSystemPrompt(["get_note"]);
  const action = compileChatActionPrompt({ prompt: "Write a TL;DR." }, { fromSummary: false });
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: action },
  ];
  const original = structuredClone(messages);
  const output = collectAgentText(
    reasoningService.processTextStreamingCloud(messages, {
      systemPrompt,
      tools: [{ name: "get_note", description: "Read a note", parameters: {} }],
      executeToolCall: async () => ({ data: "Not yet approved.", displayText: "Read note" }),
    })
  );
  await waitForMicrotasks();
  const [requestId] = bridge.startCalls[0];
  bridge.emitChunk({
    requestId,
    chunk: { type: "tool_call", id: "read-1", name: "get_note", arguments: '{"id":7}' },
  });
  bridge.emitEnd({ requestId });
  await waitForMicrotasks();
  assert.equal(bridge.startCalls.length, 2);
  const [nextRequestId] = bridge.startCalls[1];
  bridge.emitChunk({ requestId: nextRequestId, chunk: { type: "content", text: "Not approved." } });
  bridge.emitEnd({ requestId: nextRequestId });
  assert.equal(await output, "Not approved.");

  for (const [, sent, config] of bridge.startCalls) {
    // /api/agent/stream prepends systemPrompt before these messages.
    const effective = [{ role: "system", content: config.systemPrompt }, ...sent];
    assert.equal(JSON.stringify(effective).split(SOURCE_FIDELITY_RULE).length - 1, 1);
    assert.equal(config.systemPrompt, systemPrompt);
    assert.equal(sent[0].content, action);
  }
  assert.deepEqual(
    bridge.startCalls[1][1].map((message) => message.role),
    ["user", "assistant", "tool"]
  );
  assert.deepEqual(messages, original, "the caller's history is unchanged");
});

test("cloud requests preserve distinct system instructions and instruction-looking history", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(t, "openwhispr-cloud-system-history-", {
    window: { electronAPI: bridge.electronAPI },
  });
  const systemPrompt = "Preserve the source's meaning.";
  for (const messages of [
    [{ role: "user", content: systemPrompt }],
    [
      { role: "system", content: "Separate system instruction." },
      { role: "user", content: systemPrompt },
      { role: "assistant", content: systemPrompt },
    ],
  ]) {
    const output = collectAgentText(
      reasoningService.processTextStreamingCloud(messages, { systemPrompt })
    );
    await waitForMicrotasks();
    const [requestId, sent, config] = bridge.startCalls.at(-1);
    bridge.emitEnd({ requestId });
    await output;
    assert.deepEqual(sent, messages);
    assert.equal(config.systemPrompt, systemPrompt);
  }
});

test("cloud agent streaming correlates events to the initiating request", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-correlation-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud([{ role: "user", content: "hello" }], {
    systemPrompt: "Answer the user.",
  });
  let firstSettled = false;
  const first = stream.next().then((result) => {
    firstSettled = true;
    return result;
  });
  await waitForMicrotasks();

  assert.equal(bridge.startCalls.length, 1);
  const [requestId] = bridge.startCalls[0];
  assert.equal(typeof requestId, "string");
  assert.ok(requestId.length > 0);

  bridge.emitChunk({
    requestId: "another-request",
    chunk: { type: "content", text: "wrong" },
  });
  await waitForMicrotasks();
  assert.equal(firstSettled, false);

  bridge.emitChunk({ requestId, chunk: { type: "content", text: "right" } });
  assert.deepEqual(await first, { value: { type: "content", text: "right" }, done: false });

  const end = stream.next();
  bridge.emitEnd({ requestId });
  assert.deepEqual(await end, {
    value: { type: "done", finishReason: "stop" },
    done: false,
  });
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(bridge.cleanupCounts, { chunk: 1, error: 1, end: 1 });
});

test("a cloud stream sends main only the options the API request carries", async (t) => {
  const streamOwner = new AbortController();
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(t, "openwhispr-cloud-agent-options-", {
    window: { electronAPI: bridge.electronAPI },
  });
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hello" }],
    {
      systemPrompt: "Answer the user.",
      tools: [{ name: "get_note", description: "Read a note", parameters: {} }],
      screenContext: { data: "aGVsbG8=", mediaType: "image/jpeg" },
      // Retired with assistant memory (openwhispr-api#243); must not reach main.
      noteChat: true,
    },
    streamOwner.signal
  );
  const pending = stream.next();
  await waitForMicrotasks();

  assert.deepEqual(Object.keys(bridge.startCalls[0][2]).sort(), [
    "screenContext",
    "systemPrompt",
    "tools",
  ]);
  streamOwner.abort();
  await pending;
});

test("cancelling a cloud agent stream aborts main and ends the local generator", async (t) => {
  const streamOwner = new AbortController();
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hello" }],
    {
      systemPrompt: "Answer the user.",
    },
    streamOwner.signal
  );
  const pending = stream.next();
  await waitForMicrotasks();
  const [requestId] = bridge.startCalls[0];

  streamOwner.abort();

  assert.deepEqual(bridge.cancelCalls, [requestId]);
  assert.deepEqual(await pending, { value: { type: "done", finishReason: "abort" }, done: false });
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(bridge.cleanupCounts, { chunk: 1, error: 1, end: 1 });
});

test("cancelling a cloud stream before its first next prevents the request", async (t) => {
  const streamOwner = new AbortController();
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-pre-next-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hello" }],
    {
      systemPrompt: "Answer the user.",
    },
    streamOwner.signal
  );

  streamOwner.abort();
  const first = stream.next();
  await waitForMicrotasks();
  const startedRequests = bridge.startCalls.length;
  if (startedRequests > 0) streamOwner.abort();

  assert.equal(startedRequests, 0);
  assert.equal((await first).done, true);
});

test("cancelling a cloud agent stream drops chunks already queued locally", async (t) => {
  const streamOwner = new AbortController();
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-queued-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hello" }],
    {
      systemPrompt: "Answer the user.",
    },
    streamOwner.signal
  );
  const first = stream.next();
  await waitForMicrotasks();
  const [requestId] = bridge.startCalls[0];

  bridge.emitChunk({ requestId, chunk: { type: "content", text: "first" } });
  bridge.emitChunk({ requestId, chunk: { type: "content", text: "queued" } });
  assert.deepEqual(await first, { value: { type: "content", text: "first" }, done: false });

  streamOwner.abort();

  assert.deepEqual(await stream.next(), {
    value: { type: "done", finishReason: "abort" },
    done: false,
  });
  bridge.emitChunk({ requestId, chunk: { type: "content", text: "late" } });
  assert.equal((await stream.next()).done, true);
});

test("cancelling during a cloud tool execution prevents results and later model steps", async (t) => {
  const streamOwner = new AbortController();
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-tool-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  let resolveTool;
  let toolStarted = false;
  const toolResult = new Promise((resolve) => {
    resolveTool = resolve;
  });
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "create a note" }],
    {
      systemPrompt: "Use tools.",
      tools: [{ name: "create_note", description: "Create a note", parameters: {} }],
      executeToolCall: async () => {
        toolStarted = true;
        return toolResult;
      },
    },
    streamOwner.signal
  );
  const first = stream.next();
  await waitForMicrotasks();
  const [requestId] = bridge.startCalls[0];
  bridge.emitChunk({
    requestId,
    chunk: { type: "tool_call", id: "call-1", name: "create_note", arguments: "{}" },
  });
  assert.deepEqual(await first, {
    value: {
      type: "tool_calls",
      calls: [{ id: "call-1", name: "create_note", arguments: "{}" }],
    },
    done: false,
  });

  const pending = stream.next();
  bridge.emitEnd({ requestId });
  while (!toolStarted) await waitForMicrotasks();

  streamOwner.abort();
  resolveTool({ data: "created", displayText: "Created note" });

  assert.deepEqual(await pending, { value: { type: "done", finishReason: "abort" }, done: false });
  assert.equal((await stream.next()).done, true);
  assert.equal(bridge.startCalls.length, 1);
});

test("a provider error part rejects the agent stream instead of ending it silently", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-stream-error-part-test-"
  );
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "No-op test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ success: true, data: "ok", displayText: "ok" }),
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // streamText never throws on an HTTP failure; it emits an `error` part and
  // closes the stream. The generator must surface that as a rejection.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { message: "Incorrect API key provided", type: "invalid_request_error" },
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    );

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    registry.toAISDKFormat()
  );

  // The AI SDK error part is now classified; the provider's original message
  // survives on the preserved cause rather than as the top-level message.
  await assert.rejects(collectAgentText(stream), (err) => {
    assert.equal(err.code, "PROVIDER_AUTH_FAILED");
    assert.match(err.cause?.message ?? "", /Incorrect API key/);
    return true;
  });
});

// A "custom" BYOK endpoint (config.baseUrl) is a user's own server just like
// LAN (config.lanUrl), but it takes a different route.kind ("provider", not
// "self-hosted"), so the mode check alone would miss it and report "OpenAI"
// (getProviderDisplayName("custom") has no registry entry to fall back on).
test("a custom BYOK endpoint's provider error part is classified self-hosted, not OpenAI", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-stream-custom-selfhosted-test-"
  );

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { message: "Incorrect API key provided", type: "invalid_request_error" },
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    );

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "cleanup-model",
    "custom",
    {
      systemPrompt: "Answer the user.",
      baseUrl: "http://127.0.0.1:11434/v1",
      customApiKey: "test-key",
      disableThinking: true,
    },
    undefined
  );

  await assert.rejects(collectAgentText(stream), (err) => {
    assert.equal(err.code, "PROVIDER_AUTH_FAILED");
    assert.equal(err.messageKey, "providerErrors.selfHosted.authFailed");
    assert.equal(err.technicalDetails.provider, "Your server");
    assert.match(err.message, /^Your server /);
    return true;
  });
});
