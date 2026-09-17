const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/modelFamilyConstraints.ts");

test("family lookup matches anywhere in the id, case-insensitively", async () => {
  const { getModelFamilyConstraints } = await load();
  assert.equal(getModelFamilyConstraints("openai/GPT-OSS-120b")?.family, "gpt-oss");
  assert.equal(getModelFamilyConstraints("gpt-oss-safeguard-120b")?.family, "gpt-oss");
  assert.equal(getModelFamilyConstraints("qwen/qwen3-32b")?.family, "qwen");
  assert.equal(getModelFamilyConstraints("magistral-small-latest")?.family, "magistral");
});

test("unknown, empty, and missing ids resolve to no constraints", async () => {
  const { getModelFamilyConstraints } = await load();
  assert.equal(getModelFamilyConstraints("gpt-4o"), null);
  assert.equal(getModelFamilyConstraints(""), null);
  assert.equal(getModelFamilyConstraints(undefined), null);
});

test("gpt-oss has no reasoning off switch: suppress and cleanup both floor at low", async () => {
  const { getModelFamilyConstraints } = await load();
  const effort = getModelFamilyConstraints("gpt-oss-120b")?.reasoningEffort;
  assert.deepEqual(effort, { suppressValue: "low", cleanupValue: "low" });
});

test("gpt-5 family pins minimal effort for cleanup and suppression", async () => {
  const { getModelFamilyConstraints } = await load();
  for (const id of ["gpt-5-nano", "gpt-5-mini", "gpt-5.2", "openai/gpt-5-mini", "GPT-5-Nano"]) {
    const constraints = getModelFamilyConstraints(id);
    assert.equal(constraints?.family, "gpt-5", id);
    assert.deepEqual(constraints?.reasoningEffort, {
      suppressValue: "minimal",
      cleanupValue: "minimal",
    });
  }
});

test("gpt-5 boundary excludes lookalike ids and leaves gpt-oss on its own entry", async () => {
  const { getModelFamilyConstraints } = await load();
  assert.equal(getModelFamilyConstraints("gpt-oss-120b")?.family, "gpt-oss");
  assert.equal(getModelFamilyConstraints("somegpt-5x"), null);
  assert.equal(getModelFamilyConstraints("gpt-4.1-mini"), null);
});
