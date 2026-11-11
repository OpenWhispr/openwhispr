const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function load(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-server-fetch-test-",
  });
  return vite.ssrLoadModule("/services/ai/localServerFetch.ts");
}

test("each request of a local turn goes to the port main says serves its model", async (t) => {
  const { localServerFetch } = await load(t);
  const asked = [];
  let port = 8221;
  globalThis.window.electronAPI = {
    llamaServerStart: async (model) => {
      asked.push(model);
      return { success: true, port };
    },
  };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response("{}");
  };
  t.after(() => (globalThis.fetch = realFetch));

  const stepFetch = localServerFetch("qwen3.5-4b");
  const init = { method: "POST", body: "{}" };
  await stepFetch("http://127.0.0.1:8221/v1/chat/completions", init);
  port = 8222;
  await stepFetch("http://127.0.0.1:8221/v1/chat/completions", init);

  assert.deepEqual(asked, ["qwen3.5-4b", "qwen3.5-4b"]);
  assert.deepEqual(
    sent.map((request) => request.url),
    ["http://127.0.0.1:8221/v1/chat/completions", "http://127.0.0.1:8222/v1/chat/completions"]
  );
  assert.equal(sent[0].init, init);
});

test("a model too busy to swap in fails the step with a translatable error, unsent", async (t) => {
  const { localServerFetch } = await load(t);
  globalThis.window.electronAPI = {
    llamaServerStart: async () => ({
      success: false,
      error: "busy",
      code: "LOCAL_MODEL_BUSY",
    }),
  };
  let sent = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    sent += 1;
    return new Response("{}");
  };
  t.after(() => (globalThis.fetch = realFetch));

  await assert.rejects(
    localServerFetch("qwen3.5-4b")("http://127.0.0.1:8221/v1/chat/completions", {}),
    (error) => {
      assert.equal(error.code, "LOCAL_MODEL_BUSY");
      assert.equal(error.messageKey, "models.errors.localModelBusy");
      return true;
    }
  );
  assert.equal(sent, 0);
});

test("a cancelled turn stops waiting for the server at once and tells main to give up", async (t) => {
  const { localServerFetch } = await load(t);
  const asked = [];
  const cancelled = [];
  globalThis.window.electronAPI = {
    // Main is waiting out another model's answer, which could take a minute.
    llamaServerStart: (model, requestId) => {
      asked.push(requestId);
      return new Promise(() => {});
    },
    llamaServerCancelStart: async (requestId) => {
      cancelled.push(requestId);
    },
  };
  let sent = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    sent += 1;
    return new Response("{}");
  };
  t.after(() => (globalThis.fetch = realFetch));

  const turn = new AbortController();
  const step = localServerFetch("qwen3.5-4b")("http://127.0.0.1:8221/v1/chat/completions", {
    signal: turn.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  turn.abort();

  await assert.rejects(step, { name: "AbortError" });
  assert.equal(asked.length, 1);
  assert.deepEqual(cancelled, asked);
  assert.equal(sent, 0);
});

test("a turn already cancelled never asks main for the server", async (t) => {
  const { localServerFetch } = await load(t);
  let asked = 0;
  globalThis.window.electronAPI = {
    llamaServerStart: async () => {
      asked += 1;
      return { success: true, port: 8221 };
    },
    llamaServerCancelStart: async () => {},
  };
  const turn = new AbortController();
  turn.abort();

  await assert.rejects(
    localServerFetch("qwen3.5-4b")("http://127.0.0.1:8221/v1/chat/completions", {
      signal: turn.signal,
    }),
    { name: "AbortError" }
  );
  assert.equal(asked, 0);
});

test("that error reaches the chat through the AI SDK with its translation key", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-server-fetch-sdk-test-",
  });
  const { localServerFetch } = await vite.ssrLoadModule("/services/ai/localServerFetch.ts");
  const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
  const { streamText } = await vite.ssrLoadModule("ai");
  globalThis.window.electronAPI = {
    llamaServerStart: async () => ({ success: false, error: "busy", code: "LOCAL_MODEL_BUSY" }),
  };

  const model = await getAIModel("local", "qwen3.5-4b", "", "http://127.0.0.1:8221/v1", {
    fetch: localServerFetch("qwen3.5-4b"),
  });
  const result = streamText({ model, prompt: "hi", onError: () => {} });
  let failure;
  for await (const part of result.fullStream) {
    if (part.type === "error") failure = part.error;
  }

  assert.equal(failure?.code, "LOCAL_MODEL_BUSY");
  assert.equal(failure?.messageKey, "models.errors.localModelBusy");
});
