const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/urlUtils.ts");

test("v1 and preview both use the v1 audio route with api-version=preview (GA v1 serves no audio)", async () => {
  const { buildManagedAzureTranscriptionUrl } = await load();
  for (const apiVersion of ["v1", "preview"]) {
    assert.equal(
      buildManagedAzureTranscriptionUrl("https://acme.services.ai.azure.com", "gpt-4o-transcribe", apiVersion),
      "https://acme.services.ai.azure.com/openai/v1/audio/transcriptions?api-version=preview",
      apiVersion
    );
  }
});

test("dated versions use the legacy deployments route", async () => {
  const { buildManagedAzureTranscriptionUrl } = await load();
  assert.equal(
    buildManagedAzureTranscriptionUrl("https://acme.openai.azure.com/", "gpt-4o-transcribe", "2025-03-01-preview"),
    "https://acme.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

test("an unparsable endpoint yields null", async () => {
  const { buildManagedAzureTranscriptionUrl } = await load();
  assert.equal(buildManagedAzureTranscriptionUrl("not a url", "d", "v1"), null);
});
