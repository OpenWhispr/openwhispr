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

// Only an older build writes these, so the tests seed the stored entry directly.
function seedPending(selections) {
  localStorage.setItem("pendingLocalModelSelectionsV1", JSON.stringify(selections));
}

test("pending local model selections remain isolated by scope", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  seedPending({
    dictation: { provider: "whisper", modelId: "base" },
    assistant: { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
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

  seedPending({ dictation: { provider: "whisper", modelId: "small" } });

  assert.equal(pending.consumePendingLocalModel("dictation", "base"), null);
  assert.equal(pending.readPendingLocalModels().dictation.modelId, "small");
  pending.forgetPendingLocalModel("dictation", "small");
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("pending selections can be cleared when onboarding finishes on another mode", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  seedPending({
    dictation: { provider: "whisper", modelId: "base" },
    assistant: { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
  });
  pending.clearPendingLocalModels();

  assert.deepEqual(pending.readPendingLocalModels(), {});
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("finishing onboarding drops the pending pick and the tray's flag", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");

  seedPending({ assistant: { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" } });
  localStorage.setItem("localSetupPending", "true");
  pending.discardPendingLocalSetup();

  assert.equal(pending.hasPendingLocalModels(), false);
  assert.equal(localStorage.getItem("localSetupPending"), null);
});

test("pending local model availability distinguishes active, installed, and orphaned models", async () => {
  global.localStorage = createStorage();
  const { getPendingLocalModelAvailability } =
    await import("../../src/components/onboarding/pendingLocalModels.ts");
  const dictation = { provider: "whisper", modelId: "base" };
  const assistant = { provider: "qwen", modelId: "qwen-local" };

  assert.equal(
    getPendingLocalModelAvailability("dictation", dictation, {
      whisper: [{ model: "base", downloaded: false, isDownloading: true }],
    }),
    "downloading"
  );
  assert.equal(
    getPendingLocalModelAvailability("assistant", assistant, {
      llm: [{ id: "qwen-local", isDownloaded: true, isDownloading: false }],
    }),
    "downloaded"
  );
  assert.equal(
    getPendingLocalModelAvailability("dictation", dictation, {
      whisper: [{ model: "base", downloaded: false, isDownloading: false }],
    }),
    "missing"
  );
  assert.equal(getPendingLocalModelAvailability("dictation", dictation, {}), "unknown");
});
