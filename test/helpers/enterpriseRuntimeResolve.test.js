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

test("unset azure ref becomes empty instead of Bearer $VAR", () => {
  const runtime = resolveManualEnterpriseRuntime(
    { azureApiKey: "$AZURE_OPENAI_API_KEY" },
    "azure",
    "gpt-4o",
    resolveFromEnv({})
  );
  assert.equal(runtime.apiKey, "");
  assert.equal(runtime.enterprise.azureApiKey, "");
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

test("missing resolver strips leftover $VAR but keeps literals", () => {
  const runtime = resolveManualEnterpriseRuntime(
    { apiKey: "sk-literal", azureApiKey: "$AZURE_OPENAI_API_KEY" },
    "azure",
    "gpt-4o"
  );
  assert.equal(runtime.apiKey, "sk-literal");
  assert.equal(runtime.enterprise.azureApiKey, "");
});
