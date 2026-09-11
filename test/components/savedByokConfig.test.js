const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/savedByokConfig.ts");
const loadDefaultTranscriptionBase = async () =>
  (await import("../../src/config/constants.ts")).API_ENDPOINTS.TRANSCRIPTION_BASE;

const DRAFT_KEYS = ["baseUrl", "customModel", "selectedModel", "selectedProvider"];

// A fresh install: only store defaults, nothing the user configured.
const firstRun = async () => ({
  useLocalWhisper: false,
  transcriptionMode: "openwhispr",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-mini-transcribe",
  cloudTranscriptionBaseUrl: await loadDefaultTranscriptionBase(),
  remoteTranscriptionUrl: "",
  remoteTranscriptionModel: "",
  chatAgentMode: "openwhispr",
  chatAgentProvider: "groq",
  chatAgentModel: "openai/gpt-oss-120b",
  chatAgentRemoteUrl: "",
});

const CUSTOM_ENDPOINT = {
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
  cloudTranscriptionModel: "parasail-whisper",
};

test("a first run has nothing to reopen", async () => {
  const { resolveSavedByokConfig } = await load();
  const settings = await firstRun();
  assert.equal(resolveSavedByokConfig("byok-dictation", settings), null);
  assert.equal(resolveSavedByokConfig("byok-assistant", settings), null);
});

test("local, OpenWhispr Cloud and enterprise dictation reopen nothing", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();
  for (const settings of [
    // Settings writes cloudTranscriptionMode "byok" for Local too, so the provider
    // fields of a local user can look like a hosted setup.
    {
      ...base,
      transcriptionMode: "local",
      useLocalWhisper: true,
      cloudTranscriptionProvider: "groq",
    },
    { ...base, transcriptionMode: "providers", useLocalWhisper: true },
    { ...base, transcriptionMode: "openwhispr", ...CUSTOM_ENDPOINT },
    { ...base, transcriptionMode: "enterprise", ...CUSTOM_ENDPOINT },
  ]) {
    assert.equal(
      resolveSavedByokConfig("byok-dictation", settings),
      null,
      settings.transcriptionMode
    );
  }
});

test("a hosted dictation provider reopens with its model", async () => {
  const { resolveSavedByokConfig } = await load();
  const saved = resolveSavedByokConfig("byok-dictation", {
    ...(await firstRun()),
    transcriptionMode: "providers",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3-turbo",
  });
  assert.deepEqual(saved, {
    draft: {
      selectedProvider: "groq",
      selectedModel: "whisper-large-v3-turbo",
      baseUrl: "",
      customModel: "",
    },
    keyless: false,
  });
});

test("the Settings self-hosted server reopens as a key-less endpoint and wins over custom fields", async () => {
  const { resolveSavedByokConfig } = await load();
  const saved = resolveSavedByokConfig("byok-dictation", {
    ...(await firstRun()),
    ...CUSTOM_ENDPOINT,
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: " http://192.168.1.5:8178 ",
    remoteTranscriptionModel: "large-v3",
  });
  assert.deepEqual(saved, {
    draft: {
      selectedProvider: "",
      selectedModel: "",
      baseUrl: "http://192.168.1.5:8178",
      customModel: "large-v3",
    },
    keyless: true,
  });
});

test("a custom endpoint reopens under either mode it is filed under", async () => {
  const { resolveSavedByokConfig } = await load();
  for (const transcriptionMode of ["providers", "self-hosted"]) {
    const saved = resolveSavedByokConfig("byok-dictation", {
      ...(await firstRun()),
      ...CUSTOM_ENDPOINT,
      transcriptionMode,
    });
    assert.deepEqual(
      saved,
      {
        draft: {
          selectedProvider: "",
          selectedModel: "",
          baseUrl: "https://stt.example.com/v1",
          customModel: "parasail-whisper",
        },
        keyless: false,
      },
      transcriptionMode
    );
  }
});

