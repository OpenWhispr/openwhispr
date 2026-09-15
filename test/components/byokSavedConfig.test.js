const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Restarting onboarding (#2128) drops the session draft, so these steps mount with no
// resumeState and have to reopen on what the user already saved.

const MIGRATED = { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" };
// Saving a key schedules its secret write (250 ms) and a .env persist (1 s); outlast
// both before the globals go.
const SECRET_SAVE_SETTLE_MS = 1100;
const PLACEHOLDER = {
  endpoint: "onboarding.rehaul.provider.endpointPlaceholder",
  selfHostedKey: "onboarding.rehaul.provider.optional",
  modelId: "onboarding.rehaul.provider.modelIdPlaceholder",
  hostedKey: "onboarding.rehaul.provider.apiKeyPlaceholder",
};
const HOSTED_GROQ = {
  useLocalWhisper: "false",
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "groq",
  cloudTranscriptionModel: "whisper-large-v3-turbo",
};
const CUSTOM_ENDPOINT = {
  useLocalWhisper: "false",
  transcriptionMode: "self-hosted",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
  cloudTranscriptionModel: "parasail-whisper",
};
const SETTINGS_SELF_HOSTED = {
  useLocalWhisper: "false",
  transcriptionMode: "self-hosted",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "openai",
  remoteTranscriptionUrl: "http://192.168.1.5:8178",
  remoteTranscriptionModel: "large-v3",
};

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
  } else if (node && typeof node === "object") {
    if (predicate(node)) found.push(node);
    findAll(node.props?.children, predicate, found);
  }
  return found;
}

