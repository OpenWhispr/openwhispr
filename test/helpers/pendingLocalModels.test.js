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

test("managed pending selections are fenced to account, workspace, and configuration", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const identity = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 4,
    configVersion: 2,
  };
  pending.rememberPendingLocalModel(
    "dictation",
    { provider: "whisper", modelId: "base" },
    identity
  );

  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      ...identity,
      workspaceId: "workspace-b",
    }),
    null
  );
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      ...identity,
      accountId: "account-b",
    }),
    null
  );
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      ...identity,
      authGeneration: 5,
    }),
    null
  );
  assert.equal(
    pending.consumePendingLocalModel("dictation", "base", {
      ...identity,
      configVersion: 3,
    }),
    null
  );
  assert.deepEqual(pending.consumePendingLocalModel("dictation", "base", identity), {
    provider: "whisper",
    modelId: "base",
  });
});

test("the download tray delegates managed completion activation to the coordinator", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const identity = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 4,
    configVersion: 2,
  };
  pending.rememberPendingLocalModel(
    "dictation",
    { provider: "whisper", modelId: "base" },
    identity
  );

  assert.equal(pending.getPendingLocalModelActivationOwner("dictation", "base"), "coordinator");

  assert.deepEqual(pending.consumePendingLocalModelCompletion("dictation", "base"), {
    selection: { provider: "whisper", modelId: "base" },
    activationOwner: "coordinator",
  });
  assert.deepEqual(pending.readPendingLocalModels(), {});

  pending.rememberPendingLocalModel("dictation", { provider: "whisper", modelId: "small" });
  assert.equal(pending.getPendingLocalModelActivationOwner("dictation", "small"), "tray");
  assert.deepEqual(pending.consumePendingLocalModelCompletion("dictation", "small"), {
    selection: { provider: "whisper", modelId: "small" },
    activationOwner: "tray",
  });
});

test("managed terminal errors remain owned by the coordinator", async () => {
  global.localStorage = createStorage();
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  pending.rememberPendingLocalModel(
    "assistant",
    { provider: "qwen", modelId: "qwen-local" },
    {
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 4,
      configVersion: 2,
    }
  );

  assert.equal(
    pending.getPendingLocalModelActivationOwner("assistant", "qwen-local"),
    "coordinator"
  );
  assert.equal(pending.getPendingLocalModelActivationOwner("assistant", "different"), null);
  assert.deepEqual(pending.readPendingLocalModels().assistant, {
    provider: "qwen",
    modelId: "qwen-local",
    managedIdentity: {
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 4,
      configVersion: 2,
    },
  });
});
