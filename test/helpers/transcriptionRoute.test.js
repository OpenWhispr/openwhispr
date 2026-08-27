const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionRoute.ts");

const resolve = async (settings, extra = {}) => {
  const { resolveTranscriptionRoute } = await load();
  return resolveTranscriptionRoute({ settings, ...extra });
};

const MANAGED_OPENAI_ONLY = {
  status: "managed",
  appVersion: "1.8.2",
  policy: {
    version: 1,
    transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
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
};

test("self-hosted routes to the configured server and wins over stale flags", async () => {
  const route = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://192.168.1.5:11434/v1",
    remoteTranscriptionModel: "whisper-1",
    useLocalWhisper: true,
    cloudTranscriptionProvider: "mistral",
  });
  assert.equal(route.transport, "http-batch");
  assert.equal(route.provider, "self-hosted");
  assert.equal(route.endpoint, "http://192.168.1.5:11434/v1/audio/transcriptions");
  assert.deepEqual(route.auth, { scheme: "none", keyRef: null });
  assert.equal(route.sizeCapBytes, null);
});

test("self-hosted mode without a URL fails closed unless the provider is custom", async () => {
  for (const provider of ["openai", "groq", "mistral", "xai", "corti", "gemini", "tinfoil"]) {
    const route = await resolve({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
      cloudTranscriptionProvider: provider,
    });
    assert.equal(route.transport, "error", provider);
    assert.match(route.message, /not configured/, provider);
  }

  // byok+custom persists transcriptionMode="self-hosted" (deriveTranscriptionMode),
  // so a custom user with a cleared remote URL must still reach their endpoint.
  const customRoute = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
  });
  assert.equal(customRoute.transport, "http-batch");
  assert.equal(customRoute.provider, "custom");
  assert.equal(customRoute.endpoint, "https://stt.parasail.example.com/v1/audio/transcriptions");
});

test("self-hosted fails closed on invalid or public-http URLs", async () => {
  for (const remoteTranscriptionUrl of [
    "not a url",
    "ftp://localhost:8080",
    "http://example.com/v1",
  ]) {
    const route = await resolve({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl,
      cloudTranscriptionProvider: "openai",
    });
    assert.equal(route.transport, "error", remoteTranscriptionUrl);
    assert.match(route.message, /invalid or unsupported/, remoteTranscriptionUrl);
  }
});

test("local mode yields a bare local route; decode details stay with the local managers", async () => {
  assert.deepEqual(await resolve({ useLocalWhisper: true, whisperModel: "small" }), {
    transport: "local",
  });
});

test("proxied providers carry their quirks as route data", async () => {
  const tinfoil = await resolve({ cloudTranscriptionProvider: "tinfoil" });
  assert.equal(tinfoil.transport, "proxied");
  assert.equal(tinfoil.model, null, "tinfoil's attested client resolves its own model");

  const mistral = await resolve({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionModel: "voxtral-small-latest",
  });
  assert.equal(mistral.model, "voxtral-small-latest");

  const xai = await resolve({
    cloudTranscriptionProvider: "xai",
    preferredLanguage: "mk",
  });
  assert.equal(xai.model, "grok-stt", "recorded for history; executors omit the form field");
  assert.equal(xai.language, "mk");
  const xaiUnsupported = await resolve({
    cloudTranscriptionProvider: "xai",
    preferredLanguage: "yo",
  });
  assert.equal(xaiUnsupported.language, undefined, "outside the xAI ITN allowlist");

  const corti = await resolve({ cloudTranscriptionProvider: "corti", cortiTenant: " acme " });
  assert.equal(corti.model, "corti-transcribe");
  assert.equal(corti.language, "en", "Corti needs a concrete language even on auto");
  assert.equal(corti.cortiEnvironment, "us");
  assert.equal(corti.cortiTenant, "acme");

  const gemini = await resolve({ cloudTranscriptionProvider: "gemini" });
  assert.equal(gemini.transport, "proxied");
  assert.equal(gemini.model, "gemini-3.5-transcribe");
  assert.equal(
    gemini.sizeCapBytes,
    14 * 1024 * 1024,
    "inline base64 audio must fit Gemini's 20 MB request cap"
  );
});

test("byokFileSizeLimit matches the per-provider route caps", async () => {
  const { byokFileSizeLimit } = await load();
  assert.equal(byokFileSizeLimit("gemini"), 14 * 1024 * 1024);
  assert.equal(byokFileSizeLimit("openai"), 25 * 1024 * 1024);
});

