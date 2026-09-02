const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationRouting.js");

test("voice agent hotkey routes to the agent without a wake word", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("voice agent hotkey never triggers cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  // Even with the dictation agent unreachable, a voice assistant recording
  // takes the agent route: standalone commands run on the chat scope in the
  // panel, so only selection edits (decided later) need this scope.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("voice agent hotkey ignores the wake word state", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: true,
    }),
    "agent"
  );
});

test("normal dictation with wake word routes to the agent", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "agent"
  );
});

test("normal dictation without wake word routes to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("wake word with unreachable agent falls back to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: true,
      voiceAgentRequested: false,
    }),
    "cleanup"
  );
});

test("skips reasoning when nothing is reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
    }),
    "skip"
  );
});

test("agent is reachable in cloud mode without an explicit model", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentMode: "openwhispr",
      dictationAgentProvider: undefined,
      dictationAgentModel: "",
      isCloudAgent: true,
      isSelfHostedAgent: false,
    }),
    true
  );
});

test("agent is reachable in self-hosted mode without an explicit model", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentMode: "self-hosted",
      dictationAgentProvider: undefined,
      dictationAgentModel: "",
      isCloudAgent: false,
      isSelfHostedAgent: true,
    }),
    true
  );
});

test("agent is unreachable with an empty model on a model-required provider", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentMode: "providers",
      dictationAgentProvider: "openai",
      dictationAgentModel: "   ",
      isCloudAgent: false,
      isSelfHostedAgent: false,
    }),
    false
  );
});

test("agent is reachable with an explicit model (BYOK/local/enterprise)", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentMode: "providers",
      dictationAgentProvider: "openai",
      dictationAgentModel: "gpt-5.5",
      isCloudAgent: false,
      isSelfHostedAgent: false,
    }),
    true
  );
});

test("disabling the dictation agent overrides cloud reachability", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: false,
      dictationAgentMode: "openwhispr",
      dictationAgentProvider: undefined,
      dictationAgentModel: "",
      isCloudAgent: true,
      isSelfHostedAgent: true,
    }),
    false
  );
});

test("translation hotkey routes to translation when reachable", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: true,
    }),
    "translation"
  );
});

test("translation hotkey ignores the wake word state", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: true,
    }),
    "translation"
  );
});

test("unreachable translation degrades to cleanup, not to the agent", async () => {
  const { resolveDictationRouteKind } = await load();

  // Deliberately different from the voice agent's hard skip: a dictation meant
  // for translation is still a useful dictation, so keep the cleanup.
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: false,
    }),
    "cleanup"
  );
});

test("unreachable translation with unreachable cleanup skips reasoning", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: true,
      translationReachable: false,
    }),
    "skip"
  );
});

test("normal dictation never takes the translation route", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: false,
      translationRequested: false,
      translationReachable: true,
    }),
    "cleanup"
  );
});

test("translation is unreachable when disabled", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: false,
      translationTargetLanguage: "it",
      translationMode: "openwhispr",
      translationProvider: undefined,
      translationModel: "gpt-5-mini",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    false
  );
});

test("translation is unreachable without a target language", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "   ",
      translationMode: "openwhispr",
      translationProvider: undefined,
      translationModel: "gpt-5-mini",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    false
  );
});

test("translation is reachable in cloud mode without an explicit model", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "openwhispr",
      translationProvider: undefined,
      translationModel: "",
      isCloudTranslation: true,
      isSelfHostedTranslation: false,
    }),
    true
  );
});

test("translation is reachable in self-hosted mode without an explicit model", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "self-hosted",
      translationProvider: undefined,
      translationModel: "",
      isCloudTranslation: false,
      isSelfHostedTranslation: true,
    }),
    true
  );
});

test("translation needs a model on model-required providers", async () => {
  const { resolveDictationTranslationReachability } = await load();

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "providers",
      translationProvider: "openai",
      translationModel: "  ",
      isCloudTranslation: false,
      isSelfHostedTranslation: false,
    }),
    false
  );

  assert.equal(
    resolveDictationTranslationReachability({
      useDictationTranslation: true,
      translationTargetLanguage: "it",
      translationMode: "providers",
      translationProvider: "openai",
      translationModel: "qwen3:8b",
      isCloudTranslation: false,
      isSelfHostedTranslation: false,
    }),
    true
  );
});

test("available managed mode resolves the OpenWhispr provider", async () => {
  const { resolveDictationAgentProvider } = await load();

  assert.equal(
    resolveDictationAgentProvider({
      isCloudAgent: true,
      dictationAgentMode: "openwhispr",
      dictationAgentProvider: "anthropic",
    }),
    "openwhispr"
  );
});

