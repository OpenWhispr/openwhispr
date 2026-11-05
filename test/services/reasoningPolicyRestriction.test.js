const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const esTranslations = require("../../src/locales/es/translation.json");
const enTranslations = require("../../src/locales/en/translation.json");

test("reasoning policy asserts throw messages localized to the active UI language", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-policy-test-",
  });

  const { assertAgentAllowedByPolicy, assertReasoningAllowedByPolicy } = await vite.ssrLoadModule(
    "/services/reasoningPolicy.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");

  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.1",
    policy: {
      version: 1,
      transcription: { allowedModes: [], allowedByokProviders: [] },
      llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
      features: { agentEnabled: false, webSearchEnabled: false },
      sharing: { externalLinkSharing: "disabled" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: false,
      },
      minAppVersion: null,
    },
  });

  await i18n.changeLanguage("es");
  assert.notEqual(
    esTranslations.common.policyAgentRestricted,
    enTranslations.common.policyAgentRestricted,
    "the localized strings must differ so this test can prove translation happened"
  );

  assert.throws(() => assertAgentAllowedByPolicy(), {
    message: esTranslations.common.policyAgentRestricted,
  });
  assert.throws(() => assertReasoningAllowedByPolicy("openai", "providers"), {
    message: esTranslations.common.policyAiProcessingRestricted,
  });

  await i18n.changeLanguage("en");
  assert.throws(() => assertAgentAllowedByPolicy(), {
    message: enTranslations.common.policyAgentRestricted,
  });
});

test("the model factory preserves a permitted self-hosted route without granting local or BYOK", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-self-hosted-policy-test-",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
  const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");
  const policy = defaultDevicePolicy();
  policy.llm.allowedModes = ["self-hosted"];
  usePolicyStore.setState({ status: "managed", policy, appVersion: "1.11.1" });
  assert.ok(
    await getAIModel("local", "local-model", "", "https://lan.example.test/v1", {
      mode: "self-hosted",
    })
  );
  await assert.rejects(getAIModel("local", "local-model", "", "http://127.0.0.1:9999/v1"));
  await assert.rejects(getAIModel("openai", "gpt-test", "saved-key"));
});

test("one-shot reasoning cannot transmit after policy changes while its saved key loads", async (t) => {
  let revoke;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getGeminiKey: async () => {
          revoke();
          return "saved-key";
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null, appVersion: "1.11.1" });
  revoke = () => {
    const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
    policy.llm.allowedModes = ["local"];
    usePolicyStore.setState({ status: "managed", policy });
  };
  const { default: service } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => service.destroy());
  const request = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected transmission");
  });
  await assert.rejects(
    service.processText("private", "gemini-3.5-flash", null, {
      provider: "gemini",
      systemPrompt: "Answer",
    })
  );
  assert.equal(request.mock.callCount(), 0);
});

test("one-shot reasoning aborts revoked requests and discards an ignored late response", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: { getGeminiKey: async () => "saved-key" } } });
  const vite = await createRendererServer(t);
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null, appVersion: "1.11.1" });
  const { default: service } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => service.destroy());
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
    policy.llm.allowedByokProviders = ["openai"];
    usePolicyStore.setState({ status: "managed", policy });
    return Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "late private output" }] } }],
    });
  });
  await assert.rejects(
    service.processText("private", "gemini-3.5-flash", null, {
      provider: "gemini",
      systemPrompt: "Answer",
    })
  );
  assert.equal(signal.aborted, true);
});

test("raw chat streaming cannot transmit after its provider is revoked during key loading", async (t) => {
  let revoke;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getOpenAIKey: async () => {
          revoke();
          return "saved-key";
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null, appVersion: "1.11.1" });
  revoke = () => {
    const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
    policy.llm.allowedByokProviders = ["gemini"];
    usePolicyStore.setState({ status: "managed", policy });
  };
  const { default: service } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => service.destroy());
  const request = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected transmission");
  });
  const chunks = [];
  for await (const chunk of service.processTextStreaming(
    [{ role: "user", content: "private" }],
    "gpt-test",
    "openai",
    { systemPrompt: "Answer" }
  ))
    chunks.push(chunk);
  assert.deepEqual(chunks, []);
  assert.equal(request.mock.callCount(), 0);
});

test("managed local-only chat permits catalog local providers on the raw streaming path", async (t) => {
  installBrowserGlobals(t, {
    window: { electronAPI: { llamaServerStart: async () => ({ success: true, port: 9411 }) } },
  });
  const vite = await createRendererServer(t);
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
  policy.llm.allowedModes = ["local"];
  usePolicyStore.setState({ status: "managed", policy, appVersion: "1.11.1" });
  const { default: service } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => service.destroy());
  const request = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('data: {"choices":[{"delta":{"content":"permitted"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      })
  );
  const providers = require("../../src/models/modelRegistryData.json").localProviders;
  for (const id of ["qwen", "llama"]) {
    const provider = providers.find((p) => p.id === id);
    const chunks = [];
    for await (const chunk of service.processTextStreamingAI(
      [{ role: "user", content: "private" }],
      provider.models[0].id,
      id,
      { systemPrompt: "Answer" }
    ))
      chunks.push(chunk);
    assert.ok(chunks.some((chunk) => chunk.type === "content" && chunk.text === "permitted"));
  }
  assert.equal(request.mock.callCount(), 2);
});