async function mountByokStep(
  t,
  {
    stepId = "byok-dictation",
    selfHostedRequested = false,
    resumeState,
    settings = {},
    secrets = {},
  }
) {
  // Registered first so it runs first: after hooks run in order, and unmounting once
  // the globals are gone would run the step's cleanup without a window.
  let unmount = async () => {};
  t.after(() => unmount());
  installBrowserGlobals(t, {
    initialStorage: { ...MIGRATED, ...settings },
    window: { electronAPI: { getPlatform: () => "linux" }, dispatchEvent: () => true },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-byok-saved-config-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ProviderConnectionTest": `export default function ProviderConnectionTest() { return null; }`,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
      // Saving a key clears ReasoningService's key cache through a lazy import.
      "/services/ReasoningService": `export default { clearApiKeyCache() {} };`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(secrets);
  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  let tree;
  const drafts = [];
  function Harness() {
    // Run the real component and hooks, leaving native controls unmounted: the
    // returned element tree and the persisted draft are the test boundary.
    tree = ByokProviderStep({
      stepId,
      selfHostedRequested,
      resumeState,
      onSelfHostedChange() {},
      onConnectionChange() {},
      onProceed() {},
      onResumeStateChange: (draft) => drafts.push(draft),
    });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  let mounted = true;
  unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await React.act(async () => root.unmount());
  };

  const find = (predicate) => findAll(tree, predicate);
  const input = (placeholder) => find((node) => node.props?.placeholder === placeholder)[0];
  const act = (fn) => React.act(async () => fn());
  const proceedButton = () =>
    find((node) => node.props?.children === "onboarding.rehaul.provider.proceed")[0];
  return {
    vite,
    state: () => useSettingsStore.getState(),
    setStore: (patch) => act(() => useSettingsStore.setState(patch)),
    value: (placeholder) => input(placeholder)?.props.value,
    type: (placeholder, value) =>
      act(() => input(placeholder).props.onChange({ target: { value } })),
    // [provider, model] in the hosted half; absent while the card is self-hosted.
    selectValues: () =>
      find((node) => typeof node.props?.onValueChange === "function").map(
        (node) => node.props.value
      ),
    toggleSelfHosted: () =>
      act(() => find((node) => node.props?.role === "checkbox")[0].props.onClick()),
    passConnectionTest: () =>
      act(() =>
        find((node) => typeof node.props?.onSuccessChange === "function")[0].props.onSuccessChange(
          true
        )
      ),
    proceedDisabled: () => proceedButton().props.disabled,
    proceed: async () => {
      await act(() => proceedButton().props.onClick());
      await new Promise((resolve) => setTimeout(resolve, SECRET_SAVE_SETTLE_MS));
    },
    // Unmounting flushes the debounced draft write, as advancing past the step does.
    unmountForDrafts: async () => {
      await unmount();
      return drafts;
    },
  };
}

// The route helper is pure, so it loads straight through tsx like its own tests do.
const loadTranscriptionRoute = () => import("../../src/helpers/transcriptionRoute.ts");

async function routeAfterOnboardingSave(step) {
  // OnboardingFlow's byok-dictation continue runs this fan-out after the step saves.
  await React.act(async () =>
    step.state().setCloudTranscriptionForAllScopes({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
    })
  );
  const { resolveTranscriptionRoute } = await loadTranscriptionRoute();
  return resolveTranscriptionRoute({ settings: step.state() });
}

// As UploadAudioView hands it to resolveFileTranscriptionRoute: the upload scope plus
// the shared self-hosted fields.
async function uploadRoute(step) {
  const { selectResolvedUploadTranscription } = await step.vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const state = step.state();
  const { resolveTranscriptionRoute } = await loadTranscriptionRoute();
  return resolveTranscriptionRoute({
    settings: {
      ...selectResolvedUploadTranscription(state),
      remoteTranscriptionUrl: state.remoteTranscriptionUrl,
      remoteTranscriptionModel: state.remoteTranscriptionModel,
    },
  });
}

// A workspace policy arriving while the card is open, as policyStore applies it.
async function applyTranscriptionPolicy(step, transcription) {
  const { usePolicyStore } = await step.vite.ssrLoadModule("/stores/policyStore.ts");
  await React.act(async () =>
    usePolicyStore.setState({
      status: "managed",
      appVersion: "1.10.0",
      policy: {
        version: 1,
        transcription,
        llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
        features: { agentEnabled: false, webSearchEnabled: false },
        sharing: { externalLinkSharing: "disabled" },
        dataRetention: {
          audioRetentionMaxDays: null,
          localHistoryMode: "user_choice",
          cloudBackupAllowed: false,
        },
        minAppVersion: null,
      },
    })
  );
}

test("a first run opens blank", async (t) => {
  await t.test("hosted", async (t) => {
    const step = await mountByokStep(t, {});
    assert.deepEqual(step.selectValues(), [undefined, undefined]);
    assert.equal(step.value(PLACEHOLDER.hostedKey), "");
  });

  await t.test("self-hosted", async (t) => {
    const step = await mountByokStep(t, { selfHostedRequested: true });
    assert.equal(step.value(PLACEHOLDER.endpoint), "");
    assert.equal(step.value(PLACEHOLDER.modelId), "");
  });
});

test("a saved hosted provider reopens with its model and key, and the draft stays key-free", async (t) => {
  const step = await mountByokStep(t, {
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved-key" },
  });

  assert.deepEqual(step.selectValues(), ["groq", "whisper-large-v3-turbo"]);
  assert.equal(step.value(PLACEHOLDER.hostedKey), "gsk-saved-key");

  const drafts = await step.unmountForDrafts();
  assert.deepEqual(drafts.at(-1), {
    selectedProvider: "groq",
    selectedModel: "whisper-large-v3-turbo",
    baseUrl: "",
    customModel: "",
  });
  assert.doesNotMatch(JSON.stringify(drafts), /gsk-saved-key/);
});

test("a saved custom endpoint reopens in the self-hosted card with its key", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: CUSTOM_ENDPOINT,
    secrets: { customTranscriptionApiKey: "sk-custom-key" },
  });

  assert.equal(step.value(PLACEHOLDER.endpoint), "https://stt.example.com/v1");
  assert.equal(step.value(PLACEHOLDER.modelId), "parasail-whisper");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
});

