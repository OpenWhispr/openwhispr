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

  assert.deepEqual(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "unmanaged",
      policy: null,
      appVersion: "1.11.1",
    }),
    {
      provider: "whisper",
      modelId: "base",
    }
  );
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

  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "unmanaged",
      policy: null,
      appVersion: "1.11.1",
    }),
    null
  );
  assert.equal(pending.readPendingLocalModels().dictation.modelId, "small");
  pending.forgetPendingLocalModel("dictation", "small");
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("pending selections can be cleared when onboarding finishes on another mode", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const selection = { provider: "whisper", modelId: "base" };

  pending.rememberPendingLocalModel("dictation", selection);
  pending.rememberPendingLocalModel("assistant", {
    provider: "qwen",
    modelId: "qwen3.5-4b-q4_k_m",
  });
  pending.clearPendingLocalModels();

  assert.deepEqual(pending.readPendingLocalModels(), {});
  assert.equal(pending.hasPendingLocalModels(), false);
  assert.equal(pending.isPendingLocalModel("dictation", selection), false);
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

test("pending activation checks current approvals without changing saved preferences", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const policy = {
    status: "managed",
    appVersion: "1.11.1",
    policy: {
      transcription: { allowedModes: ["local"], allowedLocalModels: [] },
      minAppVersion: null,
    },
  };
  localStorage.setItem("whisperModel", "small");
  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "base" });
  assert.equal(pending.consumePendingLocalModel("dictation", "base", policy), null);
  assert.equal(localStorage.getItem("whisperModel"), "small");
  assert.equal(pending.hasPendingLocalModels(), false);
  policy.policy.transcription.allowedLocalModels = ["base"];
  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "base" });
  assert.deepEqual(pending.consumePendingLocalModel("dictation", "base", policy), {
    provider: "whisper",
    modelId: "base",
  });
});

test("pending activation cannot cross an account generation", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  pending.rememberPendingLocalModel("dictation", {
    provider: "whisper",
    modelId: "base",
    accountId: "first",
    authGeneration: 4,
  });
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      status: "unmanaged",
      policy: null,
      appVersion: "1.11.1",
      accountId: "second",
      authGeneration: 5,
    }),
    null
  );
  assert.equal(pending.hasPendingLocalModels(), false);
});

test("Cohere pending inventory uses the shared native manager family", async () => {
  const { getPendingLocalModelAvailability } =
    await import("../../src/components/onboarding/pendingLocalModels.ts");
  assert.equal(
    getPendingLocalModelAvailability(
      "dictation",
      {
        provider: "cohere",
        modelId: "cohere-transcribe-03-2026",
      },
      { whisper: [], parakeet: [{ model: "cohere-transcribe-03-2026", downloaded: true }] }
    ),
    "downloaded"
  );
});
