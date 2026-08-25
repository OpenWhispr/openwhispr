const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("../helpers/harness/audioManager");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MANAGED_MODEL = "qwen3.5-4b-q4_k_m";
const MANAGED_PROVIDER = "qwen";

test("reasoning admission errors are classified without treating ordinary failures as admission", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-admission-error-classification-",
  });
  const { isReasoningAdmissionError } = await vite.ssrLoadModule(
    "/services/ai/enterpriseSettings.ts"
  );

  const rows = [
    ["authorization boundary", { code: "AUTHORIZATION_BOUNDARY_CHANGED" }, true],
    ["managed config unavailable", { code: "MANAGED_CONFIG_UNAVAILABLE" }, true],
    ["managed local unavailable", { code: "MANAGED_LOCAL_MODEL_UNAVAILABLE" }, true],
    ["managed workspace required", { code: "MANAGED_WORKSPACE_REQUIRED" }, true],
    ["managed config changed", { code: "MANAGED_CONFIG_CHANGED" }, true],
    ["provider policy conflict", { code: "PROVIDER_POLICY_CONFLICT" }, true],
    ["ordinary provider error", { code: "API_KEY_MISSING" }, false],
    ["lowercase lookalike", { code: "managed_config_unavailable" }, false],
    ["message-only lookalike", new Error("MANAGED_CONFIG_UNAVAILABLE"), false],
    ["missing value", undefined, false],
  ];

  for (const [name, value, expected] of rows) {
    await t.test(name, () => {
      assert.equal(isReasoningAdmissionError(value), expected);
    });
  }
});

test("audio translation captures the exact cloud claim and stops on admission failure", async (t) => {
  const guestSettings = {
    isSignedIn: false,
    enterpriseSetupMode: "auto",
    translationSourceLanguage: "auto",
    translationTargetLanguage: "es",
    uiLanguage: "en",
  };
  const signedInSettings = {
    ...guestSettings,
    isSignedIn: true,
  };
  const { AudioManager, createManager, setSettings, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-audio-reasoning-admission-terminal-",
    settingsKey: "__audioReasoningAdmissionTerminalSettings",
    settings: guestSettings,
  });
  let translations = 0;
  const cloudStarts = [];
  window.electronAPI.cloudReason = async (...args) => {
    cloudStarts.push(args);
    return { success: true, text: "cleaned" };
  };
  const manager = createManager({
    getCleanupLanguage: () => "en",
    getCustomPrompt: () => "",
    notifyTranslationFallback: () => {},
    processWithReasoningModel: async () => {
      translations += 1;
      return "translated";
    },
  });
  const runTranslation = (settings) =>
    AudioManager.prototype.runTranslationChain.call(manager, {
      text: "raw",
      settings,
      agentName: null,
      route: {
        cleanupReachable: true,
        model: "personal-model",
        config: { provider: "custom", inferenceScope: "dictationTranslation" },
      },
      cleanup: { mode: "cloudReason" },
    });

  await runTranslation(guestSettings);
  assert.equal(translations, 1);
  assert.equal(cloudStarts.length, 1);
  assert.deepEqual(cloudStarts[0][2], {
    accountId: null,
    workspaceId: null,
    authGeneration: null,
    configGeneration: null,
    managed: false,
    provider: "openwhispr",
    model: null,
  });

  setSettings(signedInSettings);
  cloudStarts.length = 0;
  translations = 0;
  await assert.rejects(runTranslation(signedInSettings), { code: "MANAGED_CONFIG_UNAVAILABLE" });
  assert.equal(cloudStarts.length, 0);
  assert.equal(translations, 0);
});

function managedLocalConfig(generation = 11) {
  return {
    workspaceId: "workspace-a",
    version: generation,
    generation,
    identity: {},
    providers: [],
    localModels: {
      selections: [{ provider: MANAGED_PROVIDER, model: MANAGED_MODEL }],
    },
  };
}

