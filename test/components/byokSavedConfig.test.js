const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { managedPolicy } = require("../helpers/harness/policyFixtures");
const { mountByokStep } = require("../lib/byokStepHarness");

// Restarting onboarding (#2128) drops the session draft, so these steps mount with no
// resumeState and have to reopen on what the user already saved.

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
      ...selectResolvedUploadTranscription(state, state),
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
      policy: managedPolicy({ transcription }),
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

test("a first setup ignores a leftover custom key and saves a key-less server", async (t) => {
  const step = await mountByokStep(t, {
    // Local dictation: nothing to reopen on, but an abandoned Custom setup left its key
    // behind. Offering it would send it to the endpoint the user is about to type.
    settings: { useLocalWhisper: "true", transcriptionMode: "local" },
    secrets: { customTranscriptionApiKey: "sk-abandoned-key" },
    selfHostedRequested: true,
  });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

  await step.type(PLACEHOLDER.endpoint, "https://typed.example.com/v1");
  await step.type(PLACEHOLDER.modelId, "whisper-proxy-test");
  await step.passConnectionTest();
  await step.proceed();

  const state = step.state();
  assert.equal(state.remoteTranscriptionUrl, "https://typed.example.com/v1");
  assert.equal(state.customTranscriptionApiKey, "sk-abandoned-key", "the stored key is unused");

  const route = await routeAfterOnboardingSave(step);
  assert.equal(route.provider, "self-hosted");
  assert.equal(route.endpoint, "https://typed.example.com/v1/audio/transcriptions");
  assert.deepEqual(route.auth, { scheme: "none", keyRef: null });
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

test("a self-hosted assistant setup ignores a leftover agent key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    // Saved as a hosted provider, so the abandoned self-hosted key is not this
    // endpoint's: offering it would send it to the server the user is about to type.
    settings: {
      chatAgentMode: "providers",
      chatAgentProvider: "anthropic",
      chatAgentModel: "claude-sonnet-5",
    },
    secrets: { chatAgentCustomApiKey: "sk-abandoned-agent-key" },
  });
  await step.toggleSelfHosted();
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

  // Secrets hydrate over IPC, so a key arriving after mount must stay out too.
  await step.setStore({ chatAgentCustomApiKey: "sk-late-agent-key" });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
});

test("the prefilled key follows the endpoint it was saved under", async (t) => {
  const mountSavedEndpoint = (t) =>
    mountByokStep(t, {
      selfHostedRequested: true,
      settings: CUSTOM_ENDPOINT,
      secrets: { customTranscriptionApiKey: "sk-custom-key" },
    });

  await t.test("retyping the endpoint takes the prefilled key back out", async (t) => {
    const step = await mountSavedEndpoint(t);
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");

    await step.type(PLACEHOLDER.endpoint, "https://rented.example.com/v1");
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

    // The same server written another way is still that server.
    await step.type(PLACEHOLDER.endpoint, "stt.example.com/v1/");
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
  });

  await t.test("a key the user typed survives the endpoint change", async (t) => {
    const step = await mountSavedEndpoint(t);
    await step.type(PLACEHOLDER.selfHostedKey, "sk-typed-key");
    await step.type(PLACEHOLDER.endpoint, "https://rented.example.com/v1");
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-typed-key");
  });

  await t.test("re-typing the saved key for the saved endpoint keeps it", async (t) => {
    const step = await mountSavedEndpoint(t);
    await step.type(PLACEHOLDER.selfHostedKey, "");
    await step.type(PLACEHOLDER.selfHostedKey, "sk-custom-key");
    await step.setStore({ cortiTenant: "unrelated-change" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
  });
});

test("a draft that names another server reopens key-less and saves it key-less", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: CUSTOM_ENDPOINT,
    secrets: { customTranscriptionApiKey: "sk-custom-key" },
    // Edited earlier this session and never committed, so the stored key still belongs to
    // the saved server, not to the one the card now shows.
    resumeState: {
      selectedProvider: "",
      selectedModel: "",
      baseUrl: "https://draft.example.com/v1",
      customModel: "draft-model",
    },
  });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

  await step.passConnectionTest();
  await step.proceed();

  assert.equal(step.state().customTranscriptionApiKey, "sk-custom-key", "the stored key is unused");
  const route = await routeAfterOnboardingSave(step);
  assert.equal(route.endpoint, "https://draft.example.com/v1/audio/transcriptions");
  assert.deepEqual(route.auth, { scheme: "none", keyRef: null });
});