test("the Settings self-hosted server reopens without a leftover custom key", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: SETTINGS_SELF_HOSTED,
    secrets: { customTranscriptionApiKey: "sk-stale-custom-key" },
  });

  assert.equal(step.value(PLACEHOLDER.endpoint), "http://192.168.1.5:8178");
  assert.equal(step.value(PLACEHOLDER.modelId), "large-v3");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
});

test("a remount from the saved draft keeps a Settings self-hosted server key-less", async (t) => {
  const mountSettingsServer = (t, resumeState) =>
    mountByokStep(t, {
      selfHostedRequested: true,
      settings: SETTINGS_SELF_HOSTED,
      secrets: { customTranscriptionApiKey: "sk-stale-custom-key" },
      resumeState,
    });
  let draft;

  await t.test("the first visit writes the draft", async (t) => {
    const step = await mountSettingsServer(t);
    draft = (await step.unmountForDrafts()).at(-1);
    assert.equal(draft.baseUrl, "http://192.168.1.5:8178");
  });

  // Back from the next step, or a reload, reopens the step from that draft.
  await t.test("the remount stays key-less and saves back to the same server", async (t) => {
    assert.ok(draft, "the first visit has to write the draft this remount reopens");
    const step = await mountSettingsServer(t, draft);
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
    // Every other place the key is chosen keeps it empty too: a mode round trip and a
    // key that arrives late.
    await step.toggleSelfHosted();
    await step.toggleSelfHosted();
    await step.setStore({ customTranscriptionApiKey: "sk-late-stale-key" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

    await step.passConnectionTest();
    await step.proceed();
    assert.equal(step.state().remoteTranscriptionUrl, "http://192.168.1.5:8178");
    assert.equal((await routeAfterOnboardingSave(step)).provider, "self-hosted");
  });
});

test("a saved assistant endpoint reopens with its key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    selfHostedRequested: true,
    settings: {
      chatAgentMode: "self-hosted",
      chatAgentRemoteUrl: "http://127.0.0.1:1234/v1",
      chatAgentModel: "llm-proxy-test",
    },
    secrets: { chatAgentCustomApiKey: "sk-agent-key" },
  });

  assert.equal(step.value(PLACEHOLDER.endpoint), "http://127.0.0.1:1234/v1");
  assert.equal(step.value(PLACEHOLDER.modelId), "llm-proxy-test");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-agent-key");
});

test("a saved hosted assistant provider reopens with its model and key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    settings: {
      chatAgentMode: "providers",
      chatAgentProvider: "anthropic",
      chatAgentModel: "claude-sonnet-5",
    },
    secrets: { anthropicApiKey: "sk-ant-saved-key" },
  });

  assert.deepEqual(step.selectValues(), ["anthropic", "claude-sonnet-5"]);
  assert.equal(step.value(PLACEHOLDER.hostedKey), "sk-ant-saved-key");
});

test("an in-progress draft wins over saved settings, and a blank one falls back to them", async (t) => {
  await t.test("draft", async (t) => {
    const step = await mountByokStep(t, {
      selfHostedRequested: true,
      settings: CUSTOM_ENDPOINT,
      resumeState: {
        selectedProvider: "",
        selectedModel: "",
        baseUrl: "https://draft.example.com/v1",
        customModel: "draft-model",
      },
    });
    assert.equal(step.value(PLACEHOLDER.endpoint), "https://draft.example.com/v1");
    assert.equal(step.value(PLACEHOLDER.modelId), "draft-model");
  });

  await t.test("blank draft", async (t) => {
    const step = await mountByokStep(t, {
      selfHostedRequested: true,
      settings: CUSTOM_ENDPOINT,
      resumeState: { selectedProvider: "", selectedModel: "", baseUrl: "", customModel: "" },
    });
    assert.equal(step.value(PLACEHOLDER.endpoint), "https://stt.example.com/v1");
  });
});

