const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const modelData = require("../../src/models/modelRegistryData.json");

// PROVIDER_REGISTRY is TypeScript, so node --test can't require it. Parse its
// keys from source the way secretKeys.test.js mirrors preload's inlined list.
function inferenceProviderIds() {
  const src = fs.readFileSync(
    path.join(__dirname, "../../src/services/ai/inferenceProviders/index.ts"),
    "utf8"
  );
  const block = src.match(/PROVIDER_REGISTRY[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(block, "PROVIDER_REGISTRY declared in inferenceProviders/index.ts");
  const ids = [...block[1].matchAll(/^\s*([A-Za-z][\w-]*):/gm)].map((m) => m[1]);
  assert.ok(ids.length > 0, "parsed at least one provider id");
  return ids;
}

const localIds = modelData.localProviders.map((p) => p.id);
const cloudIds = modelData.cloudProviders.map((p) => p.id);
const enterpriseIds = modelData.enterpriseProviders.map((p) => p.id);

test("every selectable cloud and enterprise provider has an inference handler", () => {
  const handlers = inferenceProviderIds();
  assert.ok(cloudIds.length > 0 && enterpriseIds.length > 0, "catalogs are non-empty");

  for (const id of [...cloudIds, ...enterpriseIds]) {
    assert.ok(handlers.includes(id), `provider "${id}" is selectable but has no inference handler`);
  }
});

test("local catalog ids never shadow an inference provider id", () => {
  // resolveInferenceProvider maps a local catalog id (qwen, gemma, …) to the
  // llama.cpp "local" provider by looking it up in the model registry, so a
  // cloud provider sharing one of those ids would silently route to llama.cpp.
  const handlers = inferenceProviderIds();
  assert.ok(localIds.length > 0, "local catalog is non-empty");

  for (const id of localIds) {
    assert.ok(!handlers.includes(id), `local catalog id "${id}" shadows an inference provider`);
    assert.ok(!cloudIds.includes(id), `"${id}" is both a local catalog and a cloud provider`);
    assert.ok(
      !enterpriseIds.includes(id),
      `"${id}" is both a local catalog and an enterprise provider`
    );
  }
});