function managedCloudConfig(mode = "managed_required", allowManualSetup = false) {
  return {
    workspaceId: "workspace-a",
    version: 12,
    generation: 12,
    identity: {},
    providers: [
      {
        provider: "bedrock",
        mode,
        allowManualSetup,
        config: {
          scopeDefaults: {
            dictationCleanup: "cleanup-managed",
            noteFormatting: "formatting-managed",
            chatIntelligence: "chat-managed",
          },
        },
        version: 3,
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
    ],
  };
}

function allowedLocalPolicy() {
  return {
    version: 1,
    transcription: { allowedModes: [], allowedByokProviders: [] },
    llm: {
      allowedModes: ["local"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
    features: { agentEnabled: true, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  };
}

test("reasoning start resolution uses literal scope, setup mode, binding, and identity routes", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-local-reasoning-routes-",
  });
  const { captureReasoningStartClaim, resolveManagedReasoningStart } = await vite.ssrLoadModule(
    "/services/ai/enterpriseSettings.ts"
  );
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { rememberManagedLocalModelBinding } = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModels.ts"
  );
  const { rememberManagedPendingLocalModel } = await vite.ssrLoadModule(
    "/components/onboarding/pendingLocalModels.ts"
  );

  const identity = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    configGeneration: 11,
  };
  const managedInput = {
    provider: "openai",
    model: "personal-model",
    inferenceScope: "noteFormatting",
    setupMode: "auto",
    isSignedIn: true,
  };
  const installManagedLocal = (generation = 11) => {
    useEnterpriseIdentityStore.setState({
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      authGeneration: identity.authGeneration,
      status: "ready",
      verdict: "configured",
      failClosed: false,
      config: managedLocalConfig(generation),
      error: null,
    });
    usePolicyStore.setState({
      status: "managed",
      appVersion: "1.9.0",
      policy: allowedLocalPolicy(),
    });
  };

  await t.test("guest personal route", () => {
    storage.clear();
    useEnterpriseIdentityStore.getState().clear();
    usePolicyStore.setState({ status: "unmanaged", policy: null });
    assert.deepEqual(
      resolveManagedReasoningStart({
        provider: "custom",
        model: "personal-model",
        inferenceScope: "noteFormatting",
        setupMode: "manual",
        isSignedIn: false,
      }),
      {
        provider: "custom",
        model: "personal-model",
        inferenceScope: "noteFormatting",
        setupMode: "manual",
        managed: false,
        claim: {
          accountId: null,
          workspaceId: null,
          authGeneration: null,
          configGeneration: null,
          managed: false,
          provider: "custom",
          model: "personal-model",
        },
      }
    );
  });

  await t.test("authoritative current-session unmanaged route", () => {
    storage.clear();
    useEnterpriseIdentityStore.setState({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      status: "error",
      verdict: "unmanaged",
      failClosed: false,
      config: null,
      error: "ENTERPRISE_REQUIRED",
    });
    assert.deepEqual(resolveManagedReasoningStart(managedInput), {
      provider: "openai",
      model: "personal-model",
      inferenceScope: "noteFormatting",
      setupMode: "auto",
      managed: false,
      claim: {
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        configGeneration: null,
        managed: false,
        provider: "openai",
        model: "personal-model",
      },
    });
  });

  await t.test("exact managed local assistant binding replaces the personal route", () => {
    storage.clear();
    installManagedLocal();
    rememberManagedLocalModelBinding({
      ...identity,
      category: "assistant",
      provider: MANAGED_PROVIDER,
      model: MANAGED_MODEL,
    });
    assert.deepEqual(resolveManagedReasoningStart(managedInput), {
      provider: MANAGED_PROVIDER,
      model: MANAGED_MODEL,
      inferenceScope: "noteFormatting",
      setupMode: "auto",
      managed: true,
      claim: {
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        configGeneration: 11,
        managed: true,
        provider: MANAGED_PROVIDER,
        model: MANAGED_MODEL,
      },
    });
  });

  for (const row of [
    {
      name: "missing managed local binding",
      prepare() {},
      code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
    },
    {
      name: "stale managed local binding",
      prepare() {
        rememberManagedLocalModelBinding({
          ...identity,
          configGeneration: 10,
          category: "assistant",
          provider: MANAGED_PROVIDER,
          model: MANAGED_MODEL,
        });
      },
      code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
    },
    {
      name: "pending exact managed local binding",
      prepare() {
        rememberManagedLocalModelBinding({
          ...identity,
          category: "assistant",
          provider: MANAGED_PROVIDER,
          model: MANAGED_MODEL,
        });
        rememberManagedPendingLocalModel("assistant", {
          ...identity,
          provider: MANAGED_PROVIDER,
          modelId: MANAGED_MODEL,
          transferState: "downloading",
        });
      },
      code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
    },
  ]) {
    await t.test(row.name, () => {
      storage.clear();
      installManagedLocal();
      row.prepare();
      assert.throws(() => resolveManagedReasoningStart(managedInput), { code: row.code });
    });
  }

  await t.test("managed local policy conflict", () => {
    storage.clear();
    installManagedLocal();
    rememberManagedLocalModelBinding({
      ...identity,
      category: "assistant",
      provider: MANAGED_PROVIDER,
      model: MANAGED_MODEL,
    });
    usePolicyStore.setState({
      status: "managed",
      appVersion: "1.9.0",
      policy: { ...allowedLocalPolicy(), llm: { ...allowedLocalPolicy().llm, allowedModes: [] } },
    });
    assert.throws(() => resolveManagedReasoningStart(managedInput), {
      code: "PROVIDER_POLICY_CONFLICT",
    });
  });

  await t.test("managed cloud uses the requested scope in auto mode", () => {
    storage.clear();
    usePolicyStore.setState({ status: "unmanaged", policy: null });
    useEnterpriseIdentityStore.setState({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      status: "ready",
      verdict: "configured",
      failClosed: false,
      config: managedCloudConfig("managed_default", true),
      error: null,
    });
    assert.deepEqual(resolveManagedReasoningStart(managedInput), {
      provider: "bedrock",
      model: "formatting-managed",
      inferenceScope: "noteFormatting",
      setupMode: "auto",
      managed: true,
      claim: {
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        configGeneration: 12,
        managed: true,
        provider: "bedrock",
        model: "formatting-managed",
      },
    });
  });

  await t.test("manual setup preserves the personal route for optional managed cloud", () => {
    assert.deepEqual(resolveManagedReasoningStart({ ...managedInput, setupMode: "manual" }), {
      provider: "openai",
      model: "personal-model",
      inferenceScope: "noteFormatting",
      setupMode: "manual",
      managed: false,
      claim: {
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        configGeneration: 12,
        managed: false,
        provider: "openai",
        model: "personal-model",
      },
    });
  });

  for (const row of [
    {
      name: "signed-in account without a workspace",
      state: {
        accountId: "account-a",
        workspaceId: null,
        authGeneration: 7,
        status: "loading",
        verdict: "unknown",
        failClosed: true,
        config: null,
      },
      code: "MANAGED_WORKSPACE_REQUIRED",
    },
    {
      name: "unknown current configuration",
      state: {
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        status: "error",
        verdict: "unknown",
        failClosed: true,
        config: null,
      },
      code: "MANAGED_CONFIG_UNAVAILABLE",
    },
  ]) {
    await t.test(row.name, () => {
      storage.clear();
      useEnterpriseIdentityStore.setState(row.state);
      assert.throws(() => resolveManagedReasoningStart(managedInput), { code: row.code });
    });
  }

  await t.test(
    "fixed OpenWhispr cleanup starts use the same authoritative route decision",
    async (t) => {
      const fixedRoute = {
        provider: "openwhispr",
        model: null,
        inferenceScope: "dictationCleanup",
        setupMode: "auto",
      };

      await t.test("authoritative unmanaged", () => {
        storage.clear();
        useEnterpriseIdentityStore.setState({
          accountId: "account-a",
          workspaceId: "workspace-a",
          authGeneration: 7,
          status: "error",
          verdict: "unmanaged",
          failClosed: false,
          config: null,
          error: "ENTERPRISE_REQUIRED",
        });
        assert.deepEqual(captureReasoningStartClaim(fixedRoute, { isSignedIn: true }), {
          accountId: "account-a",
          workspaceId: "workspace-a",
          authGeneration: 7,
          configGeneration: null,
          managed: false,
          provider: "openwhispr",
          model: null,
        });
      });

      await t.test("managed local", () => {
        storage.clear();
        installManagedLocal();
        rememberManagedLocalModelBinding({
          ...identity,
          category: "assistant",
          provider: MANAGED_PROVIDER,
          model: MANAGED_MODEL,
        });
        assert.throws(() => captureReasoningStartClaim(fixedRoute, { isSignedIn: true }), {
          code: "AUTHORIZATION_BOUNDARY_CHANGED",
        });
      });

      await t.test("managed cloud", () => {
        storage.clear();
        usePolicyStore.setState({ status: "unmanaged", policy: null });
        useEnterpriseIdentityStore.setState({
          accountId: "account-a",
          workspaceId: "workspace-a",
          authGeneration: 7,
          status: "ready",
          verdict: "configured",
          failClosed: false,
          config: managedCloudConfig(),
          error: null,
        });
        assert.throws(() => captureReasoningStartClaim(fixedRoute, { isSignedIn: true }), {
          code: "AUTHORIZATION_BOUNDARY_CHANGED",
        });
      });

      await t.test("unknown", () => {
        storage.clear();
        useEnterpriseIdentityStore.setState({
          accountId: "account-a",
          workspaceId: "workspace-a",
          authGeneration: 7,
          status: "error",
          verdict: "unknown",
          failClosed: true,
          config: null,
          error: "offline",
        });
        assert.throws(() => captureReasoningStartClaim(fixedRoute, { isSignedIn: true }), {
          code: "MANAGED_CONFIG_UNAVAILABLE",
        });
      });
    }
  );
});

