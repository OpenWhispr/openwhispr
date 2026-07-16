const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionRoute.js");

test("self-hosted routes to the configured server and wins over stale flags", async () => {
  const { resolveTranscriptionRoute } = await load();
  const route = resolveTranscriptionRoute({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://192.168.1.5:11434/v1",
    remoteTranscriptionModel: "whisper-1",
    useLocalWhisper: true,
    cloudTranscriptionMode: "openwhispr",
    cloudTranscriptionProvider: "mistral",
  });
  assert.equal(route.transport, "http-batch");
  assert.equal(route.isSelfHosted, true);
  assert.equal(route.endpoint, "http://192.168.1.5:11434/v1/audio/transcriptions");
  assert.equal(route.model, "whisper-1");
  assert.deepEqual(route.auth, { scheme: "none", keyRef: null });
  assert.equal(route.sizeCapBytes, null);
});

test("self-hosted fails closed on missing, invalid, or public-http URLs", async () => {
  const { resolveTranscriptionRoute } = await load();
  for (const [remoteTranscriptionUrl, messageKey] of [
    ["", "transcription.routeErrors.selfHostedUrlMissing"],
    ["   ", "transcription.routeErrors.selfHostedUrlMissing"],
    ["not a url", "transcription.routeErrors.selfHostedUrlInvalid"],
    ["ftp://localhost:8080", "transcription.routeErrors.selfHostedUrlInvalid"],
    ["http://example.com/v1", "transcription.routeErrors.selfHostedUrlInvalid"],
  ]) {
    const route = resolveTranscriptionRoute({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl,
      cloudTranscriptionProvider: "openai",
    });
    assert.equal(route.transport, "error", remoteTranscriptionUrl);
    assert.equal(route.messageKey, messageKey, remoteTranscriptionUrl);
  }
});

test("local mode selects whisper or parakeet with model defaults", async () => {
  const { resolveTranscriptionRoute } = await load();
  assert.deepEqual(resolveTranscriptionRoute({ useLocalWhisper: true, whisperModel: "small" }), {
    transport: "local",
    provider: "whisper",
    model: "small",
    language: undefined,
  });
  const nvidia = resolveTranscriptionRoute({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    preferredLanguage: "de-DE",
  });
  assert.equal(nvidia.provider, "nvidia");
  assert.equal(nvidia.model, "parakeet-tdt-0.6b-v3");
  assert.equal(nvidia.language, "de");
});

test("openwhispr cloud mode requires auth and carries the language", async () => {
  const { resolveTranscriptionRoute } = await load();
  const route = resolveTranscriptionRoute({
    cloudTranscriptionMode: "openwhispr",
    preferredLanguage: "fr",
  });
  assert.deepEqual(route, { transport: "openwhispr-cloud", requiresAuth: true, language: "fr" });
});

test("openai and groq route to their fixed endpoints with bearer keyRefs and the BYOK cap", async () => {
  const { resolveTranscriptionRoute, BYOK_FILE_SIZE_LIMIT } = await load();
  const openai = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-transcribe",
  });
  assert.equal(openai.endpoint, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(openai.model, "gpt-4o-transcribe");
  assert.deepEqual(openai.auth, { scheme: "bearer", keyRef: "openai" });
  assert.equal(openai.sizeCapBytes, BYOK_FILE_SIZE_LIMIT);

  const groq = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3",
  });
  assert.equal(groq.endpoint, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(groq.model, "whisper-large-v3");
  assert.equal(groq.auth.keyRef, "groq");
});

test("an explicitly chosen model is preserved; a stale cross-provider model falls to the default", async () => {
  const { resolveTranscriptionRoute } = await load();
  const stale = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
  });
  assert.equal(stale.model, "whisper-large-v3-turbo");
  const kept = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "whisper-1",
  });
  assert.equal(kept.model, "whisper-1");
});

test("proxied providers return ipc-proxy routes with their quirks", async () => {
  const { resolveTranscriptionRoute } = await load();
  const tinfoil = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "tinfoil",
  });
  assert.deepEqual(tinfoil, {
    transport: "ipc-proxy-batch",
    provider: "tinfoil",
    model: null,
    language: undefined,
  });

  const mistral = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionModel: "voxtral-small-latest",
    preferredLanguage: "it",
  });
  assert.equal(mistral.provider, "mistral");
  assert.equal(mistral.model, "voxtral-small-latest");
  assert.equal(mistral.language, "it");

  const corti = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "corti",
    preferredLanguage: "auto",
    cortiTenant: "  ",
  });
  assert.equal(corti.model, "corti-transcribe");
  assert.equal(corti.language, "en");
  assert.equal(corti.cortiEnvironment, "us");
  assert.equal(corti.cortiTenant, "base");
});

test("xai drops the model field and filters language through its allowlist", async () => {
  const { resolveTranscriptionRoute } = await load();
  const supported = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "xai",
    preferredLanguage: "de",
  });
  assert.equal(supported.model, null);
  assert.equal(supported.language, "de");
  const unsupported = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "xai",
    preferredLanguage: "uk",
  });
  assert.equal(unsupported.language, undefined);
});

test("custom endpoints build {base}/audio/transcriptions, keep full-path URLs, and are uncapped", async () => {
  const { resolveTranscriptionRoute } = await load();
  const route = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://api.parasail.io/v1",
    cloudTranscriptionModel: "open64qlxjh2-whisper-large-v3",
  });
  assert.equal(route.endpoint, "https://api.parasail.io/v1/audio/transcriptions");
  assert.equal(route.model, "open64qlxjh2-whisper-large-v3");
  assert.deepEqual(route.auth, { scheme: "bearer", keyRef: "custom" });
  assert.equal(route.sizeCapBytes, null);

  const fullPath = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "http://localhost:8080/v1/audio/transcriptions",
  });
  assert.equal(fullPath.endpoint, "http://localhost:8080/v1/audio/transcriptions");
  assert.equal(fullPath.model, "whisper-1");
});

test("custom endpoints fail closed on missing or insecure URLs (never default to OpenAI)", async () => {
  const { resolveTranscriptionRoute } = await load();
  for (const [cloudTranscriptionBaseUrl, messageKey] of [
    ["", "transcription.routeErrors.customUrlMissing"],
    ["http://example.com/v1", "transcription.routeErrors.customUrlInvalid"],
    ["garbage", "transcription.routeErrors.customUrlInvalid"],
  ]) {
    const route = resolveTranscriptionRoute({
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(route.transport, "error", cloudTranscriptionBaseUrl);
    assert.equal(route.messageKey, messageKey, cloudTranscriptionBaseUrl);
    assert.ok(!JSON.stringify(route).includes("api.openai.com"));
  }
});

test("Azure custom endpoints get the deployment URL and api-key auth", async () => {
  const { resolveTranscriptionRoute } = await load();
  const route = resolveTranscriptionRoute({
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "whisper-deploy",
  });
  assert.equal(route.auth.scheme, "azure-api-key");
  assert.match(
    route.endpoint,
    /\/openai\/deployments\/whisper-deploy\/audio\/transcriptions\?api-version=/
  );
});
