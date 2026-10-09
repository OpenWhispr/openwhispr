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

test("Tinfoil image input remains unwired in the shared dictation/chat capability gate", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { providerSupportsImages } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/index.ts"
  );
  assert.equal(providerSupportsImages("tinfoil"), false);
  assert.equal(providerSupportsImages("openai"), true);
});
