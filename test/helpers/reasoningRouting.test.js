const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/reasoningRouting.js");

test("byok cloud provider maps to the providers mode", async () => {
  const { deriveReasoningMode } = await load();
  assert.equal(deriveReasoningMode("byok", "corti"), "providers");
});

test("byok custom provider maps to the self-hosted mode", async () => {
  const { deriveReasoningMode } = await load();
  assert.equal(deriveReasoningMode("byok", "custom"), "self-hosted");
});

test("openwhispr cloud mode maps to the openwhispr mode", async () => {
  const { deriveReasoningMode } = await load();
  assert.equal(deriveReasoningMode("openwhispr", "corti"), "openwhispr");
});

test("fan-out routes provider, model and mode to all four scopes", async () => {
  const { buildReasoningScopePatches } = await load();
  const { dictationCleanup, noteFormatting, dictationAgent, chatIntelligence } =
    buildReasoningScopePatches(
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

  for (const scope of [noteFormatting, dictationAgent, chatIntelligence]) {
    assert.equal(scope.provider, "corti");
    assert.equal(scope.model, "corti-s1-instant");
    assert.equal(scope.cloudMode, "byok");
    assert.equal(scope.mode, "providers");
  }
});

test("fan-out with partial settings only mirrors the provided routing fields", async () => {
  const { buildReasoningScopePatches } = await load();
  const { dictationCleanup, noteFormatting, dictationAgent, chatIntelligence } =
    buildReasoningScopePatches({ useCleanupModel: true }, "openwhispr");

  assert.equal(dictationCleanup.useCleanupModel, true);
  assert.equal(dictationCleanup.cleanupMode, "openwhispr");
  assert.equal("cleanupProvider" in dictationCleanup, false);

  for (const scope of [noteFormatting, dictationAgent, chatIntelligence]) {
    assert.equal(scope.mode, "openwhispr");
    assert.equal("provider" in scope, false);
    assert.equal("model" in scope, false);
    assert.equal("cloudMode" in scope, false);
  }
});

test("onboarding payloads route both transcription and reasoning to corti in the eu region", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, reasoning } = buildCortiOnboardingPayloads(
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
  assert.deepEqual(reasoning, {
    useCleanupModel: true,
    cleanupProvider: "corti",
    cleanupModel: "corti-s1-instant",
    cleanupCloudMode: "byok",
  });
});

test("onboarding forces cleanup enabled on the corti path", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    "eu"
  );
  assert.equal(reasoning.useCleanupModel, true);
});

test("us data region yields no reasoning payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    "us"
  );

  assert.equal(reasoning, null);
  assert.equal(transcription.cloudTranscriptionProvider, "corti");
});

test("undefined data region yields no reasoning payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    undefined
  );
  assert.equal(reasoning, null);
});

test("missing corti reasoning provider yields no reasoning payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    undefined,
    "eu"
  );

  assert.equal(reasoning, null);
  assert.equal(transcription.cloudTranscriptionProvider, "corti");
});

test("corti reasoning provider with empty models yields no reasoning payload", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [] },
    "eu"
  );
  assert.equal(reasoning, null);
});