test("an assistant endpoint the user retyped never takes the saved agent key", async (t) => {
  const step = await mountByokStep(t, {
    stepId: "byok-assistant",
    selfHostedRequested: true,
    settings: {
      chatAgentMode: "self-hosted",
      chatAgentRemoteUrl: "http://127.0.0.1:1234/v1",
      chatAgentModel: "llm-proxy-test",
    },
  });

  await step.type(PLACEHOLDER.endpoint, "https://rented.example.com/v1");
  // Secrets hydrate over IPC, so the saved key can land after the endpoint was retyped.
  await step.setStore({ chatAgentCustomApiKey: "sk-agent-key" });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
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

test("with no draft, the saved setup picks the card, whichever tile was clicked", async (t) => {
  // Restarting onboarding wipes the session, so the tile clicked on setup-choice is the
  // only mode on record; a reverse-proxy user who clicks "Bring your own key" must still
  // land on their endpoint (#2128).
  await t.test("a saved custom endpoint opens self-hosted from the BYOK tile", async (t) => {
    const step = await mountByokStep(t, {
      selfHostedRequested: false,
      settings: CUSTOM_ENDPOINT,
      secrets: { customTranscriptionApiKey: "sk-custom-key" },
    });
    assert.equal(step.value(PLACEHOLDER.endpoint), "https://stt.example.com/v1");
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
    assert.deepEqual(step.selfHostedChanges, [true], "the session follows the card");
  });

  await t.test("a saved hosted provider opens hosted from the Self-hosted tile", async (t) => {
    const step = await mountByokStep(t, { selfHostedRequested: true, settings: HOSTED_GROQ });
    assert.deepEqual(step.selectValues(), ["groq", "whisper-large-v3-turbo"]);
    assert.deepEqual(step.selfHostedChanges, [false]);
  });

  await t.test("a self-hosted assistant opens self-hosted behind a hosted dictation", async (t) => {
    const step = await mountByokStep(t, {
      stepId: "byok-assistant",
      selfHostedRequested: false,
      settings: {
        ...HOSTED_GROQ,
        chatAgentMode: "self-hosted",
        chatAgentProvider: "custom",
        chatAgentRemoteUrl: "http://10.0.0.7:8080/v1",
        chatAgentModel: "qwen3-8b",
      },
    });
    assert.equal(step.value(PLACEHOLDER.endpoint), "http://10.0.0.7:8080/v1");
    assert.equal(step.value(PLACEHOLDER.modelId), "qwen3-8b");
    assert.deepEqual(step.selfHostedChanges, [true]);
  });

  await t.test("a draft keeps the card the session recorded", async (t) => {
    const step = await mountByokStep(t, {
      selfHostedRequested: false,
      settings: CUSTOM_ENDPOINT,
      resumeState: {
        selectedProvider: "groq",
        selectedModel: "whisper-large-v3-turbo",
        baseUrl: "https://stt.example.com/v1",
        customModel: "parasail-whisper",
      },
    });
    assert.deepEqual(step.selectValues(), ["groq", "whisper-large-v3-turbo"]);
    assert.deepEqual(step.selfHostedChanges, []);
  });
});

test("the saved key still matches an endpoint typed with a differently cased host", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: CUSTOM_ENDPOINT,
    secrets: { customTranscriptionApiKey: "sk-custom-key" },
    resumeState: {
      selectedProvider: "",
      selectedModel: "",
      baseUrl: "HTTPS://STT.Example.com/v1/",
      customModel: "parasail-whisper",
    },
  });
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-custom-key");
});

test("a hosted save keeps the Settings self-hosted server for the Upload tab", async (t) => {
  const step = await mountByokStep(t, {
    selfHostedRequested: true,
    settings: SETTINGS_SELF_HOSTED,
    secrets: { groqApiKey: "gsk-saved-key" },
  });
  await step.toggleSelfHosted();
  await step.chooseProvider("groq");
  await step.passConnectionTest();
  await step.proceed();

  assert.equal(step.state().cloudTranscriptionProvider, "groq");
  // remoteTranscriptionUrl is shared with Upload's Self-hosted panel; the mode the
  // fan-out derives is what keeps the server out of dictation's route and out of
  // the card a later restart reopens on.
  assert.equal(step.state().remoteTranscriptionUrl, "http://192.168.1.5:8178");

  const route = await routeAfterOnboardingSave(step);
  assert.equal(route.provider, "groq");
  const { resolveSavedByokConfig } =
    await import("../../src/components/onboarding/savedByokConfig.ts");
  assert.equal(resolveSavedByokConfig("byok-dictation", step.state()).draft.baseUrl, "");
});

test("switching modes keeps both halves of the form and swaps only the key", async (t) => {
  const step = await mountByokStep(t, {
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved-key", customTranscriptionApiKey: "sk-custom-key" },
  });
  assert.equal(step.value(PLACEHOLDER.hostedKey), "gsk-saved-key");

  await step.toggleSelfHosted();
  // What is saved is a hosted provider, so the stored custom key is not this endpoint's.
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
  await step.type(PLACEHOLDER.endpoint, "https://typed.example.com/v1");

  await step.toggleSelfHosted();
  assert.deepEqual(step.selectValues(), ["groq", "whisper-large-v3-turbo"]);
  assert.equal(step.value(PLACEHOLDER.hostedKey), "gsk-saved-key");

  await step.toggleSelfHosted();
  assert.equal(step.value(PLACEHOLDER.endpoint), "https://typed.example.com/v1");
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
});

test("a key that loads after mount fills an empty field but never replaces typed input", async (t) => {
  const mountSavedEndpoint = (t) =>
    mountByokStep(t, { selfHostedRequested: true, settings: CUSTOM_ENDPOINT });

  await t.test("empty field", async (t) => {
    const step = await mountSavedEndpoint(t);
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");
    await step.setStore({ customTranscriptionApiKey: "sk-late-key" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-late-key");
  });

  await t.test("typed field", async (t) => {
    const step = await mountSavedEndpoint(t);
    await step.type(PLACEHOLDER.selfHostedKey, "sk-typed-key");
    await step.setStore({ customTranscriptionApiKey: "sk-late-key" });
    assert.equal(step.value(PLACEHOLDER.selfHostedKey), "sk-typed-key");
  });
});

test("policy removing self-hosting mid-step keeps the hosted half and loads its key", async (t) => {
  const step = await mountByokStep(t, {
    settings: HOSTED_GROQ,
    secrets: { groqApiKey: "gsk-saved-key", customTranscriptionApiKey: "sk-custom-key" },
  });
  await step.toggleSelfHosted();
  assert.equal(step.value(PLACEHOLDER.selfHostedKey), "");

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
    settings: {
      ...HOSTED_GROQ,
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    },
  });
  await step.toggleSelfHosted();
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