test("renderer-native reasoning requires one literal successful main preflight before fetch", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-required-preflight-",
  });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  useEnterpriseIdentityStore.getState().clear();
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({ isSignedIn: false, enterpriseSetupMode: "auto" });

  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") fetches += 1;
    return new Response(
      JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const call = () =>
    reasoningService.processText("hello", "personal-model", null, {
      provider: "custom",
      baseUrl: "http://127.0.0.1:11434/v1",
      customApiKey: "secret",
      inferenceScope: "noteFormatting",
    });

  const rows = [
    ["missing bridge", undefined, "AUTHORIZATION_BOUNDARY_CHANGED"],
    ["undefined response", async () => undefined, "AUTHORIZATION_BOUNDARY_CHANGED"],
    ["null response", async () => null, "AUTHORIZATION_BOUNDARY_CHANGED"],
    ["malformed response", async () => ({ ok: true }), "AUTHORIZATION_BOUNDARY_CHANGED"],
    [
      "explicit rejection",
      async () => ({ success: false, code: "MANAGED_CONFIG_UNAVAILABLE", error: "blocked" }),
      "MANAGED_CONFIG_UNAVAILABLE",
    ],
    [
      "rejected transport",
      async () => Promise.reject(new Error("ipc failed")),
      "AUTHORIZATION_BOUNDARY_CHANGED",
    ],
  ];

  for (const [name, preflight, code] of rows) {
    await t.test(name, async () => {
      fetches = 0;
      if (preflight) window.electronAPI.authorizeReasoningStart = preflight;
      else delete window.electronAPI.authorizeReasoningStart;
      await assert.rejects(call(), { code });
      assert.equal(fetches, 0);
    });
  }

  await t.test("literal success dispatches the exact claimed route once", async () => {
    fetches = 0;
    const admissions = [];
    window.electronAPI.authorizeReasoningStart = async (...args) => {
      admissions.push(args);
      return { success: true };
    };
    assert.equal(await call(), "ok");
    assert.equal(fetches, 1);
    assert.deepEqual(admissions, [
      [
        {
          provider: "custom",
          model: "personal-model",
          inferenceScope: "noteFormatting",
          setupMode: "auto",
        },
        {
          accountId: null,
          workspaceId: null,
          authGeneration: null,
          configGeneration: null,
          managed: false,
          provider: "custom",
          model: "personal-model",
        },
      ],
    ]);
  });
});

