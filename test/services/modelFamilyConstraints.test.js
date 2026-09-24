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

test("glm-5.3 always reasons: suppress floors at low, no cleanup pin (server max default)", async () => {
  const { getModelFamilyConstraints } = await load();
  assert.deepEqual(getModelFamilyConstraints("glm-5.3")?.reasoningEffort, {
    suppressValue: "low",
  });
  assert.equal(getModelFamilyConstraints("glm-5.3-flash")?.family, "glm-5.3");
  assert.equal(getModelFamilyConstraints("glm-5-3")?.family, "glm-5.3");
  assert.equal(getModelFamilyConstraints("GLM-5.3-Flash:cloud")?.family, "glm-5.3");
  assert.equal(getModelFamilyConstraints("glm-5-2")?.family, undefined);
});
