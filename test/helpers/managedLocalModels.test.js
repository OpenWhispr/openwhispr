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

test("managed model bindings are isolated by account and workspace", async () => {
  global.localStorage = createStorage();
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  managed.writeManagedLocalModelBinding("account-a", "workspace-a", {
    configVersion: 2,
    transcription: { provider: "whisper", modelId: "base" },
    reasoning: null,
    error: null,
  });
  assert.equal(managed.readManagedLocalModelBinding("account-a", "workspace-b"), null);
  assert.equal(
    managed.readManagedLocalModelBinding("account-a", "workspace-a").transcription.modelId,
    "base"
  );
});

test("every known identity failure code resolves to localized copy", async () => {
  const { translateManagedLocalModelError } =
    await import("../../src/components/onboarding/managedLocalModels.ts");
  const broadcastCodes = [
    "MANAGED_CONFIG_UNAVAILABLE",
    "AUTH_EXPIRED",
    "AUTH_CONTEXT_CHANGED",
    "AUTH_CONTEXT_UNVALIDATED",
    "ENTERPRISE_REQUIRED",
    "MANAGED_WORKSPACE_REQUIRED",
    "SSO_REQUIRED",
    "DIRECTORY_ASSIGNMENT_REQUIRED",
    "PROVIDER_NOT_ALLOWED",
    "PROVIDER_NOT_CONFIGURED",
    "POLICY_UNRESOLVABLE",
    "MANAGED_CONFIG_INVALID",
  ];

  for (const code of broadcastCodes) {
    assert.notEqual(
      translateManagedLocalModelError(code, (key) => `translated:${key}`),
      code,
      `${code} must never reach the onboarding UI as a literal code`
    );
  }
  assert.equal(
    translateManagedLocalModelError("The enterprise gateway returned status 502.", (key) => key),
    "The enterprise gateway returned status 502."
  );
});

test("managed model replacement keeps an approved choice and otherwise uses first priority", async () => {
  const { resolveManagedLocalModelSelection } =
    await import("../../src/components/onboarding/managedLocalModels.ts");
  const approved = [
    { provider: "whisper", modelId: "small" },
    { provider: "whisper", modelId: "base" },
  ];
  assert.deepEqual(
    resolveManagedLocalModelSelection(approved, { provider: "whisper", modelId: "base" }),
    { provider: "whisper", modelId: "base" }
  );
  assert.deepEqual(
    resolveManagedLocalModelSelection(approved, { provider: "whisper", modelId: "large" }),
    approved[0]
  );
  assert.equal(resolveManagedLocalModelSelection([], approved[0]), null);
});

test("download errors remain scoped to the binding configuration that started them", async () => {
  global.localStorage = createStorage();
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  managed.writeManagedLocalModelBinding("account-a", "workspace-a", {
    configVersion: 3,
    transcription: { provider: "whisper", modelId: "base" },
    reasoning: null,
    error: null,
  });

  managed.setManagedLocalModelBindingError("account-a", "workspace-a", 2, "stale failure");
  assert.equal(managed.readManagedLocalModelBinding("account-a", "workspace-a").error, null);

  managed.setManagedLocalModelBindingError("account-a", "workspace-a", 3, "download failed");
  assert.equal(
    managed.readManagedLocalModelBinding("account-a", "workspace-a").error,
    "download failed"
  );
});

