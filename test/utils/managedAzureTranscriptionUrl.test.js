const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/urlUtils.ts");

test("v1 and preview aliases use the deployments route with the dated transcription version", async () => {
  const { buildManagedAzureTranscriptionUrl } = await load();
  for (const apiVersion of ["v1", "preview"]) {
    assert.equal(
      buildManagedAzureTranscriptionUrl(
        "https://acme.services.ai.azure.com",
        "gpt-4o-transcribe",
        apiVersion
      ),
      "https://acme.services.ai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview",
      apiVersion
    );
  }
});

test("dated versions pass through unchanged on the deployments route", async () => {
  const { buildManagedAzureTranscriptionUrl } = await load();
  assert.equal(
    buildManagedAzureTranscriptionUrl(
      "https://acme.openai.azure.com/",
      "gpt-4o-transcribe",
      "2025-03-01-preview"
    ),
    "https://acme.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

test("a dated version never lands on the /openai/v1/ route", async () => {
  const { buildManagedAzureTranscriptionUrl } = await load();
  for (const apiVersion of ["2025-03-01-preview", "2024-10-21"]) {
    const url = buildManagedAzureTranscriptionUrl(
      "https://acme.services.ai.azure.com",
      "gpt-4o-transcribe",
      apiVersion
    );
    assert.doesNotMatch(url, /\/openai\/v1\//, apiVersion);
    assert.match(url, /\/openai\/deployments\/gpt-4o-transcribe\//, apiVersion);
  }
});

test("an unparsable endpoint yields null", async () => {
  const { buildManagedAzureTranscriptionUrl } = await load();
  assert.equal(buildManagedAzureTranscriptionUrl("not a url", "d", "v1"), null);
});
