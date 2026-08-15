const assert = require("node:assert/strict");
const test = require("node:test");
const providerTest = require("../../src/helpers/providerConnectionTest.js");

const { resolveProviderRequest, testProviderConnection } = providerTest;

test("builds provider tests without placing credentials in the URL", () => {
  const request = resolveProviderRequest({ provider: "openai", apiKey: "secret" });
  assert.equal(request.endpoint, "https://api.openai.com/v1/models");
  assert.equal(request.endpoint.includes("secret"), false);
  assert.equal(request.headers.Authorization, "Bearer secret");
});

test("normalizes custom compatible endpoints", () => {
  assert.equal(
    resolveProviderRequest({ provider: "custom", baseUrl: "localhost:11434/v1", apiKey: "" })
      .endpoint,
    "https://localhost:11434/v1/models"
  );
});

test("maps authentication and transport failures to safe messages", async () => {
  assert.deepEqual(
    await testProviderConnection({ provider: "openai", apiKey: "bad" }, async () => ({
      ok: false,
      status: 401,
    })),
    { success: false, error: "The provider rejected these credentials." }
  );

  assert.deepEqual(
    await testProviderConnection({ provider: "openai", apiKey: "bad" }, async () => {
      throw new Error("secret upstream detail");
    }),
    { success: false, error: "The provider could not be reached." }
  );
});