test("notes readiness requires every managed category and no unresolved download error", async () => {
  const { areManagedLocalModelBindingsReady } =
    await import("../../src/components/onboarding/managedLocalModels.ts");
  const config = {
    transcription: [{ provider: "whisper", modelId: "base" }],
    reasoning: [{ provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" }],
    version: 4,
    updatedAt: new Date(0).toISOString(),
    updatedByUserId: null,
  };
  const binding = {
    configVersion: 4,
    transcription: config.transcription[0],
    reasoning: config.reasoning[0],
    error: null,
  };

  assert.equal(areManagedLocalModelBindingsReady(config, binding), true);
  assert.equal(areManagedLocalModelBindingsReady(config, { ...binding, error: "failed" }), false);
  assert.equal(areManagedLocalModelBindingsReady(config, { ...binding, reasoning: null }), false);
  assert.equal(
    areManagedLocalModelBindingsReady(
      { ...config, reasoning: [] },
      { ...binding, reasoning: null }
    ),
    true
  );
});

test("managed local mode options disable every route away from local", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  assert.equal(typeof managed.constrainManagedLocalModeOptions, "function");
  assert.equal(typeof managed.canSelectManagedLocalMode, "function");

  const options = [
    { id: "openwhispr", disabled: false },
    { id: "providers", disabled: false },
    { id: "local", disabled: false },
    { id: "self-hosted", disabled: true },
  ];
  const constrained = managed.constrainManagedLocalModeOptions(options, true);

  assert.deepEqual(
    constrained.map(({ id, disabled }) => ({ id, disabled })),
    [
      { id: "openwhispr", disabled: true },
      { id: "providers", disabled: true },
      { id: "local", disabled: false },
      { id: "self-hosted", disabled: true },
    ]
  );
  assert.equal(managed.canSelectManagedLocalMode(true, "local"), true);
  assert.equal(managed.canSelectManagedLocalMode(true, "providers"), false);
  assert.equal(managed.canSelectManagedLocalMode(false, "providers"), true);
});

test("managed local direct mode changes never run their mutation", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  let applied = 0;

  assert.equal(
    managed.applyManagedLocalModeChange(true, "providers", () => {
      applied += 1;
    }),
    false
  );
  assert.equal(
    managed.applyManagedLocalModeChange(true, "openwhispr", () => {
      applied += 1;
    }),
    false
  );
  assert.equal(applied, 0);

  assert.equal(
    managed.applyManagedLocalModeChange(false, "providers", () => {
      applied += 1;
    }),
    true
  );
  assert.equal(applied, 1);
});

test("a managed selection is applied only while local policy still allows it", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  let applied = 0;
  let blocked = 0;

  assert.equal(
    managed.applyManagedLocalModelSelectionWhenAllowed(
      false,
      () => {
        applied += 1;
      },
      () => {
        blocked += 1;
      }
    ),
    false
  );
  assert.equal(applied, 0);
  assert.equal(blocked, 1);

  assert.equal(
    managed.applyManagedLocalModelSelectionWhenAllowed(
      true,
      () => {
        applied += 1;
      },
      () => {
        blocked += 1;
      }
    ),
    true
  );
  assert.equal(applied, 1);
  assert.equal(blocked, 1);
});

test("focused setup delegates selection while initial setup owns its transfer", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const actions = [];
  const callbacks = {
    persist: () => actions.push("persist"),
    apply: () => actions.push("apply"),
    download: () => actions.push("download"),
  };

  assert.equal(managed.routeManagedLocalModelSetupChoice(false, false, callbacks), "delegated");
  assert.deepEqual(actions, ["persist"]);

  actions.length = 0;
  assert.equal(managed.routeManagedLocalModelSetupChoice(true, false, callbacks), "downloaded");
  assert.deepEqual(actions, ["persist", "download"]);

  actions.length = 0;
  assert.equal(managed.routeManagedLocalModelSetupChoice(true, true, callbacks), "applied");
  assert.deepEqual(actions, ["persist", "apply"]);
});

test("focused setup readiness never carries across workspace identity", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const readyForA = { identityKey: "account-a:workspace-a:1", ready: true };
  assert.equal(
    managed.resolveManagedLocalSetupReadiness(readyForA, "account-a:workspace-a:1"),
    true
  );
  assert.equal(
    managed.resolveManagedLocalSetupReadiness(readyForA, "account-a:workspace-b:1"),
    false
  );

  assert.equal(
    managed.updateManagedLocalSetupReadiness(readyForA, "account-a:workspace-a:1", true),
    readyForA,
    "an unchanged child report must not schedule another parent render"
  );
  assert.deepEqual(
    managed.updateManagedLocalSetupReadiness(readyForA, "account-a:workspace-a:1", false),
    { identityKey: "account-a:workspace-a:1", ready: false }
  );
  assert.deepEqual(
    managed.updateManagedLocalSetupReadiness(readyForA, "account-a:workspace-b:1", true),
    { identityKey: "account-a:workspace-b:1", ready: true }
  );
});

