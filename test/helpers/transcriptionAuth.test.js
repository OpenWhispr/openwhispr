const test = require("node:test");
const assert = require("node:assert/strict");

test("returns true for self-hosted mode with configured URL", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    true
  );
});

test("returns false for self-hosted mode without URL", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
    }),
    false
  );
});

test("returns false for self-hosted mode with whitespace-only URL", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "   ",
    }),
    false
  );
});

test("returns false for openai cloud provider mode", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "",
      cloudTranscriptionProvider: "openai",
      remoteTranscriptionUrl: "",
    }),
    false
  );
});

test("returns false when transcriptionMode is missing from settings", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(shouldSkipTranscriptionApiKey({}), false);
});

test("returns false for non-self-hosted mode even with URL configured", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "cloud",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    false
  );
});

test("custom Orukeet keeps its API key in the self-hosted fallback", async () => {
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    shouldSkipTranscriptionApiKey({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://orukeet.gizmovoice.ai/v1",
      remoteTranscriptionModel: "orukeet-v0.1.0",
      cloudTranscriptionProvider: "custom",
    }),
    false
  );
});

test("custom key source: license wins on our hosts, stored key elsewhere", async () => {
  const { customTranscriptionKeySource } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    customTranscriptionKeySource({ storedKey: "stale-key", isTitaniumService: true }),
    "titanium"
  );
  assert.equal(
    customTranscriptionKeySource({ storedKey: "", isTitaniumService: true }),
    "titanium"
  );
  assert.equal(
    customTranscriptionKeySource({ storedKey: "my-key", isTitaniumService: false }),
    "stored"
  );
  assert.equal(customTranscriptionKeySource({ storedKey: "  ", isTitaniumService: false }), "none");
});

test("cached key: never reused for Custom on our own hosts", async () => {
  const { canReuseCachedTranscriptionKey } = await import("../../src/helpers/transcriptionAuth.js");
  assert.equal(
    canReuseCachedTranscriptionKey({ provider: "custom", isTitaniumService: true }),
    false
  );
  assert.equal(
    canReuseCachedTranscriptionKey({ provider: "custom", isTitaniumService: false }),
    true
  );
  assert.equal(
    canReuseCachedTranscriptionKey({ provider: "openai", isTitaniumService: true }),
    true
  );
});

test("auth decisions follow the final request URL, never the cloud base URL alone", async () => {
  const { transcriptionDestinationUrl, customTranscriptionKeySource } =
    await import("../../src/helpers/transcriptionAuth.js");
  const { isTitaniumServiceUrl } = await import("../../src/helpers/titanium/titaniumHosts.js");
  const fork = { DEFAULT_STT: { baseUrl: "https://stt.titaniumlabs.test/v1" } };
  const source = (s, storedKey) =>
    customTranscriptionKeySource({
      storedKey,
      isTitaniumService: isTitaniumServiceUrl(transcriptionDestinationUrl(s), fork),
    });
  const cloud = "https://stt.titaniumlabs.test/v1";
  // retained non-Titanium remote URL wins routing: no license, even with the orukeet model
  assert.equal(
    source(
      {
        transcriptionMode: "self-hosted",
        remoteTranscriptionUrl: "https://old.example.com/v1",
        remoteTranscriptionModel: "orukeet-v0.1.0",
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionBaseUrl: cloud,
      },
      "mine"
    ),
    "stored"
  );
  // Titanium destination: license wins over a stale stored key
  assert.equal(
    source(
      {
        transcriptionMode: "self-hosted",
        remoteTranscriptionUrl: "",
        cloudTranscriptionBaseUrl: cloud,
      },
      "stale"
    ),
    "titanium"
  );
  // custom non-Titanium: stored key
  assert.equal(
    source(
      { transcriptionMode: "providers", cloudTranscriptionBaseUrl: "https://x.example.com/v1" },
      "mine"
    ),
    "stored"
  );
});
