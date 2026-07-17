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

test("fan-out routes provider, model and mode to all five scopes", async () => {
  const { buildReasoningScopePatches } = await load();
  const {
    dictationCleanup,
    noteFormatting,
    dictationAgent,
    chatIntelligence,
    dictationTranslation,
  } = buildReasoningScopePatches(
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

  for (const scope of [noteFormatting, dictationAgent, chatIntelligence, dictationTranslation]) {
    assert.equal(scope.provider, "corti");
    assert.equal(scope.model, "corti-s1-instant");
    assert.equal(scope.cloudMode, "byok");
    assert.equal(scope.mode, "providers");
  }
});

test("fan-out with partial settings only mirrors the provided routing fields", async () => {
  const { buildReasoningScopePatches } = await load();
  const {
    dictationCleanup,
    noteFormatting,
    dictationAgent,
    chatIntelligence,
    dictationTranslation,
  } = buildReasoningScopePatches({ useCleanupModel: true }, "openwhispr");

  assert.equal(dictationCleanup.useCleanupModel, true);
  assert.equal(dictationCleanup.cleanupMode, "openwhispr");
  assert.equal("cleanupProvider" in dictationCleanup, false);

  for (const scope of [noteFormatting, dictationAgent, chatIntelligence, dictationTranslation]) {
    assert.equal(scope.mode, "openwhispr");
    assert.equal("provider" in scope, false);
    assert.equal("model" in scope, false);
    assert.equal("cloudMode" in scope, false);
  }
});

const OPENWHISPR_REASONING = { useCleanupModel: true, cleanupCloudMode: "openwhispr" };

test("onboarding routes transcription and reasoning to corti in the eu region with an api key", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }, { id: "corti-s1" }] },
    "eu",
    true
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
    "eu",
    true
  );
  assert.equal(reasoning.useCleanupModel, true);
});

test("us data region routes reasoning to openwhispr cloud, transcription stays corti", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    "us",
    true
  );

  assert.deepEqual(reasoning, OPENWHISPR_REASONING);
  assert.equal(transcription.cloudTranscriptionProvider, "corti");
});

test("eu region without an api key routes reasoning to openwhispr cloud", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    "eu",
    false
  );
  assert.deepEqual(reasoning, OPENWHISPR_REASONING);
});

test("undefined data region routes reasoning to openwhispr cloud", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [{ id: "corti-s1-instant" }] },
    undefined,
    true
  );
  assert.deepEqual(reasoning, OPENWHISPR_REASONING);
});

test("missing corti reasoning provider routes reasoning to openwhispr cloud", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { transcription, reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    undefined,
    "eu",
    true
  );

  assert.deepEqual(reasoning, OPENWHISPR_REASONING);
  assert.equal(transcription.cloudTranscriptionProvider, "corti");
});

test("corti reasoning provider with empty models routes reasoning to openwhispr cloud", async () => {
  const { buildCortiOnboardingPayloads } = await load();
  const { reasoning } = buildCortiOnboardingPayloads(
    { id: "corti", models: [{ id: "corti-transcribe" }] },
    { id: "corti", models: [] },
    "eu",
    true
  );
  assert.deepEqual(reasoning, OPENWHISPR_REASONING);
});