test("setup choices are disabled and ignored while current policy blocks local", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");

  assert.equal(managed.canChooseManagedLocalModel(true, false), false);
  assert.equal(managed.canChooseManagedLocalModel(false, true), false);
  assert.equal(managed.canChooseManagedLocalModel(true, true), true);
});

test("onboarding download handoff has one settings owner and no duplicate transfer", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const selection = { provider: "whisper", modelId: "base" };
  let settingsMutations = 0;
  let replacementDownloads = 0;

  assert.equal(managed.canInitialSetupApplyManagedLocalModel(true, true), false);
  const activeAtHandoff = managed.isManagedLocalModelDownloadActive(false, true);
  if (managed.shouldRecoverManagedLocalModel(selection, false, activeAtHandoff)) {
    replacementDownloads += 1;
  }
  if (!managed.shouldRecoverManagedLocalModel(selection, true, false)) {
    managed.applyManagedLocalModelSelectionWhenAllowed(
      true,
      () => {
        settingsMutations += 1;
      },
      () => {}
    );
  }

  assert.equal(settingsMutations, 1);
  assert.equal(replacementDownloads, 0);
});

test("late managed download errors remain fenced to their originating identity", async () => {
  global.localStorage = createStorage();
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const attempt = {
    identity: {
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 3,
      configVersion: 7,
    },
    category: "transcription",
    selection: { provider: "whisper", modelId: "base" },
  };
  managed.writeManagedLocalModelBinding("account-a", "workspace-a", {
    configVersion: 7,
    transcription: attempt.selection,
    reasoning: null,
    error: null,
  });
  managed.writeManagedLocalModelBinding("account-b", "workspace-b", {
    configVersion: 7,
    transcription: { provider: "whisper", modelId: "small" },
    reasoning: null,
    error: null,
  });
  pending.rememberPendingLocalModel("dictation", attempt.selection, attempt.identity);

  assert.equal(managed.recordManagedLocalModelDownloadError(attempt, "late A failure"), true);
  assert.equal(
    managed.readManagedLocalModelBinding("account-a", "workspace-a").categoryErrors.transcription,
    "late A failure"
  );
  assert.equal(
    managed.readManagedLocalModelBinding("account-b", "workspace-b").categoryErrors,
    undefined
  );

  pending.rememberPendingLocalModel("dictation", attempt.selection, {
    ...attempt.identity,
    accountId: "account-b",
    workspaceId: "workspace-b",
  });
  assert.equal(managed.recordManagedLocalModelDownloadError(attempt, "stale failure"), false);
  assert.equal(
    managed.readManagedLocalModelBinding("account-b", "workspace-b").categoryErrors,
    undefined
  );
});

test("a stale model completion cannot overwrite a newer selection in the same binding", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const selectedB = { provider: "whisper", modelId: "small" };
  const binding = {
    configVersion: 7,
    transcription: selectedB,
    reasoning: null,
    error: null,
  };

  assert.equal(
    managed.isManagedLocalModelBindingSelectionCurrent(binding, 7, "transcription", {
      provider: "whisper",
      modelId: "base",
    }),
    false
  );
  assert.equal(
    managed.isManagedLocalModelBindingSelectionCurrent(binding, 7, "transcription", selectedB),
    true
  );
});

test("managed cancellation exposes retry and permits exactly one restart", async () => {
  global.localStorage = createStorage();
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const pending = await import("../../src/components/onboarding/pendingLocalModels.ts");
  const identity = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 3,
    configVersion: 7,
  };
  const selection = { provider: "whisper", modelId: "base" };
  const activeReplacements = new Set();
  const replacementKey = "account-a:workspace-a:7:transcription:whisper:base";
  managed.writeManagedLocalModelBinding(identity.accountId, identity.workspaceId, {
    configVersion: 7,
    transcription: selection,
    reasoning: null,
    error: null,
  });
  pending.rememberPendingLocalModel("dictation", selection, identity);
  assert.equal(managed.beginManagedLocalModelReplacement(activeReplacements, replacementKey), true);

  assert.equal(
    managed.recordPendingManagedLocalModelError(
      "dictation",
      selection.modelId,
      "The company model download was cancelled. Restart it to continue."
    ),
    true
  );
  pending.forgetPendingLocalModel("dictation", selection.modelId);
  assert.equal(
    managed.getManagedLocalModelBindingError(
      managed.readManagedLocalModelBinding(identity.accountId, identity.workspaceId)
    ),
    "The company model download was cancelled. Restart it to continue."
  );

  activeReplacements.clear();
  assert.equal(managed.beginManagedLocalModelReplacement(activeReplacements, replacementKey), true);
  assert.equal(
    managed.beginManagedLocalModelReplacement(activeReplacements, replacementKey),
    false
  );
});

