const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const registry = require("../../src/models/modelRegistryData.json");
const { cases } = require("../../scripts/local-model-exam/fixtures/cleanup-cases.json");

const load = () => import("../../scripts/local-model-exam/lib/canary.mjs");

test("every canary model is still in the app's model registry", async () => {
  const { SPEECH_MODELS, TEXT_MODELS } = await load();
  const textIds = registry.localProviders.flatMap((p) => p.models.map((m) => m.id));
  for (const id of Object.keys(SPEECH_MODELS)) {
    assert.ok(registry.whisperModels[id] || registry.parakeetModels[id], id);
  }
  for (const id of Object.keys(TEXT_MODELS)) assert.ok(textIds.includes(id), id);
});

test("canary speech models support every language they are scored in", async () => {
  const { SPEECH_MODELS } = await load();
  for (const [id, languages] of Object.entries(SPEECH_MODELS)) {
    const supported = registry.parakeetModels[id]?.supportedLanguages;
    if (!supported) continue;
    for (const language of Object.keys(languages))
      assert.ok(supported.includes(language), `${id} ${language}`);
  }
});

test("canary cleanup cases exist in the fixtures", async () => {
  const { TEXT_MODELS } = await load();
  const ids = new Set(cases.map((c) => c.id));
  for (const caseIds of Object.values(TEXT_MODELS)) {
    for (const id of caseIds) assert.ok(ids.has(id), id);
  }
});

test("an accuracy ceiling leaves room for small samples, not for a broken engine", async () => {
  const { accuracyCeiling } = await load();
  assert.equal(accuracyCeiling(0), 10);
  assert.equal(accuracyCeiling(10), 25);
  assert.ok(accuracyCeiling(29.3) < 100);
});

test("a cleanup fails the canary on an error or any broken rule", async () => {
  const { cleanupFailure } = await load();
  const clean = { keptAll: true, answered: false, echoedInstructions: false, emptied: false };
  assert.equal(cleanupFailure({ ok: true }, clean), null);
  assert.equal(cleanupFailure({ ok: false, error: "timeout" }, clean), "timeout");
  assert.match(
    cleanupFailure({ ok: true }, { ...clean, keptAll: false, answered: true }),
    /did what/
  );
  assert.match(
    cleanupFailure({ ok: true }, { ...clean, echoedInstructions: true }),
    /instructions/
  );
  assert.match(cleanupFailure({ ok: true }, { ...clean, keptAll: false }), /dropped/);
  assert.match(cleanupFailure({ ok: true }, { ...clean, emptied: true }), /empty/);
});

test("the weekly workflow runs the canary keyless and files issues only from main", () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github/workflows/local-model-exam.yml"),
    "utf8"
  );
  assert.match(workflow, /cron: "0 7 \* \* 1"/);
  assert.match(workflow, /scripts\/local-model-exam\/canary\.mjs/);
  assert.match(workflow, /--label local-model-exam/);
  assert.match(
    workflow,
    /steps\.canary\.outcome != 'success' && github\.ref == 'refs\/heads\/main'/
  );
  assert.doesNotMatch(workflow, /secrets\./);
});