test("switching modes keeps both halves of the form and swaps only the key", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved-key", customTranscriptionApiKey: "sk-custom-key" },
  });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
  await step.type(PLACEHOLDER.endpoint, "https://typed.example.com/v1");

  await step.toggleSelfHosted();
  assert.deepEqual(step.selectValues(), ["groq", "whisper-large-v3-turbo"]);
  assert.equal(step.value(PLACEHOLDER.hostedKey), "gsk-saved-key");

  await step.toggleSelfHosted();
  assert.equal(step.value(PLACEHOLDER.endpoint), "https://typed.example.com/v1");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
});

test("a key that loads after mount fills an empty field but never replaces typed input", async (t) => {
  await t.test("empty field", async (t) => {
    const step = await mountByokStep(t, { selfHostedRequested: true });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
    await step.setStore({ customTranscriptionApiKey: "sk-late-key" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-late-key");
  });

  await t.test("typed field", async (t) => {
    const step = await mountByokStep(t, { selfHostedRequested: true });
    await step.type(PLACEHOLDER.selfHostedKey, "sk-typed-key");
    await step.setStore({ customTranscriptionApiKey: "sk-late-key" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-typed-key");
  });
});

test("policy removing self-hosting mid-step keeps the hosted half and loads its key", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved-key", customTranscriptionApiKey: "sk-custom-key" },
  });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");

  await applyTranscriptionPolicy(step, {
    allowedModes: ["providers"],
    allowedByokProviders: ["groq"],
  });
  assert.deepEqual(step.selectValues(), ["groq", "whisper-large-v3-turbo"]);
  assert.equal(step.value(PLACEHOLDER.hostedKey), "gsk-saved-key");
});

test("a seeded provider that policy removes after mount cannot be saved", async (t) => {
  for (const [name, settings, secrets] of [
    ["an API-key provider", HOSTED_GROQ, { groqApiKey: "gsk-saved-key" }],
    [
      "Corti",
      {
        ...HOSTED_GROQ,
        cloudTranscriptionProvider: "corti",
        cloudTranscriptionModel: "corti-transcribe",
      },
      { cortiClientId: "corti-client-id", cortiClientSecret: "corti-client-secret" },
    ],
  ]) {
    await t.test(name, async (t) => {
      const step = await mountByokStep(t, { settings, secrets });
      await step.passConnectionTest();
      assert.equal(step.proceedDisabled(), false);

      await applyTranscriptionPolicy(step, {
        allowedModes: ["providers"],
        allowedByokProviders: ["openai"],
      });
      assert.equal(step.proceedDisabled(), true);
    });
  }
});

test("a key-less endpoint saved over a hosted setup keeps its model and routes to it", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: {
      ...HOSTED_GROQ,
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    },
  });
  const customBaseUrl = step.state().cloudTranscriptionBaseUrl;
  await step.type(PLACEHOLDER.endpoint, "http://127.0.0.1:8791/v1");
  await step.type(PLACEHOLDER.modelId, "whisper-proxy-test");
  await step.passConnectionTest();
  await step.proceed();

  const state = step.state();
  assert.equal(state.cloudTranscriptionProvider, "custom");
  assert.equal(state.cloudTranscriptionBaseUrl, customBaseUrl, "the Custom slot is left alone");
  assert.equal(
    state.transcriptionModelByProvider["dictation:openai"],
    "gpt-4o-mini-transcribe",
    "the hosted model stays filed under its provider"
  );
  assert.equal(state.remoteTranscriptionUrl, "http://127.0.0.1:8791/v1");
  assert.equal(state.remoteTranscriptionModel, "whisper-proxy-test");
  assert.equal(state.remoteTranscriptionType, "openai-compatible");

  const route = await routeAfterOnboardingSave(step);
  assert.equal(route.provider, "self-hosted");
  assert.equal(route.endpoint, "http://127.0.0.1:8791/v1/audio/transcriptions");
  assert.equal(route.model, "whisper-proxy-test");
  assert.deepEqual(route.auth, { scheme: "none", keyRef: null });

  const upload = await uploadRoute(step);
  assert.equal(upload.provider, "self-hosted");
  assert.equal(upload.model, "whisper-proxy-test");
  assert.deepEqual(upload.auth, { scheme: "none", keyRef: null });
});