test("a failed category stays paused across owner handoff until one explicit retry", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const failed = {
    configVersion: 7,
    transcription: { provider: "whisper", modelId: "base" },
    reasoning: null,
    error: null,
    categoryErrors: { transcription: "network failed" },
    retryGeneration: 2,
  };
  const replacementKey = "account-a:workspace-a:7:transcription:whisper:base";
  const newOwnerReplacements = new Set();

  assert.equal(
    managed.canAutomaticallyStartManagedLocalModelReplacement(
      true,
      failed.categoryErrors.transcription
    ),
    false
  );
  const retried = managed.createManagedLocalModelRetryBinding(failed);
  assert.deepEqual(retried.categoryErrors, {});
  assert.equal(retried.error, null);
  assert.equal(retried.retryGeneration, 3);
  assert.equal(
    managed.canAutomaticallyStartManagedLocalModelReplacement(
      true,
      retried.categoryErrors.transcription
    ),
    true
  );
  assert.equal(
    managed.beginManagedLocalModelReplacement(newOwnerReplacements, replacementKey),
    true
  );
  assert.equal(
    managed.beginManagedLocalModelReplacement(newOwnerReplacements, replacementKey),
    false
  );
});

test("pending cloud migration waits for enterprise resolution and respects managed local", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");

  assert.equal(managed.canApplyPendingCloudMigration("idle", false, false, false, false), false);
  assert.equal(managed.canApplyPendingCloudMigration("idle", false, false, true, true), false);
  assert.equal(managed.canApplyPendingCloudMigration("loading", false, false, true, true), false);
  assert.equal(managed.canApplyPendingCloudMigration("error", true, false, true, true), false);
  assert.equal(managed.canApplyPendingCloudMigration("error", false, false, true, true), true);
  assert.equal(managed.canApplyPendingCloudMigration("ready", false, true, true, true), false);
  assert.equal(managed.canApplyPendingCloudMigration("ready", false, false, true, true), true);
  assert.equal(managed.canApplyPendingCloudMigration("idle", false, false, true, false), true);
});

test("a successful sibling download preserves the failed category", async () => {
  global.localStorage = createStorage();
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  assert.equal(typeof managed.setManagedLocalModelCategoryError, "function");

  managed.writeManagedLocalModelBinding("account-a", "workspace-a", {
    configVersion: 7,
    transcription: { provider: "whisper", modelId: "base" },
    reasoning: { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    error: null,
  });
  managed.setManagedLocalModelCategoryError(
    "account-a",
    "workspace-a",
    7,
    "transcription",
    "dictation download failed"
  );
  managed.setManagedLocalModelCategoryError("account-a", "workspace-a", 7, "reasoning", null);

  const binding = managed.readManagedLocalModelBinding("account-a", "workspace-a");
  assert.equal(binding.categoryErrors?.transcription, "dictation download failed");
  assert.equal(binding.categoryErrors?.reasoning, undefined);
  assert.equal(managed.getManagedLocalModelBindingError(binding), "dictation download failed");
});

test("a missing managed artifact needs recovery even at the current config version", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  assert.equal(typeof managed.shouldRecoverManagedLocalModel, "function");

  const selection = { provider: "whisper", modelId: "base" };
  assert.equal(managed.shouldRecoverManagedLocalModel(selection, false, false), true);
  assert.equal(managed.shouldRecoverManagedLocalModel(selection, true, false), false);
  assert.equal(managed.shouldRecoverManagedLocalModel(selection, false, true), false);
});

