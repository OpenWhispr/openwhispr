const test = require("node:test");
const assert = require("node:assert/strict");

// The renderer-side shim mints the session id, so this test drives it with a
// fake preload bridge instead of the main-process handler.

function installBridge() {
  const started = [];
  const listeners = [];
  const cancelled = [];
  globalThis.window = {
    electronAPI: {
      opencodeStreamStart: async (payload) => {
        started.push(payload);
        return { success: true };
      },
      opencodeStreamCancel: (streamId) => {
        cancelled.push(streamId);
      },
      onOpencodeStreamPart: (callback) => {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    },
  };
  return { started, listeners, cancelled };
}

test.afterEach(() => {
  delete globalThis.window;
});

test("every step of one model instance uses the same Go session", async () => {
  const { started } = installBridge();
  const { createOpencodeChatModel } = await import("../../src/services/ai/opencodeChatModel.ts");
  const model = createOpencodeChatModel("opencode-go", "glm-5.3");

  await model.doStream({ prompt: [], abortSignal: new AbortController().signal });
  await model.doStream({ prompt: [], abortSignal: new AbortController().signal });

  assert.equal(started.length, 2);
  assert.match(started[0].sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(started[1].sessionId, started[0].sessionId);
  // Each step still gets its own transport stream.
  assert.notEqual(started[0].streamId, started[1].streamId);
});

test("the shim relays parts and closes on done", async () => {
  const { started, listeners } = installBridge();
  const { createOpencodeChatModel } = await import("../../src/services/ai/opencodeChatModel.ts");
  const model = createOpencodeChatModel("opencode-zen", "glm-5.3");

  const { stream } = await model.doStream({
    prompt: [],
    abortSignal: new AbortController().signal,
  });
  assert.equal(listeners.length, 1);

  listeners[0]({
    streamId: started[0].streamId,
    part: { type: "text-delta", id: "t1", delta: "hi" },
  });
  listeners[0]({ streamId: started[0].streamId, done: true });

  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), {
    done: false,
    value: { type: "text-delta", id: "t1", delta: "hi" },
  });
  assert.equal((await reader.read()).done, true);
});

test("an aborted turn never opens a request", async () => {
  const { started } = installBridge();
  const { createOpencodeChatModel } = await import("../../src/services/ai/opencodeChatModel.ts");
  const model = createOpencodeChatModel("opencode-go", "glm-5.3");
  const controller = new AbortController();
  controller.abort();

  const { stream } = await model.doStream({
    prompt: [],
    abortSignal: controller.signal,
  });

  assert.equal(started.length, 0);
  assert.equal((await stream.getReader().read()).done, true);
});

test("cancelling the stream cancels the main-process request", async () => {
  const { started, cancelled } = installBridge();
  const { createOpencodeChatModel } = await import("../../src/services/ai/opencodeChatModel.ts");
  const model = createOpencodeChatModel("opencode-go", "glm-5.3");

  const { stream } = await model.doStream({
    prompt: [],
    abortSignal: new AbortController().signal,
  });
  await stream.cancel();

  assert.deepEqual(cancelled, [started[0].streamId]);
});

test("a stream failure surfaces as a rejected read", async () => {
  const { started, listeners } = installBridge();
  const { createOpencodeChatModel } = await import("../../src/services/ai/opencodeChatModel.ts");
  const model = createOpencodeChatModel("opencode-go", "glm-5.3");

  const { stream } = await model.doStream({
    prompt: [],
    abortSignal: new AbortController().signal,
  });
  listeners[0]({ streamId: started[0].streamId, error: "quota exhausted" });

  await assert.rejects(stream.getReader().read(), /quota exhausted/);
});

test("non-streaming generation is refused explicitly", async () => {
  installBridge();
  const { createOpencodeChatModel } = await import("../../src/services/ai/opencodeChatModel.ts");
  const model = createOpencodeChatModel("opencode-go", "glm-5.3");
  await assert.rejects(model.doGenerate({ prompt: [] }), /streaming-only/);
});
