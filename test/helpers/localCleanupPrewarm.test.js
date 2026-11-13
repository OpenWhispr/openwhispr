const test = require("node:test");
const assert = require("node:assert/strict");

const { prewarmLocalCleanup } = require("../../src/helpers/localCleanupPrewarm.js");

const LOCAL_ENV = { CLEANUP_PROVIDER: "local", LOCAL_CLEANUP_MODEL: "gemma-4-e2b-it-qat-q4_0" };

function makeModelManager({ running = false, loadedModelId = null } = {}) {
  const prewarmed = [];
  return {
    prewarmed,
    currentServerModelId: loadedModelId,
    getServerStatus: () => ({ running }),
    prewarmServer: async (modelId) => {
      prewarmed.push(modelId);
      return true;
    },
  };
}

test("a stopped server reloads the local cleanup model", async () => {
  const manager = makeModelManager();
  assert.equal(await prewarmLocalCleanup(manager, LOCAL_ENV), true);
  assert.deepEqual(manager.prewarmed, ["gemma-4-e2b-it-qat-q4_0"]);
});

test("a server already holding the cleanup model is only touched", async () => {
  const manager = makeModelManager({ running: true, loadedModelId: "gemma-4-e2b-it-qat-q4_0" });
  await prewarmLocalCleanup(manager, LOCAL_ENV);
  assert.deepEqual(manager.prewarmed, ["gemma-4-e2b-it-qat-q4_0"]);
});

test("a server holding another scope's model is left alone", async () => {
  const manager = makeModelManager({ running: true, loadedModelId: "qwen3-8b-q4_k_m" });
  assert.equal(await prewarmLocalCleanup(manager, LOCAL_ENV), false);
  assert.deepEqual(manager.prewarmed, []);
});

test("cleanup that is not local loads nothing", async () => {
  for (const env of [{}, { CLEANUP_PROVIDER: "local" }, { LOCAL_CLEANUP_MODEL: "gemma" }]) {
    const manager = makeModelManager();
    assert.equal(await prewarmLocalCleanup(manager, env), false);
    assert.deepEqual(manager.prewarmed, []);
  }
});