test("automatic owners wait for a known inventory before recovering a missing artifact", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const selection = { provider: "whisper", modelId: "base" };

  assert.equal(
    managed.shouldRecoverManagedLocalModelFromInventory(selection, false, false, false),
    false,
    "a rejected inventory request must not be interpreted as an empty inventory"
  );
  assert.equal(managed.getManagedLocalModelInventoryRetryDelay(1), 250);
  assert.equal(managed.getManagedLocalModelInventoryRetryDelay(2), 1000);
  assert.equal(managed.getManagedLocalModelInventoryRetryDelay(3), 3000);
  assert.equal(managed.getManagedLocalModelInventoryRetryDelay(4), null);
  assert.equal(
    managed.shouldRecoverManagedLocalModelFromInventory(selection, true, false, false),
    true,
    "a subsequent successful empty inventory should start one recovery"
  );
});

test("a failed terminal refresh invalidates inventory freshness without inventing absence", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const knownMissing = new Set();
  const failedRefresh = managed.resolveManagedLocalModelInventorySnapshot(knownMissing, undefined);
  assert.equal(failedRefresh.known, false);
  assert.equal(failedRefresh.value, knownMissing);
  assert.equal(
    managed.shouldRecoverManagedLocalModelFromInventory(
      { provider: "whisper", modelId: "base" },
      failedRefresh.known,
      failedRefresh.value.has("base"),
      false
    ),
    false
  );

  const installedRefresh = managed.resolveManagedLocalModelInventorySnapshot(
    failedRefresh.value,
    new Set(["base"])
  );
  assert.equal(installedRefresh.known, true);
  assert.equal(installedRefresh.value.has("base"), true);

  let completedAttempts = installedRefresh.known ? 0 : 3;
  const laterFailure = managed.resolveManagedLocalModelInventorySnapshot(
    installedRefresh.value,
    undefined
  );
  if (!laterFailure.known) completedAttempts += 1;
  assert.equal(
    managed.getManagedLocalModelInventoryRetryDelay(completedAttempts),
    250,
    "successful refreshes reset the retry budget for a later failure"
  );
});

test("a completed replacement key can begin again after its artifact disappears", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const activeReplacements = new Set();
  const key = "account-a:workspace-a:7:transcription:whisper:base";

  assert.equal(managed.beginManagedLocalModelReplacement(activeReplacements, key), true);
  assert.equal(managed.beginManagedLocalModelReplacement(activeReplacements, key), false);
  managed.finishManagedLocalModelReplacement(activeReplacements, key);
  assert.equal(managed.beginManagedLocalModelReplacement(activeReplacements, key), true);
});

test("a valid resolved binding clears only its obsolete global error", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  const transcription = { provider: "whisper", modelId: "base" };
  const reasoning = { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" };
  const resolved = managed.createResolvedManagedLocalModelBinding(
    {
      configVersion: 7,
      transcription,
      reasoning,
      error: "No compatible company model is available.",
      categoryErrors: { transcription: "The download failed." },
      retryGeneration: 2,
    },
    7,
    transcription,
    reasoning
  );

  assert.deepEqual(resolved, {
    configVersion: 7,
    transcription,
    reasoning,
    error: null,
    categoryErrors: { transcription: "The download failed." },
    retryGeneration: 2,
  });
});

test("fail-closed local lock distinguishes unknown enforcement from known cloud-only config", async () => {
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  assert.equal(typeof managed.resolveManagedLocalModelLockSnapshot, "function");

  const identity = { accountId: "account-a", workspaceId: "workspace-a" };
  assert.deepEqual(
    managed.resolveManagedLocalModelLockSnapshot(
      { ...identity, localModels: null, localModelsKnown: false, failClosed: true },
      "transcription"
    ),
    { managed: true, selection: null }
  );
  assert.deepEqual(
    managed.resolveManagedLocalModelLockSnapshot(
      { ...identity, localModels: null, localModelsKnown: true, failClosed: true },
      "transcription"
    ),
    { managed: false, selection: null }
  );
});
