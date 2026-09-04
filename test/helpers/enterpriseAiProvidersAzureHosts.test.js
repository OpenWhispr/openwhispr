const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getEnterpriseAIModel,
  toAzureOpenAIBaseUrl,
} = require("../../src/helpers/enterpriseAiProviders.js");
const { AZURE_HOST_SUFFIXES } = require("../../src/helpers/enterpriseManagedConfig.mjs");

// @ai-sdk/azure appends `/v1` and `?api-version=` itself only when the base
// URL's hostname ends in `.openai.azure.com`; for every other host it uses the
// base URL verbatim. The two shapes are asserted separately so they can never
// silently converge on one template again.
const SDK_VERSIONED_SUFFIXES = [".openai.azure.com"];
const VERBATIM_SUFFIXES = [".cognitiveservices.azure.com", ".services.ai.azure.com"];

const prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];

test("every allowlisted Azure host suffix is classified into exactly one base-URL shape", () => {
  assert.deepEqual(
    [...SDK_VERSIONED_SUFFIXES, ...VERBATIM_SUFFIXES].sort(),
    [...AZURE_HOST_SUFFIXES].sort()
  );
});

test("Azure OpenAI resources keep the SDK-managed base and never gain a /v1 of their own", () => {
  for (const suffix of SDK_VERSIONED_SUFFIXES) {
    for (const endpoint of [`https://acme${suffix}`, `https://acme${suffix}/`]) {
      assert.equal(toAzureOpenAIBaseUrl(endpoint), `https://acme${suffix}/openai`, endpoint);
    }
  }
});

test("AI Services and Foundry resources carry the /v1 segment the SDK will not add", () => {
  for (const suffix of VERBATIM_SUFFIXES) {
    for (const endpoint of [`https://acme${suffix}`, `https://acme${suffix}/`]) {
      assert.equal(toAzureOpenAIBaseUrl(endpoint), `https://acme${suffix}/openai/v1`, endpoint);
    }
  }
});

test("managed Azure LLM rejects path- or query-qualified endpoints on every host class", () => {
  for (const suffix of AZURE_HOST_SUFFIXES) {
    for (const endpoint of [
      `https://acme${suffix}/openai`,
      `https://acme${suffix}/openai/v1`,
      `https://acme${suffix}?api-version=v1`,
    ]) {
      assert.throws(() => toAzureOpenAIBaseUrl(endpoint), /public Azure resource origin/, endpoint);
    }
  }
});

test("managed Azure LLM still rejects spoofed hosts", () => {
  for (const endpoint of [
    "https://acme.openai.azure.us",
    "https://services.ai.azure.com",
    "http://acme.openai.azure.com",
    "https://user:pw@acme.openai.azure.com",
    "https://evil.com/acme.openai.azure.com",
  ]) {
    assert.throws(() => toAzureOpenAIBaseUrl(endpoint), /public Azure resource origin/, endpoint);
  }
});

test("the pinned Azure SDK builds one request shape per host class", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request;
  global.fetch = async (url, init) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
    };
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  for (const [endpoint, expectedUrl] of [
    [
      "https://acme.openai.azure.com",
      "https://acme.openai.azure.com/openai/v1/responses?api-version=v1",
    ],
    [
      "https://acme.cognitiveservices.azure.com",
      "https://acme.cognitiveservices.azure.com/openai/v1/responses",
    ],
    [
      "https://acme.services.ai.azure.com",
      "https://acme.services.ai.azure.com/openai/v1/responses",
    ],
  ]) {
    const model = await getEnterpriseAIModel("azure", "deployment-a", "", {
      azureEndpoint: endpoint,
      azureApiVersion: "v1",
      managedTokenProvider: async () => "temporary-bearer-token",
    });
    await assert.rejects(model.doGenerate({ prompt }));
    assert.equal(request.url, expectedUrl, endpoint);
    assert.equal(request.headers.authorization, "Bearer temporary-bearer-token", endpoint);
  }
});