test("local mode resolves the local provider, not stale provider state", async () => {
  const { resolveDictationAgentProvider } = await load();

  assert.equal(
    resolveDictationAgentProvider({
      isCloudAgent: false,
      dictationAgentMode: "local",
      dictationAgentProvider: "qwen",
    }),
    "local"
  );
});

test("BYOK providers mode passes the stored provider through", async () => {
  const { resolveDictationAgentProvider } = await load();

  assert.equal(
    resolveDictationAgentProvider({
      isCloudAgent: false,
      dictationAgentMode: "providers",
      dictationAgentProvider: "anthropic",
    }),
    "anthropic"
  );
});

test("blank stored provider resolves to undefined outside local mode", async () => {
  const { resolveDictationAgentProvider } = await load();

  assert.equal(
    resolveDictationAgentProvider({
      isCloudAgent: false,
      dictationAgentMode: "providers",
      dictationAgentProvider: "  ",
    }),
    undefined
  );
});

test("managed mode fails closed when its cloud session is unavailable", async () => {
  const { resolveDictationAgentProvider } = await load();

  assert.equal(
    resolveDictationAgentProvider({
      isCloudAgent: false,
      dictationAgentMode: "openwhispr",
      dictationAgentProvider: "openai",
    }),
    undefined
  );
});

test("local mode wins over an inconsistent cloud flag", async () => {
  const { resolveDictationAgentProvider } = await load();

  assert.equal(
    resolveDictationAgentProvider({
      isCloudAgent: true,
      dictationAgentMode: "local",
      dictationAgentProvider: "openai",
    }),
    "local"
  );
});

test("self-hosted mode clears stale providers", async () => {
  const { resolveDictationAgentProvider } = await load();

  assert.equal(
    resolveDictationAgentProvider({
      isCloudAgent: false,
      dictationAgentMode: "self-hosted",
      dictationAgentProvider: "openai",
    }),
    undefined
  );
});

test("self-hosted mode is unreachable without its endpoint", async () => {
  const { resolveDictationAgentReachability } = await load();

  assert.equal(
    resolveDictationAgentReachability({
      useDictationAgent: true,
      dictationAgentMode: "self-hosted",
      dictationAgentProvider: undefined,
      dictationAgentModel: "gpt-5-mini",
      isCloudAgent: false,
      isSelfHostedAgent: false,
    }),
    false
  );
});

test("provider and enterprise modes require an explicit provider", async () => {
  const { resolveDictationAgentReachability } = await load();

  for (const dictationAgentMode of ["providers", "enterprise"]) {
    assert.equal(
      resolveDictationAgentReachability({
        useDictationAgent: true,
        dictationAgentMode,
        dictationAgentProvider: undefined,
        dictationAgentModel: "gpt-5-mini",
        isCloudAgent: false,
        isSelfHostedAgent: false,
      }),
      false
    );
  }
});

test("display provider follows the active mode instead of stale state", async () => {
  const { resolveDictationAgentDisplayProvider } = await load();

  assert.equal(
    resolveDictationAgentDisplayProvider({
      dictationAgentMode: "local",
      dictationAgentProvider: "openai",
    }),
    "local"
  );
  assert.equal(
    resolveDictationAgentDisplayProvider({
      dictationAgentMode: "self-hosted",
      dictationAgentProvider: "openai",
    }),
    "self-hosted"
  );
});

test("translation provider: available managed mode routes to openwhispr", async () => {
  const { resolveTranslationProviderId } = await load();

  assert.equal(
    resolveTranslationProviderId({
      isCloudTranslation: true,
      translationMode: "openwhispr",
      translationProvider: "openai",
    }),
    "openwhispr"
  );
});

test("translation provider: mode wins over stale provider and cloud state", async () => {
  const { resolveTranslationProviderId } = await load();

  for (const [translationMode, translationProvider, expected] of [
    ["providers", " groq ", "groq"],
    ["local", "qwen", "local"],
    ["local", "openai", "local"],
    ["self-hosted", "openai", undefined],
  ]) {
    assert.equal(
      resolveTranslationProviderId({
        isCloudTranslation: translationMode === "local",
        translationMode,
        translationProvider,
      }),
      expected
    );
  }
});

test("translation provider: empty local provider routes to llama.cpp", async () => {
  const { resolveTranslationProviderId } = await load();

  assert.equal(
    resolveTranslationProviderId({
      isCloudTranslation: false,
      translationMode: "local",
      translationProvider: "",
    }),
    "local"
  );
});

