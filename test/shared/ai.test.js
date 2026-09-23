const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveInferenceRoute, getProvidersForScope } = require("../../shared/ai/routing.ts");
const { normalizeBaseUrl, isSecureHttpEndpoint } = require("../../shared/ai/endpoints.ts");

const selection = {
  mode: "providers",
  providerId: "groq",
  modelId: "whisper-large-v3-turbo",
  credentialRef: "provider.groq",
};
const input = { scope: "dictation", selection, policy: { status: "unmanaged" } };

test("BYOK preserves the selected destination without an account", () => {
  const result = resolveInferenceRoute(input);
  assert.equal(result.ok, true);
  assert.equal(result.route.providerId, "groq");
  assert.equal(result.route.modelId, "whisper-large-v3-turbo");
  assert.equal(result.route.mode, "providers");
});
test("private content refuses remote selection", () => {
  assert.deepEqual(resolveInferenceRoute({ ...input, privateContent: true }), {
    ok: false,
    code: "PRIVATE_CONTENT",
  });
});
test("unresolved organization policy refuses direct provider requests", () => {
  assert.deepEqual(resolveInferenceRoute({ ...input, policy: { status: "pending" } }), {
    ok: false,
    code: "POLICY_UNRESOLVED",
  });
});
test("unsupported provider/model combinations never fall through to another provider", () => {
  assert.equal(
    resolveInferenceRoute({ ...input, selection: { ...selection, modelId: "whisper-1" } }).code,
    "MODEL_UNSUPPORTED"
  );
  assert.equal(resolveInferenceRoute({ ...input, scope: "meeting" }).code, "PROVIDER_UNSUPPORTED");
});
test("live meetings have no personal-provider route", () => {
  assert.deepEqual(getProvidersForScope("meeting"), []);
});
test("text providers are limited to those with a known chat endpoint", () => {
  assert.deepEqual(
    getProvidersForScope("cleanup").map((p) => p.id),
    ["openai", "groq", "openrouter", "custom"]
  );
});
test("text routes accept an explicitly discovered model id without changing provider", () => {
  const result = resolveInferenceRoute({
    scope: "cleanup",
    selection: {
      mode: "providers",
      providerId: "openai",
      modelId: "ft:gpt-4.1-mini:example",
      credentialRef: "provider.openai",
    },
    policy: { status: "unmanaged" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.route.providerId, "openai");
  assert.equal(result.route.modelId, "ft:gpt-4.1-mini:example");
});
test("managed allowlists apply independently to text and speech", () => {
  const policy = {
    status: "managed",
    transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
    llm: { allowedModes: ["providers"], allowedByokProviders: ["groq"] },
  };
  assert.equal(resolveInferenceRoute({ ...input, policy }).code, "POLICY_BLOCKED");
  assert.equal(
    resolveInferenceRoute({
      ...input,
      scope: "cleanup",
      selection: { ...selection, modelId: "openai/gpt-oss-120b" },
      policy,
    }).ok,
    true
  );
});
test("custom endpoint credentials cannot redirect a built-in provider", () => {
  const result = resolveInferenceRoute({
    ...input,
    selection: { ...selection, endpoint: "https://unrelated.example/v1" },
  });
  assert.equal(result.route.endpoint, "https://api.groq.com/openai/v1");
});
test("custom endpoints follow desktop private-network rules", () => {
  assert.equal(isSecureHttpEndpoint("http://10.0.0.2:8000/v1"), true);
  assert.equal(isSecureHttpEndpoint("http://10.example.com/v1"), false);
  assert.equal(isSecureHttpEndpoint("http://server.example/v1"), false);
  assert.equal(
    normalizeBaseUrl(" https://server.example/v1/chat/completions "),
    "https://server.example/v1"
  );
  assert.equal(
    resolveInferenceRoute({
      ...input,
      selection: {
        mode: "providers",
        providerId: "custom",
        modelId: "my-model",
        endpoint: "http://server.example/v1",
      },
    }).code,
    "ENDPOINT_INVALID"
  );
});
test("missing credentials and model choices fail without changing selection", () => {
  assert.equal(
    resolveInferenceRoute({ ...input, selection: { ...selection, credentialRef: undefined } }).code,
    "CREDENTIAL_REQUIRED"
  );
  assert.equal(
    resolveInferenceRoute({ ...input, selection: { ...selection, modelId: "" } }).code,
    "MODEL_REQUIRED"
  );
});
