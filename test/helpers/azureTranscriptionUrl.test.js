const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

test("isAzureOpenAIEndpoint detects Azure resource hosts", async () => {
  const { isAzureOpenAIEndpoint } = await import("../../src/utils/urlUtils.ts");

  assert.equal(isAzureOpenAIEndpoint("https://r.cognitiveservices.azure.com/openai/v1"), true);
  assert.equal(isAzureOpenAIEndpoint("https://r.openai.azure.com"), true);
  assert.equal(isAzureOpenAIEndpoint("https://r.services.ai.azure.com/openai/v1"), true);
  assert.equal(isAzureOpenAIEndpoint("https://api.openai.com/v1"), false);
  assert.equal(isAzureOpenAIEndpoint("not a url"), false);
});

test("buildAzureTranscriptionUrl builds the deployment-style URL from a resource base", async () => {
  const { buildAzureTranscriptionUrl } = await import("../../src/utils/urlUtils.ts");

  assert.equal(
    buildAzureTranscriptionUrl(
      "https://my-resource.cognitiveservices.azure.com/openai/v1",
      "gpt-4o-transcribe"
    ),
    "https://my-resource.cognitiveservices.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

test("buildAzureTranscriptionUrl honors an explicit api-version argument", async () => {
  const { buildAzureTranscriptionUrl } = await import("../../src/utils/urlUtils.ts");

  assert.equal(
    buildAzureTranscriptionUrl("https://r.openai.azure.com", "whisper", "2024-06-01"),
    "https://r.openai.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01"
  );
});

test("buildAzureTranscriptionUrl respects a full transcription URL the user already pasted", async () => {
  const { buildAzureTranscriptionUrl } = await import("../../src/utils/urlUtils.ts");

  const full =
    "https://r.cognitiveservices.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview";
  assert.equal(buildAzureTranscriptionUrl(full, "ignored"), full);
});

test("buildAzureTranscriptionUrl returns null when no deployment name is available", async () => {
  const { buildAzureTranscriptionUrl } = await import("../../src/utils/urlUtils.ts");

  assert.equal(buildAzureTranscriptionUrl("https://r.cognitiveservices.azure.com", ""), null);
});

// getTranscriptionEndpoint feeds buildAzureTranscriptionUrl the raw base, not the
// normalized one, because normalizeBaseUrl strips the /audio/transcriptions suffix
// that marks a deployment the user pinned by pasting their full Azure endpoint.
test("a pinned Azure endpoint survives base-URL normalization", async () => {
  const { buildAzureTranscriptionUrl } = await import("../../src/utils/urlUtils.ts");
  const { normalizeBaseUrl } = await import("../../src/config/constants.ts");

  for (const pinned of [
    "https://r.openai.azure.com/openai/deployments/my-deploy/audio/transcriptions?api-version=2024-06-01",
    "https://r.openai.azure.com/openai/deployments/my-deploy/audio/transcriptions",
  ]) {
    assert.equal(buildAzureTranscriptionUrl(pinned, "whisper-1"), pinned);
    assert.notEqual(buildAzureTranscriptionUrl(normalizeBaseUrl(pinned), "whisper-1"), pinned);
  }
});

test("a bare Azure resource base still rebuilds from the deployment name", async () => {
  const { buildAzureTranscriptionUrl } = await import("../../src/utils/urlUtils.ts");
  const { normalizeBaseUrl } = await import("../../src/config/constants.ts");

  const bare = "https://r.openai.azure.com";

  assert.equal(
    buildAzureTranscriptionUrl(bare, "my-deploy"),
    buildAzureTranscriptionUrl(normalizeBaseUrl(bare), "my-deploy")
  );
});
