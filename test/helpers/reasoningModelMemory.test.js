const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("per-provider reasoning model memory", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "custom",
      cleanupModel: "parasail-llm-v1",
      cleanupCloudBaseUrl: "https://llm.parasail.example.com/v1",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-model-memory-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  await t.test("switch-and-return restores the custom model (Parasail scenario)", () => {
    state().switchReasoningProvider("dictationCleanup", "openai", "gpt-5.2");
    assert.equal(state().cleanupProvider, "openai");
    assert.equal(state().cleanupModel, "gpt-5.2");
    assert.equal(
      state().cleanupCloudBaseUrl,
      "https://llm.parasail.example.com/v1",
      "the custom URL slot must never be touched by a provider switch"
    );

    state().switchReasoningProvider("dictationCleanup", "custom", "");
    assert.equal(state().cleanupProvider, "custom");
    assert.equal(state().cleanupModel, "parasail-llm-v1");
  });

  await t.test("reselecting the current provider keeps the current model", () => {
    state().setCleanupModel("parasail-tuned");
    state().switchReasoningProvider("dictationCleanup", "custom", "");
    assert.equal(state().cleanupModel, "parasail-tuned");
  });

  await t.test("a remembered model the provider no longer ships falls back", () => {
    state().switchReasoningProvider("dictationCleanup", "groq", "llama-3.3-70b-versatile");
    state().setCleanupModel("retired-groq-model");
    state().switchReasoningProvider("dictationCleanup", "custom", "");
    state().switchReasoningProvider("dictationCleanup", "groq", "llama-3.3-70b-versatile");
    assert.equal(
      state().cleanupModel,
      "llama-3.3-70b-versatile",
      "an unknown remembered model must degrade to the provider default"
    );
  });

  await t.test("scopes have independent memory and writes", () => {
    state().switchReasoningProvider("dictationCleanup", "custom", "");
    const cleanupModel = state().cleanupModel;

    state().switchReasoningProvider("chatIntelligence", "openai", "gpt-5.2");
    assert.equal(state().chatAgentProvider, "openai");
    assert.equal(state().chatAgentModel, "gpt-5.2");
    assert.equal(state().cleanupProvider, "custom", "base scope untouched");
    assert.equal(state().cleanupModel, cleanupModel, "base scope untouched");
  });

  await t.test("memory persists to localStorage as JSON", () => {
    const persisted = JSON.parse(localStorage.getItem("reasoningModelByProvider"));
    assert.equal(typeof persisted, "object");
    assert.ok(Object.keys(persisted).some((key) => key.startsWith("dictationCleanup:")));
  });
});

// The reasoning picker commits only on an explicit model click via the plain
// scope setters (provider, then model). Pin that the pair lands atomically
// and that per-provider memory never overrides an explicit click.
test("explicit model click commits the (provider, model) pair atomically", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupModel: "gpt-5-mini",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-click-commit-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = () => useSettingsStore.getState();

  // Seed per-provider memory: anthropic remembers claude-opus-4-6.
  state().switchReasoningProvider("dictationCleanup", "anthropic", "claude-sonnet-4-6");
  state().setCleanupModel("claude-opus-4-6");
  state().switchReasoningProvider("dictationCleanup", "openai", "gpt-5.2");
  assert.equal(state().cleanupModel, "gpt-5-mini", "switch-and-return restores openai's model");

  // Explicit click on claude-haiku-4-5 under the browsed anthropic tab:
  // the clicked pair commits, not the remembered claude-opus-4-6.
  state().setCleanupProvider("anthropic");
  state().setCleanupModel("claude-haiku-4-5");
  assert.equal(state().cleanupProvider, "anthropic");
  assert.equal(
    state().cleanupModel,
    "claude-haiku-4-5",
    "per-provider memory must not resurrect over an explicit click"
  );

  // A later provider-only write must not drag the model along.
  state().setCleanupProvider("openai");
  assert.equal(state().cleanupProvider, "openai");
  assert.equal(
    state().cleanupModel,
    "claude-haiku-4-5",
    "the plain provider setter writes the provider alone"
  );
});