test("managed local reasoning dispatches the exact binding and never falls back after admission", async (t) => {
  const { window, storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-local-reasoning-dispatch-",
  });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { rememberManagedLocalModelBinding } = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModels.ts"
  );

  storage.clear();
  const identity = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    configGeneration: 11,
  };
  useEnterpriseIdentityStore.setState({
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    authGeneration: identity.authGeneration,
    status: "ready",
    verdict: "configured",
    failClosed: false,
    config: managedLocalConfig(),
    error: null,
  });
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.9.0",
    policy: allowedLocalPolicy(),
  });
  useSettingsStore.setState({ isSignedIn: true, enterpriseSetupMode: "auto" });
  rememberManagedLocalModelBinding({
    ...identity,
    category: "assistant",
    provider: MANAGED_PROVIDER,
    model: MANAGED_MODEL,
  });

  const calls = [];
  window.electronAPI.authorizeReasoningStart = async () => {
    throw new Error("renderer preflight must not duplicate a main-crossing admission");
  };
  window.electronAPI.processLocalReasoning = async (...args) => {
    calls.push(args);
    return { success: true, text: "managed output" };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("managed local reasoning must not fall back to a network provider");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = () =>
    reasoningService.processText("hello", "personal-model", null, {
      provider: "openai",
      inferenceScope: "noteFormatting",
    });
  assert.equal(await request(), "managed output");
  assert.equal(calls.length, 1);
  const [text, model, agentName, config, claim] = calls[0];
  assert.match(text, /^<transcript>\nhello\n<\/transcript>/);
  assert.equal(model, MANAGED_MODEL);
  assert.equal(agentName, null);
  assert.equal(config.provider, MANAGED_PROVIDER);
  assert.equal(config.inferenceScope, "noteFormatting");
  assert.equal(config.setupMode, "auto");
  assert.deepEqual(claim, {
    ...identity,
    managed: true,
    provider: MANAGED_PROVIDER,
    model: MANAGED_MODEL,
  });

  window.electronAPI.processLocalReasoning = async (...args) => {
    calls.push(args);
    return {
      success: false,
      error: "Managed local model is unavailable.",
      code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
    };
  };
  await assert.rejects(request(), { code: "MANAGED_LOCAL_MODEL_UNAVAILABLE" });
  assert.equal(calls.length, 2);

  let serverWarmups = 0;
  window.electronAPI.authorizeReasoningStart = async () => ({
    success: false,
    error: "Managed local reasoning model is unavailable.",
    code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
  });
  window.electronAPI.llamaServerStart = async () => {
    serverWarmups += 1;
    return { success: true, port: 32123 };
  };
  await assert.rejects(
    async () => {
      for await (const _chunk of reasoningService.processTextStreaming(
        [{ role: "user", content: "hello" }],
        "personal-model",
        "openai",
        {
          systemPrompt: "system",
          inferenceScope: "chatIntelligence",
        }
      )) {
        // A rejected start never yields a chunk.
      }
    },
    { code: "MANAGED_LOCAL_MODEL_UNAVAILABLE" }
  );
  assert.equal(serverWarmups, 0);
});
