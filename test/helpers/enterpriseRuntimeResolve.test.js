const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return { app: { getPath: () => "/tmp", getVersion: () => "0.0.0" } };
  }
  return origLoad.call(this, request, ...rest);
};

const { resolveManualEnterpriseRuntime } = require("../../src/helpers/enterpriseProviderErrors");

function resolveFromEnv(env) {
  return (value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    const match = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!match) return raw;
    const name = match[1] || match[2];
    const resolved = env[name];
    if (resolved == null) return "";
    const trimmed = String(resolved).trim();
    return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(trimmed) ? "" : trimmed;
  };
}

test("azure $AZURE_OPENAI_API_KEY expands and never emits a leftover $VAR", () => {
  const resolve = resolveFromEnv({ AZURE_OPENAI_API_KEY: "az-live" });
  const runtime = resolveManualEnterpriseRuntime(
    { azureApiKey: "$AZURE_OPENAI_API_KEY", azureEndpoint: "https://example.openai.azure.com" },
    "azure",
    "gpt-4o",
    resolve
  );
  assert.equal(runtime.apiKey, "az-live");
  assert.equal(runtime.enterprise.azureApiKey, "az-live");
  assert.equal(runtime.apiKey.includes("$"), false);
});

test("an unset azure ref fails loudly instead of sending Bearer $VAR or nothing", () => {
  assert.throws(
    () =>
      resolveManualEnterpriseRuntime(
        { azureApiKey: "$AZURE_OPENAI_API_KEY" },
        "azure",
        "gpt-4o",
        resolveFromEnv({})
      ),
    (error) => error.code === "ENTERPRISE_CREDENTIAL_MISSING" && /AZURE_OPENAI_API_KEY/.test(error.message)
  );
});

test("vertex API-key auth with an unset ref never falls back to ADC", () => {
  assert.throws(
    () =>
      resolveManualEnterpriseRuntime(
        { apiKey: "$VERTEX_API_KEY", vertexApiKey: "$VERTEX_API_KEY", vertexProject: "p" },
        "vertex",
        "gemini",
        resolveFromEnv({})
      ),
    (error) => error.code === "ENTERPRISE_CREDENTIAL_MISSING"
  );
});

test("a Bedrock profile takes precedence over stale static credentials in an IPC payload", () => {
  const runtime = resolveManualEnterpriseRuntime(
    { bedrockProfile: "company", bedrockRegion: "us-west-2", bedrockSessionToken: "$GROQ_API_KEY" },
    "bedrock",
    "model",
    () => assert.fail("profile authentication does not require a stored credential")
  );
  assert.equal(runtime.enterprise.bedrockProfile, "company");
  assert.equal(runtime.enterprise.bedrockRegion, "us-west-2");
  assert.equal(runtime.enterprise.bedrockSessionToken, undefined);
});

test("bedrock keys with unset refs never fall back to ambient AWS credentials", () => {
  assert.throws(
    () =>
      resolveManualEnterpriseRuntime(
        { bedrockAccessKeyId: "$BEDROCK_ACCESS_KEY_ID", bedrockSecretAccessKey: "${BEDROCK_SECRET_ACCESS_KEY}" },
        "bedrock",
        "m",
        resolveFromEnv({})
      ),
    (error) => error.code === "ENTERPRISE_CREDENTIAL_MISSING"
  );
  const runtime = resolveManualEnterpriseRuntime(
    { bedrockAccessKeyId: "$BEDROCK_ACCESS_KEY_ID", bedrockSecretAccessKey: "literal-secret" },
    "bedrock",
    "m",
    resolveFromEnv({ BEDROCK_ACCESS_KEY_ID: "AKIAFAKE" })
  );
  assert.equal(runtime.enterprise.bedrockAccessKeyId, "AKIAFAKE");
  assert.equal(runtime.enterprise.bedrockSecretAccessKey, "literal-secret");
});

test("vertex key does not fill azure apiKey", () => {
  const runtime = resolveManualEnterpriseRuntime(
    { vertexApiKey: "vertex-secret", azureApiKey: "" },
    "azure",
    "gpt-4o",
    (value) => value || ""
  );
  assert.equal(runtime.apiKey, "");
  assert.equal(runtime.enterprise.vertexApiKey, "vertex-secret");
});

test("config.apiKey is resolved without mutating the caller object", () => {
  const config = { apiKey: "$AZURE_OPENAI_API_KEY", azureApiKey: "$AZURE_OPENAI_API_KEY" };
  const runtime = resolveManualEnterpriseRuntime(
    config,
    "azure",
    "gpt-4o",
    resolveFromEnv({ AZURE_OPENAI_API_KEY: "az-live" })
  );
  assert.equal(runtime.apiKey, "az-live");
  assert.equal(config.apiKey, "$AZURE_OPENAI_API_KEY");
  assert.equal(config.azureApiKey, "$AZURE_OPENAI_API_KEY");
});

test("missing resolver keeps literals and fails on a leftover $VAR", () => {
  const runtime = resolveManualEnterpriseRuntime(
    { apiKey: "sk-literal", azureApiKey: "sk-literal" },
    "azure",
    "gpt-4o"
  );
  assert.equal(runtime.apiKey, "sk-literal");
  assert.equal(runtime.enterprise.azureApiKey, "sk-literal");
  assert.throws(
    () =>
      resolveManualEnterpriseRuntime(
        { apiKey: "sk-literal", azureApiKey: "$AZURE_OPENAI_API_KEY" },
        "azure",
        "gpt-4o"
      ),
    (error) => error.code === "ENTERPRISE_CREDENTIAL_MISSING"
  );
});

test("manual enterprise auth accepts a legacy password returned by the credential resolver", () => {
  const runtime = resolveManualEnterpriseRuntime(
    { bedrockAccessKeyId: "fixture-id", bedrockSecretAccessKey: "$BEDROCK_SECRET_ACCESS_KEY" },
    "bedrock",
    "m",
    (field) => field === "$BEDROCK_SECRET_ACCESS_KEY" ? "${OLD_PASSWORD}" : field
  );
  assert.equal(runtime.enterprise.bedrockSecretAccessKey, "${OLD_PASSWORD}");
});