test("an unconfigured custom endpoint reopens nothing", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();
  for (const cloudTranscriptionBaseUrl of ["", "  ", base.cloudTranscriptionBaseUrl]) {
    const saved = resolveSavedByokConfig("byok-dictation", {
      ...base,
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(saved, null, JSON.stringify(cloudTranscriptionBaseUrl));
  }
});

test("self-hosted mode without a URL or custom provider reopens nothing", async () => {
  const { resolveSavedByokConfig } = await load();
  const saved = resolveSavedByokConfig("byok-dictation", {
    ...(await firstRun()),
    transcriptionMode: "self-hosted",
    cloudTranscriptionProvider: "groq",
  });
  assert.equal(saved, null);
});

test("the assistant reopens its self-hosted endpoint or hosted provider", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();

  assert.deepEqual(
    resolveSavedByokConfig("byok-assistant", {
      ...base,
      chatAgentMode: "self-hosted",
      chatAgentRemoteUrl: " http://127.0.0.1:1234/v1 ",
      chatAgentModel: "llm-proxy-test",
    }),
    {
      draft: {
        selectedProvider: "",
        selectedModel: "",
        baseUrl: "http://127.0.0.1:1234/v1",
        customModel: "llm-proxy-test",
      },
      keyless: false,
    }
  );
  assert.deepEqual(
    resolveSavedByokConfig("byok-assistant", {
      ...base,
      chatAgentMode: "providers",
      chatAgentProvider: "anthropic",
      chatAgentModel: "claude-sonnet-5",
    }),
    {
      draft: {
        selectedProvider: "anthropic",
        selectedModel: "claude-sonnet-5",
        baseUrl: "",
        customModel: "",
      },
      keyless: false,
    }
  );
});

test("the assistant reopens nothing it could not save back", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();
  for (const settings of [
    { ...base, chatAgentMode: "self-hosted", chatAgentRemoteUrl: "" },
    { ...base, chatAgentMode: "providers", chatAgentProvider: "custom" },
    { ...base, chatAgentMode: "openwhispr" },
    { ...base, chatAgentMode: "local", chatAgentProvider: "qwen" },
  ]) {
    assert.equal(resolveSavedByokConfig("byok-assistant", settings), null, settings.chatAgentMode);
  }
});

test("a reopened draft only carries the four session fields", async () => {
  const { resolveSavedByokConfig } = await load();
  const base = await firstRun();
  for (const [stepId, settings] of [
    [
      "byok-dictation",
      { ...base, transcriptionMode: "providers", cloudTranscriptionProvider: "groq" },
    ],
    ["byok-dictation", { ...base, ...CUSTOM_ENDPOINT, transcriptionMode: "providers" }],
    [
      "byok-assistant",
      { ...base, chatAgentMode: "self-hosted", chatAgentRemoteUrl: "http://x/v1" },
    ],
  ]) {
    assert.deepEqual(
      Object.keys(resolveSavedByokConfig(stepId, settings).draft).sort(),
      DRAFT_KEYS
    );
  }
});

test("a draft is blank only when every field is empty", async () => {
  const { isBlankByokDraft } = await load();
  const blank = { selectedProvider: "", selectedModel: "", baseUrl: "", customModel: "" };
  assert.equal(isBlankByokDraft(blank), true);
  for (const field of DRAFT_KEYS) {
    assert.equal(isBlankByokDraft({ ...blank, [field]: "x" }), false, field);
  }
});

test("only a key-less self-hosted endpoint is mirrored into remoteTranscriptionUrl", async () => {
  const { selfHostedRemoteTranscriptionUrl } = await load();
  const url = "http://127.0.0.1:8791/v1";
  assert.equal(selfHostedRemoteTranscriptionUrl(url, ""), url);
  assert.equal(selfHostedRemoteTranscriptionUrl(url, "   "), url);
  assert.equal(selfHostedRemoteTranscriptionUrl(url, "sk-proxy"), "");
});
