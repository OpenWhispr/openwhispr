const test = require("node:test");
const assert = require("node:assert/strict");

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

test("pending local model selections remain isolated by scope", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "base" });
  pending.rememberPendingLocalModel("assistant", {
    provider: "qwen",
    modelId: "qwen3.5-4b-q4_k_m",
  });

  assert.deepEqual(pending.consumePendingLocalModel("dictation", "base"), {
    provider: "whisper",
    modelId: "base",
  });
  assert.equal(pending.hasPendingLocalModels(), true);
  assert.deepEqual(pending.readPendingLocalModels().assistant, {
    provider: "qwen",
    modelId: "qwen3.5-4b-q4_k_m",
  });
});

test("a completion cannot consume a different pending model", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "small" });

  assert.equal(pending.consumePendingLocalModel("dictation", "base"), null);
  assert.equal(pending.readPendingLocalModels().dictation.modelId, "small");
  pending.forgetPendingLocalModel("dictation", "small");
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("pending selections can be cleared when onboarding finishes on another mode", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "base" });
  pending.rememberPendingLocalModel("assistant", {
    provider: "qwen",
    modelId: "qwen3.5-4b-q4_k_m",
  });

  pending.clearPendingLocalModels();

  assert.deepEqual(pending.readPendingLocalModels(), {});
  assert.equal(pending.hasPendingLocalModels(), false);
});
