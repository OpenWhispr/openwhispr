const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/cleanupRouting.js");

test("byok cloud provider maps to the providers mode", async () => {
  const { deriveCleanupMode } = await load();
  assert.equal(deriveCleanupMode("byok", "corti"), "providers");
});

test("byok custom provider maps to the self-hosted mode", async () => {
  const { deriveCleanupMode } = await load();
  assert.equal(deriveCleanupMode("byok", "custom"), "self-hosted");
});

test("openwhispr cloud mode maps to the openwhispr mode", async () => {
  const { deriveCleanupMode } = await load();
  assert.equal(deriveCleanupMode("openwhispr", "corti"), "openwhispr");
});

test("fan-out routes provider, model and mode to both cleanup scopes", async () => {
  const { buildCleanupScopePatches } = await load();
  const { dictationCleanup, noteFormatting } = buildCleanupScopePatches(
    {
      useCleanupModel: true,
      cleanupProvider: "corti",
      cleanupModel: "corti-s1-instant",
      cleanupCloudMode: "byok",
    },
    "providers"
  );

  assert.equal(dictationCleanup.cleanupProvider, "corti");
  assert.equal(dictationCleanup.cleanupModel, "corti-s1-instant");
  assert.equal(dictationCleanup.cleanupMode, "providers");

  assert.equal(noteFormatting.provider, "corti");
  assert.equal(noteFormatting.model, "corti-s1-instant");
  assert.equal(noteFormatting.cloudMode, "byok");
  assert.equal(noteFormatting.mode, "providers");
});

test("fan-out with partial settings only mirrors the provided routing fields", async () => {
  const { buildCleanupScopePatches } = await load();
  const { dictationCleanup, noteFormatting } = buildCleanupScopePatches(
    { useCleanupModel: true },
    "openwhispr"
  );

  assert.equal(dictationCleanup.useCleanupModel, true);
  assert.equal(dictationCleanup.cleanupMode, "openwhispr");
  assert.equal("cleanupProvider" in dictationCleanup, false);

  assert.equal(noteFormatting.mode, "openwhispr");
  assert.equal("provider" in noteFormatting, false);
  assert.equal("model" in noteFormatting, false);
  assert.equal("cloudMode" in noteFormatting, false);
});

test("onboarding payloads route both transcription and cleanup to corti", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, cleanup } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }, { id: "corti-s1" }] },
    "eu"
  );

  assert.deepEqual(transcription, {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionModel: "corti-transcribe",
  });
  assert.deepEqual(cleanup, {
    useCleanupModel: true,
    cleanupProvider: "corti",
    cleanupModel: "corti-s1-instant",
    cleanupCloudMode: "byok",
  });
});

test("onboarding forces cleanup enabled on the corti path", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { cleanup } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    "eu"
  );
  assert.equal(cleanup.useCleanupModel, true);
});

test("missing corti reasoning provider yields no cleanup payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, cleanup } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    undefined,
    "eu"
  );

  assert.equal(cleanup, null);
  assert.equal(transcription.cloudTranscriptionProvider, "corti");
});

test("corti reasoning provider with empty models yields no cleanup payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { cleanup } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [] },
    "eu"
  );
  assert.equal(cleanup, null);
});

test("environment us yields the transcription payload but null cleanup", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, cleanup } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    "us"
  );

  assert.deepEqual(transcription, {
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionModel: "corti-transcribe",
  });
  assert.equal(cleanup, null);
});

test("undefined environment yields no cleanup payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { cleanup } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    undefined
  );
  assert.equal(cleanup, null);
});

test("environment eu yields the cleanup payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { cleanup } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    "eu"
  );
  assert.deepEqual(cleanup, {
    useCleanupModel: true,
    cleanupProvider: "corti",
    cleanupModel: "corti-s1-instant",
    cleanupCloudMode: "byok",
  });
});