test("translation provider: incomplete managed and provider modes fail closed", async () => {
  const { resolveTranslationProviderId } = await load();

  for (const translationMode of ["openwhispr", "providers", "enterprise"]) {
    assert.equal(
      resolveTranslationProviderId({
        isCloudTranslation: false,
        translationMode,
        translationProvider: "  ",
      }),
      undefined
    );
  }
});

// Screen-context image routing on the agent route.
const imageTarget = {
  hasScreenContext: true,
  visionOverrideActive: false,
  visionProviderImageWired: false,
  baseProviderImageWired: true,
  isCloudAgent: false,
  baseModelSupportsVision: false,
};

test("no captured screenshot never attaches", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      hasScreenContext: false,
      visionOverrideActive: true,
      visionProviderImageWired: true,
      isCloudAgent: true,
      baseModelSupportsVision: true,
    }),
    { attach: false, useVisionOverride: false }
  );
});

test("cloud agent attaches to the base model (server picks the vision model)", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(resolveAgentImageTarget({ ...imageTarget, isCloudAgent: true }), {
    attach: true,
    useVisionOverride: false,
  });
});

test("BYOK base model attaches only when the registry marks it vision-capable", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(resolveAgentImageTarget({ ...imageTarget, baseModelSupportsVision: true }), {
    attach: true,
    useVisionOverride: false,
  });
  assert.deepEqual(resolveAgentImageTarget(imageTarget), {
    attach: false,
    useVisionOverride: false,
  });
});

test("an unwired base provider never gets the image", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      baseProviderImageWired: false,
      isCloudAgent: true,
      baseModelSupportsVision: true,
    }),
    { attach: false, useVisionOverride: false }
  );
});

test("an active vision override wins over the base model", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideActive: true,
      visionProviderImageWired: true,
      baseModelSupportsVision: true,
    }),
    { attach: true, useVisionOverride: true }
  );
});

test("an active override lets a text-only base agent still get screen context", async () => {
  const { resolveAgentImageTarget } = await load();

  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideActive: true,
      visionProviderImageWired: true,
      baseProviderImageWired: false,
    }),
    { attach: true, useVisionOverride: true }
  );
});

test("an override on a provider that can't send images drops the screenshot", async () => {
  const { resolveAgentImageTarget } = await load();

  // The user pointed the override at a provider whose client has no image
  // path; quietly using the base model instead would ignore that choice.
  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideActive: true,
      visionProviderImageWired: false,
      isCloudAgent: true,
    }),
    { attach: false, useVisionOverride: false }
  );
});

test("an override toggled on but never configured falls back to the base rules", async () => {
  const { resolveAgentImageTarget } = await load();

  // Unconfigured, the vision scope just inherits the agent's own config, so
  // the base capability checks decide — never force an image onto a
  // text-only model.
  assert.deepEqual(
    resolveAgentImageTarget({
      ...imageTarget,
      visionOverrideActive: false,
      baseModelSupportsVision: true,
    }),
    { attach: true, useVisionOverride: false }
  );
  assert.deepEqual(resolveAgentImageTarget({ ...imageTarget, visionOverrideActive: false }), {
    attach: false,
    useVisionOverride: false,
  });
});

test("wake-word language follows the dictation language when it is explicit", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(
    resolveWakeWordLanguage({ preferredLanguage: "it", uiLanguage: "en" }, "fr"),
    "it"
  );
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "zh-CN", uiLanguage: "en" }), "zh-CN");
});

test("wake-word language uses detected speech before the UI language on auto", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "auto", uiLanguage: "it" }, "en"), "en");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "", uiLanguage: "en" }, "it"), "it");
});

test("wake-word language falls back to the UI language on auto or unset", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "auto", uiLanguage: "it" }), "it");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "", uiLanguage: "pt" }), "pt");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: "  ", uiLanguage: "de" }), "de");
  assert.equal(resolveWakeWordLanguage({ preferredLanguage: undefined, uiLanguage: "fr" }), "fr");
});

test("wake-word language is undefined when no usable hint exists", async () => {
  const { resolveWakeWordLanguage } = await load();

  assert.equal(
    resolveWakeWordLanguage({ preferredLanguage: "auto", uiLanguage: undefined }),
    undefined
  );
  assert.equal(resolveWakeWordLanguage({}), undefined);
});

test("lifecycle input kind prefers assistant, then translation, then dictation", async () => {
  const { resolveLifecycleInputKind } = await load();
  assert.equal(
    resolveLifecycleInputKind({ voiceAgentRequested: true, translationRequested: true }),
    "assistant"
  );
  assert.equal(
    resolveLifecycleInputKind({ voiceAgentRequested: false, translationRequested: true }),
    "translation"
  );
  assert.equal(resolveLifecycleInputKind({}), "dictation");
});