test("custom requires a configured secure endpoint (empty, sentinel, garbage all fail)", async () => {
  const { resolveTranscriptionRoute } = await load();
  for (const cloudTranscriptionBaseUrl of [
    "",
    "   ",
    "https://api.openai.com/v1", // the untouched store default
    "not a url",
    "http://public.example.com/v1",
    "ftp://192.168.1.20/v1",
  ]) {
    const route = resolveTranscriptionRoute({
      settings: { cloudTranscriptionProvider: "custom", cloudTranscriptionBaseUrl },
    });
    assert.equal(route.transport, "error", cloudTranscriptionBaseUrl);
    assert.equal(route.code, "CUSTOM_ENDPOINT_INVALID", cloudTranscriptionBaseUrl);
  }

  const localhost = await resolve({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "http://localhost:1234/v1",
    cloudTranscriptionModel: "my-model",
  });
  assert.equal(localhost.transport, "http-batch");
  assert.equal(localhost.endpoint, "http://localhost:1234/v1/audio/transcriptions");
  assert.equal(localhost.model, "my-model");
  assert.deepEqual(localhost.auth, { scheme: "bearer", keyRef: "custom" });
});

test("a custom URL pointing at Tinfoil's host must use the attested proxy", async () => {
  const route = await resolve(
    {
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
    },
    { providers: [{ id: "tinfoil", baseUrl: "https://inference.tinfoil.sh/v1" }] }
  );
  assert.equal(route.transport, "error");
  assert.match(route.message, /attested main-process proxy/);
});

test("Azure custom endpoints build deployment URLs from the raw base", async () => {
  const route = await resolve({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });
  assert.equal(
    route.endpoint,
    "https://myres.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
  assert.deepEqual(route.auth, { scheme: "azure-api-key", keyRef: "custom" });

  // A user-pinned full path survives — normalization must not strip it.
  const pinned = await resolve({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl:
      "https://myres.openai.azure.com/openai/deployments/d1/audio/transcriptions?api-version=2024-06-01",
    cloudTranscriptionModel: "ignored",
  });
  assert.match(pinned.endpoint, /deployments\/d1\/audio\/transcriptions\?api-version=2024-06-01/);
});

// migrateProviderSettings files every legacy `custom + byok` user under
// transcriptionMode "self-hosted" and copies their base URL across, so Azure
// endpoints reach the resolver through this branch too.
test("Azure self-hosted endpoints build deployment URLs, like Custom ones", async () => {
  const route = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myres.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(route.provider, "self-hosted");
  assert.equal(
    route.endpoint,
    "https://myres.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );

  const pinned = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl:
      "https://myres.openai.azure.com/openai/deployments/d1/audio/transcriptions?api-version=2024-06-01",
    remoteTranscriptionModel: "ignored",
  });
  assert.match(pinned.endpoint, /deployments\/d1\/audio\/transcriptions\?api-version=2024-06-01/);

  // Non-Azure self-hosted servers keep the plain OpenAI-compatible path.
  const plain = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://stt.internal.example.com",
    remoteTranscriptionModel: "tiny",
  });
  assert.equal(plain.endpoint, "https://stt.internal.example.com/audio/transcriptions");
});

test("openai and groq route to fixed endpoints with provider-validated models", async () => {
  const openai = await resolve({});
  assert.equal(openai.provider, "openai");
  assert.equal(openai.endpoint, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(openai.model, "gpt-4o-mini-transcribe");
  assert.equal(openai.sizeCapBytes, 25 * 1024 * 1024);

  const groqStale = await resolve({
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "voxtral-mini-latest", // stale from a mistral era
  });
  assert.equal(groqStale.endpoint, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(groqStale.model, "whisper-large-v3-turbo", "mismatched model degrades to default");
  assert.deepEqual(groqStale.auth, { scheme: "bearer", keyRef: "groq" });
});

test("managed policy is a fail-closed floor", async () => {
  const blocked = await resolve(
    { transcriptionMode: "providers", cloudTranscriptionProvider: "groq" },
    { policy: MANAGED_OPENAI_ONLY }
  );
  assert.equal(blocked.transport, "error");
  assert.equal(blocked.code, "POLICY_RESTRICTED");

  const allowed = await resolve(
    { transcriptionMode: "providers", cloudTranscriptionProvider: "openai" },
    { policy: MANAGED_OPENAI_ONLY }
  );
  assert.equal(allowed.transport, "http-batch");

  // Managed orgs see the policy message for a broken custom endpoint, never
  // the config hint (pins the Phase 1 precedence).
  const managedCustom = await resolve(
    {
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "",
    },
    {
      policy: {
        ...MANAGED_OPENAI_ONLY,
        policy: {
          ...MANAGED_OPENAI_ONLY.policy,
          transcription: { allowedModes: ["providers"], allowedByokProviders: ["custom"] },
        },
      },
    }
  );
  assert.equal(managedCustom.code, "POLICY_RESTRICTED");
});

test("request overrides win: explicit model and effective language", async () => {
  const route = await resolve(
    { cloudTranscriptionProvider: "groq", preferredLanguage: "de-DE" },
    { request: { model: "whisper-large-v3", effectiveLanguage: "ja" } }
  );
  assert.equal(route.model, "whisper-large-v3");
  assert.equal(route.language, "ja");
});
