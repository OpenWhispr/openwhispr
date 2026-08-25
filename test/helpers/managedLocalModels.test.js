const test = require("node:test");
const assert = require("node:assert/strict");

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const identity = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 12,
};

const whisper = { provider: "whisper", model: "base" };
const nvidia = { provider: "nvidia", model: "parakeet-tdt-0.6b-v3" };
const qwen = { provider: "qwen", model: "qwen3.5-9b-q4_k_m" };

function planInput(overrides = {}) {
  return {
    identity,
    category: "dictation",
    approvedSelections: [whisper],
    availability: { "whisper:base": "installed" },
    nvidiaCapability: "supported",
    binding: null,
    ...overrides,
  };
}

test("managed local reconciliation plans literal approved artifact outcomes", async () => {
  const { planManagedLocalModelReconciliation } =
    await import("../../src/components/onboarding/managedLocalModels.ts");

  const rows = [
    {
      name: "current approved installed binding applies without a download",
      input: planInput({ binding: { ...identity, category: "dictation", ...whisper } }),
      want: {
        kind: "apply",
        selection: whisper,
        persistBinding: false,
        startDownload: false,
      },
    },
    {
      name: "current approved active download stays put without a duplicate",
      input: planInput({
        binding: { ...identity, category: "dictation", ...whisper },
        availability: { "whisper:base": "downloading" },
      }),
      want: {
        kind: "wait",
        selection: whisper,
        persistBinding: false,
        startDownload: false,
      },
    },
    {
      name: "a removed binding falls back to the first compatible approval",
      input: planInput({
        binding: { ...identity, category: "dictation", provider: "whisper", model: "tiny" },
        approvedSelections: [nvidia, whisper],
        availability: {
          "nvidia:parakeet-tdt-0.6b-v3": "missing",
          "whisper:base": "installed",
        },
        nvidiaCapability: "unsupported",
      }),
      want: {
        kind: "apply",
        selection: whisper,
        persistBinding: true,
        startDownload: false,
      },
    },
    {
      name: "a missing compatible artifact persists, applies, and downloads once",
      input: planInput({ availability: { "whisper:base": "missing" } }),
      want: {
        kind: "download",
        selection: whisper,
        persistBinding: true,
        startDownload: true,
      },
    },
    {
      name: "unknown NVIDIA capability pauses instead of selecting NVIDIA",
      input: planInput({
        approvedSelections: [nvidia, whisper],
        availability: {
          "nvidia:parakeet-tdt-0.6b-v3": "installed",
          "whisper:base": "installed",
        },
        nvidiaCapability: "unknown",
      }),
      want: {
        kind: "pause",
        code: "MANAGED_LOCAL_CAPABILITY_UNKNOWN",
        selection: null,
        persistBinding: false,
        startDownload: false,
      },
    },
    {
      name: "unsupported NVIDIA skips to the next approved selection",
      input: planInput({
        approvedSelections: [nvidia, whisper],
        availability: {
          "nvidia:parakeet-tdt-0.6b-v3": "installed",
          "whisper:base": "installed",
        },
        nvidiaCapability: "unsupported",
      }),
      want: {
        kind: "apply",
        selection: whisper,
        persistBinding: true,
        startDownload: false,
      },
    },
    {
      name: "a retained NVIDIA binding falls back when capability becomes unsupported",
      input: planInput({
        binding: { ...identity, category: "dictation", ...nvidia },
        approvedSelections: [nvidia, whisper],
        availability: {
          "nvidia:parakeet-tdt-0.6b-v3": "installed",
          "whisper:base": "installed",
        },
        nvidiaCapability: "unsupported",
      }),
      want: {
        kind: "apply",
        selection: whisper,
        persistBinding: true,
        startDownload: false,
      },
    },
    {
      name: "no compatible selection returns the category-localized error",
      input: planInput({ approvedSelections: [nvidia], nvidiaCapability: "unsupported" }),
      want: {
        kind: "error",
        code: "MANAGED_LOCAL_NO_COMPATIBLE_DICTATION_MODEL",
        messageKey: "onboarding.managedLocal.errors.noCompatibleDictationModel",
        selection: null,
        persistBinding: false,
        startDownload: false,
      },
    },
  ];

  for (const row of rows) {
    assert.deepEqual(planManagedLocalModelReconciliation(row.input), row.want, row.name);
  }
});

test("managed local bindings are exact identity, configuration, category, and selection fenced", async () => {
  global.localStorage = createStorage();
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const binding = { ...identity, category: "assistant", ...qwen };

  managed.rememberManagedLocalModelBinding(binding);
  assert.deepEqual(managed.readManagedLocalModelBinding(identity, "assistant"), binding);
  assert.equal(
    managed.readManagedLocalModelBinding({ ...identity, workspaceId: "workspace-b" }, "assistant"),
    null
  );
  assert.equal(
    managed.readManagedLocalModelBinding({ ...identity, accountId: "account-b" }, "assistant"),
    null
  );
  assert.equal(
    managed.readManagedLocalModelBinding({ ...identity, authGeneration: 8 }, "assistant"),
    null
  );
  assert.equal(
    managed.readManagedLocalModelBinding({ ...identity, configGeneration: 13 }, "assistant"),
    null
  );

  for (const stale of [
    { ...identity, category: "assistant", ...qwen, workspaceId: "workspace-b" },
    { ...identity, category: "assistant", ...qwen, accountId: "account-b" },
    { ...identity, category: "assistant", ...qwen, authGeneration: 8 },
    { ...identity, category: "assistant", ...qwen, configGeneration: 13 },
    { ...identity, category: "dictation", ...qwen },
    { ...identity, category: "assistant", provider: "qwen", model: "qwen3.5-4b-q4_k_m" },
  ]) {
    assert.equal(managed.consumeManagedLocalModelBinding(stale), null);
    assert.deepEqual(managed.readManagedLocalModelBinding(identity, "assistant"), binding);
  }

  assert.deepEqual(managed.consumeManagedLocalModelBinding(binding), binding);
  assert.equal(managed.readManagedLocalModelBinding(identity, "assistant"), null);
});