test("re-confirming the Settings self-hosted server keeps an unused custom endpoint and its key", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: {
      ...CUSTOM_ENDPOINT,
      remoteTranscriptionUrl: SETTINGS_SELF_HOSTED.remoteTranscriptionUrl,
      remoteTranscriptionModel: SETTINGS_SELF_HOSTED.remoteTranscriptionModel,
    },
    secrets: { customTranscriptionApiKey: "sk-unused-custom-key" },
  });
  assert.equal(step.value(PLACEHOLDER.endpoint), "http://192.168.1.5:8178");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
  await step.passConnectionTest();
  await step.proceed();

  const state = step.state();
  assert.equal(state.cloudTranscriptionBaseUrl, "https://stt.example.com/v1");
  assert.equal(state.customTranscriptionApiKey, "sk-unused-custom-key");
  assert.equal(state.cloudTranscriptionModel, "parasail-whisper");
  assert.equal(state.remoteTranscriptionUrl, "http://192.168.1.5:8178");

  const route = await routeAfterOnboardingSave(step);
  assert.equal(route.provider, "self-hosted");
  assert.equal(route.model, "large-v3");
  assert.deepEqual(route.auth, { scheme: "none", keyRef: null });
});

test("clearing a reopened custom key saves a key-less server and leaves the stored key unused", async (t) => {
  for (const cleared of ["", "   "]) {
    await t.test(JSON.stringify(cleared), async (t) => {
      const step = await mountByokStep(t, {
        selfHostedRequested: true,
        settings: CUSTOM_ENDPOINT,
        secrets: { customTranscriptionApiKey: "sk-saved-custom-key" },
      });
      assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-saved-custom-key");
      await step.type(PLACEHOLDER.selfHostedKey, cleared);
      await step.passConnectionTest();
      await step.proceed();

      const state = step.state();
      assert.equal(state.customTranscriptionApiKey, "sk-saved-custom-key");
      assert.equal(state.remoteTranscriptionUrl, "https://stt.example.com/v1");
      const route = await routeAfterOnboardingSave(step);
      assert.equal(route.provider, "self-hosted");
      assert.equal(route.model, "parasail-whisper");
      assert.deepEqual(route.auth, { scheme: "none", keyRef: null });
    });
  }
});

test("an endpoint saved with a key replaces a Settings self-hosted server and authenticates", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: SETTINGS_SELF_HOSTED,
  });
  await step.type(PLACEHOLDER.endpoint, "https://proxy.example.com/v1");
  await step.type(PLACEHOLDER.selfHostedKey, "sk-proxy-key");
  await step.type(PLACEHOLDER.modelId, "proxy-whisper");
  await step.passConnectionTest();
  await step.proceed();

  const state = step.state();
  assert.equal(state.remoteTranscriptionUrl, "");
  assert.equal(state.cloudTranscriptionBaseUrl, "https://proxy.example.com/v1");
  assert.equal(state.customTranscriptionApiKey, "sk-proxy-key");
  assert.equal(state.cloudTranscriptionModel, "proxy-whisper");

  const route = await routeAfterOnboardingSave(step);
  assert.equal(route.provider, "custom");
  assert.equal(route.endpoint, "https://proxy.example.com/v1/audio/transcriptions");
  assert.deepEqual(route.auth, { scheme: "bearer", keyRef: "custom" });
});