test("corrupt persisted reasoning model memory hydrates as empty, not a crash", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      reasoningModelByProvider: "{not json",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-model-memory-corrupt-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.deepEqual(useSettingsStore.getState().reasoningModelByProvider, {});
});

test("retired cloud model selections are repointed to the provider default", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupProvider: "groq",
      cleanupModel: "meta-llama/llama-4-scout-17b-16e-instruct",
      chatAgentProvider: "openai",
      chatAgentModel: "gpt-5.2",
      noteFormattingProvider: "custom",
      noteFormattingModel: "my-endpoint-model",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-retired-cloud-model-test-",
  });
  const { useSettingsStore, reconcileRetiredCloudModelSelections } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );

  reconcileRetiredCloudModelSelections();

  const state = useSettingsStore.getState();
  assert.notEqual(
    state.cleanupModel,
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "a registry-retired model must be repointed"
  );
  assert.ok(state.cleanupModel, "repointed to a concrete replacement, not cleared");
  assert.equal(state.chatAgentModel, "gpt-5.2", "shipping models stay untouched");
  assert.equal(state.noteFormattingModel, "my-endpoint-model", "custom ids are free-form");
});

// Anthropic ships models faster than the registry is updated, so the picker
// accepts a typed id. Only ids the user typed survive the startup repoint; an
// unknown id the user never typed (a model we removed) still resets.
test("typed Anthropic model ids survive reconciliation and provider switches", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "anthropic",
      cleanupModel: "claude-opus-9",
      chatAgentMode: "providers",
      chatAgentProvider: "anthropic",
      chatAgentModel: "claude-retired-model",
      customReasoningModelIds: JSON.stringify({ anthropic: ["claude-opus-9"] }),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-typed-anthropic-model-test-",
  });
  const { useSettingsStore, reconcileRetiredCloudModelSelections } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const state = () => useSettingsStore.getState();

  await t.test("reconciliation keeps a typed id and repoints an untyped unknown id", () => {
    reconcileRetiredCloudModelSelections();
    assert.equal(state().cleanupModel, "claude-opus-9");
    assert.notEqual(state().chatAgentModel, "claude-retired-model");
    assert.ok(state().chatAgentModel, "repointed to a concrete replacement, not cleared");
  });

  await t.test("switch-and-return restores the typed id", () => {
    state().switchReasoningProvider("dictationCleanup", "openai", "gpt-5.2");
    state().switchReasoningProvider("dictationCleanup", "anthropic", "claude-fable-5-1");
    assert.equal(state().cleanupModel, "claude-opus-9");
  });

  await t.test("adding a typed id trims, dedupes and persists it newest first", () => {
    state().addCustomReasoningModelId("anthropic", "  claude-sonnet-9  ");
    state().addCustomReasoningModelId("anthropic", "claude-opus-9");
    assert.deepEqual(state().customReasoningModelIds.anthropic, [
      "claude-opus-9",
      "claude-sonnet-9",
    ]);
    assert.deepEqual(JSON.parse(localStorage.getItem("customReasoningModelIds")), {
      anthropic: ["claude-opus-9", "claude-sonnet-9"],
    });
  });

  await t.test("registry ids, blank ids and other providers are not recorded", () => {
    state().addCustomReasoningModelId("anthropic", "claude-fable-5-1");
    state().addCustomReasoningModelId("anthropic", "   ");
    state().addCustomReasoningModelId("openai", "gpt-9");
    assert.deepEqual(state().customReasoningModelIds, {
      anthropic: ["claude-opus-9", "claude-sonnet-9"],
    });
  });

  await t.test("the remembered list is capped", () => {
    for (let index = 0; index < 30; index += 1) {
      state().addCustomReasoningModelId("anthropic", `claude-test-${index}`);
    }
    assert.equal(state().customReasoningModelIds.anthropic.length, 20);
    assert.equal(state().customReasoningModelIds.anthropic[0], "claude-test-29");
  });
});

test("a corrupt typed model id list reads as empty", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { customReasoningModelIds: '{"anthropic":"not-a-list"' },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-typed-anthropic-model-corrupt-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.deepEqual(useSettingsStore.getState().customReasoningModelIds, {});
});
