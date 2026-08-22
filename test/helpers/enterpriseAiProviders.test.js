const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getEnterpriseAIModel,
  toAzureOpenAIBaseUrl,
} = require("../../src/helpers/enterpriseAiProviders.js");

test("builds the Azure SDK base below the public resource origin", () => {
  assert.equal(
    toAzureOpenAIBaseUrl("https://example.openai.azure.com"),
    "https://example.openai.azure.com/openai"
  );
  assert.equal(
    toAzureOpenAIBaseUrl("https://example.openai.azure.com/"),
    "https://example.openai.azure.com/openai"
  );
});

test("rejects unsupported managed Azure endpoint forms", () => {
  for (const endpoint of [
    "https://example.services.ai.azure.com",
    "https://example.openai.azure.us",
    "https://example.openai.azure.com/openai",
    "https://example.openai.azure.com?api-key=secret",
  ]) {
    assert.throws(() => toAzureOpenAIBaseUrl(endpoint), /public Azure resource origin/);
  }
});

test("the pinned Azure SDK requests the deployment below /openai/v1 with bearer auth", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request;
  global.fetch = async (url, init) => {
    request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: JSON.parse(init.body),
    };
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const model = getEnterpriseAIModel("azure", "deployment-a", "", {
    azureEndpoint: "https://example.openai.azure.com",
    azureApiVersion: "v1",
    managedTokenProvider: async () => "temporary-bearer-token",
  });
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.equal(
    request.url,
    "https://example.openai.azure.com/openai/v1/responses?api-version=v1"
  );
  assert.equal(request.headers.authorization, "Bearer temporary-bearer-token");
  assert.equal(request.body.model, "deployment-a");
});

test("manual Azure setup preserves legacy endpoints and API-key auth", async (t) => {
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

  const model = getEnterpriseAIModel("azure", "legacy-deployment", "legacy-api-key", {
    azureEndpoint: "https://legacy.example.com/custom/openai",
    azureApiVersion: "2024-10-21",
  });
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
  );
  assert.equal(
    request.url,
    "https://legacy.example.com/custom/openai/responses"
  );
  assert.equal(request.headers["api-key"], "legacy-api-key");
});
