const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("one-shot and AI SDK tool/stream dispatch normalize stale Flash selections with the same key", async (t) => {
  installBrowserGlobals(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request in dispatch fixture");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = [];
  globalThis.__tinfoilRetirementCalls = calls;
  t.after(() => delete globalThis.__tinfoilRetirementCalls);
  const vite = await createRendererServer(t, {
    noExternal: ["tinfoil"],
    mockModules: {
      tinfoil: `
      export class TinfoilAI {
        constructor(options) {
          this.chat = { completions: { create: async (body) => {
            globalThis.__tinfoilRetirementCalls.push({ key: options.apiKey, model: body.model, kind: 'one-shot' });
            return { choices: [{ message: { content: 'Cleaned text' }, finish_reason: 'stop' }] };
          } } };
        }
      }
      export const createTinfoilAI = async key => model => ({
        doStream: async options => {
          globalThis.__tinfoilRetirementCalls.push({ key, model, kind: 'stream', tools: options.tools });
          return { stream: new ReadableStream({ start(controller) { controller.close(); } }) };
        }
      });
    `,
    },
  });
  const { tinfoilProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/tinfoil.ts"
  );
  assert.equal(
    await tinfoilProvider.call({
      text: "synthetic text",
      model: "glm-5-3-flash",
      config: {},
      ctx: {
        getApiKey: async () => "synthetic-key",
        getSystemPrompt: () => "Clean text",
        calculateMaxTokens: () => 4096,
      },
    }),
    "Cleaned text"
  );
  const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
  const model = await getAIModel("tinfoil", "glm-5-3-flash", "synthetic-key");
  await model.doStream({ tools: [{ type: "function", name: "synthetic_tool" }] });
  assert.deepEqual(calls, [
    { key: "synthetic-key", model: "glm-5-3", kind: "one-shot" },
    {
      key: "synthetic-key",
      model: "glm-5-3",
      kind: "stream",
      tools: [{ type: "function", name: "synthetic_tool" }],
    },
  ]);
  const supported = await getAIModel("tinfoil", "gpt-oss-120b", "synthetic-key");
  await supported.doStream({});
  assert.equal(calls.at(-1).model, "gpt-oss-120b");
  const custom = await getAIModel(
    "custom",
    "glm-5-3-flash",
    "custom-key",
    "https://example.invalid/v1"
  );
  assert.equal(custom.modelId, "glm-5-3-flash");
});

test("retired Tinfoil streaming selections preserve replacement model temperatures", async (t) => {
  installBrowserGlobals(t, {
    window: { electronAPI: { getTinfoilKey: async () => "synthetic-key" } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request in streaming fixture");
  };
  const calls = [];
  globalThis.__tinfoilStreamingCalls = calls;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.__tinfoilStreamingCalls;
  });
  const vite = await createRendererServer(t, {
    noExternal: ["tinfoil"],
    mockModules: {
      tinfoil: `
        import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
        export const createTinfoilAI = async key => model => new MockLanguageModelV3({
          modelId: model,
          doStream: async options => {
            globalThis.__tinfoilStreamingCalls.push({ key, model, temperature: options.temperature });
            return { stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Answer" },
              { type: "text-end", id: "answer" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
              },
            ] }) };
          },
        });
      `,
    },
  });
  const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => reasoningService.destroy());
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.2", policy: null });

  for (const temperature of [0, undefined]) {
    await t.test(
      `preserves ${temperature === undefined ? "default" : "explicit zero"} temperature`,
      async () => {
        const chunks = [];
        for await (const chunk of reasoningService.processTextStreamingAI(
          [{ role: "user", content: "synthetic text" }],
          "glm-5-3-flash",
          "tinfoil",
          { systemPrompt: "Answer the user", temperature }
        )) {
          chunks.push(chunk);
        }
        assert.deepEqual(calls.at(-1), {
          key: "synthetic-key",
          model: "glm-5-3",
          temperature: temperature === undefined ? 0.3 : 0,
        });
        assert.ok(chunks.some((chunk) => chunk.type === "content" && chunk.text === "Answer"));
      }
    );
  }
});

test("Tinfoil image input remains unwired in the shared dictation/chat capability gate", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { providerSupportsImages } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/index.ts"
  );
  assert.equal(providerSupportsImages("tinfoil"), false);
  assert.equal(providerSupportsImages("openai"), true);
});
