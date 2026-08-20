const test = require("node:test");
const assert = require("node:assert/strict");

// Exhaustive settings-state × context matrix for dictation/notes realtime STT:
// which provider each state resolves to, the FULL session options object it
// sends over IPC (presence and absence), and the cross-boundary closure that
// every emittable provider id is accepted on the main-process side. #1624
// shipped because no test looked at the whole renderer→main contract: the
// openai-realtime path never sent `provider` and the token allowlist rejected
// undefined, while every per-module test stayed green.

const loadRouting = () => import("../../src/helpers/dictationStreamingRouting.js");
const loadTokens = () => import("../../src/helpers/realtimeTokenProviders.js");
const loadMeeting = () => import("../../src/helpers/meetingStreamingProviders.js");

// Keys of audioManager's STREAMING_PROVIDERS channel-binding table. audioManager
// imports window APIs so it can't load under node:test; this list is the
// renderer-side contract the resolver must stay within.
const RENDERER_STREAMING_PROVIDERS = [
  "deepgram",
  "assemblyai",
  "openai-realtime",
  "corti",
  "tinfoil-realtime",
];

// Providers that share the dictation-realtime-* IPC channels and therefore
// need a fetchRealtimeToken entry under exactly their renderer name.
const SHARED_CHANNEL_PROVIDERS = ["openai-realtime", "tinfoil-realtime"];

const SETTINGS_DEFAULTS = {
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-mini-transcribe",
  cloudTranscriptionMode: "openwhispr",
  cortiEnvironment: undefined,
  cortiTenant: undefined,
};

const settingsWith = (overrides) => ({ ...SETTINGS_DEFAULTS, ...overrides });

// [description, { settings, context, sttConfig }, expected provider name]
const RESOLUTION_MATRIX = [
  ["default config (the #1624 repro) resolves to openai-realtime", {}, "openai-realtime"],
  [
    "gpt-4o-transcribe also resolves to openai-realtime",
    { settings: settingsWith({ cloudTranscriptionModel: "gpt-4o-transcribe" }) },
    "openai-realtime",
  ],
  [
    "tinfoil provider wins regardless of model",
    { settings: settingsWith({ cloudTranscriptionProvider: "tinfoil" }) },
    "tinfoil-realtime",
  ],
  [
    "corti byok streams over corti's own channels",
    {
      settings: settingsWith({
        cloudTranscriptionProvider: "corti",
        cloudTranscriptionMode: "byok",
      }),
    },
    "corti",
  ],
  [
    "corti on openwhispr cloud is not corti streaming; realtime model still wins",
    { settings: settingsWith({ cloudTranscriptionProvider: "corti" }) },
    "openai-realtime",
  ],
  [
    "batch model in notes context defaults to deepgram",
    { settings: settingsWith({ cloudTranscriptionModel: "whisper-1" }), context: "notes" },
    "deepgram",
  ],
  [
    "batch model in dictation context defaults to openai-realtime",
    { settings: settingsWith({ cloudTranscriptionModel: "whisper-1" }) },
    "openai-realtime",
  ],
  [
    "server sttConfig picks the streaming provider for batch models",
    {
      settings: settingsWith({ cloudTranscriptionModel: "whisper-1" }),
      sttConfig: { streamingProvider: "assemblyai" },
    },
    "assemblyai",
  ],
];

for (const [
  name,
  { settings = settingsWith({}), context = "dictation", sttConfig = null },
  expected,
] of RESOLUTION_MATRIX) {
  test(`resolution: ${name}`, async () => {
    const { resolveStreamingProviderName } = await loadRouting();
    assert.equal(resolveStreamingProviderName({ settings, context, sttConfig }), expected);
  });
}

test("resolution: every matrix outcome is a renderer channel binding", async () => {
  const { resolveStreamingProviderName } = await loadRouting();
  for (const [
    ,
    { settings = settingsWith({}), context = "dictation", sttConfig = null },
  ] of RESOLUTION_MATRIX) {
    const name = resolveStreamingProviderName({ settings, context, sttConfig });
    assert.ok(
      RENDERER_STREAMING_PROVIDERS.includes(name),
      `resolver emitted "${name}", which has no STREAMING_PROVIDERS entry`
    );
  }
});

test("options: openai-realtime sends provider explicitly and no preview (#1624)", async () => {
  const { buildStreamingSessionOptions } = await loadRouting();
  const options = buildStreamingSessionOptions({
    providerName: "openai-realtime",
    settings: settingsWith({}),
    language: "en",
    keyterms: ["OpenWhispr"],
  });
  assert.deepEqual(options, {
    provider: "openai-realtime",
    sampleRate: 16000,
    language: "en",
    keyterms: ["OpenWhispr"],
    model: "gpt-4o-mini-transcribe",
    mode: "openwhispr",
    environment: undefined,
    tenant: undefined,
  });
});

test("options: tinfoil-realtime keeps its always-on preview (#1120)", async () => {
  const { buildStreamingSessionOptions } = await loadRouting();
  const options = buildStreamingSessionOptions({
    providerName: "tinfoil-realtime",
    settings: settingsWith({
      cloudTranscriptionProvider: "tinfoil",
      cloudTranscriptionModel: "kyutai-stt",
      cloudTranscriptionMode: "byok",
    }),
    language: "auto",
    keyterms: [],
  });
  assert.deepEqual(options, {
    provider: "tinfoil-realtime",
    sampleRate: 16000,
    language: undefined,
    keyterms: [],
    model: "kyutai-stt",
    mode: "byok",
    environment: undefined,
    tenant: undefined,
    preview: true,
  });
});

test("tinfoil realtime does not request the main-side preview for a voice-assistant recording", async () => {
  const { buildStreamingSessionOptions } = await loadRouting();
  const options = buildStreamingSessionOptions({
    providerName: "tinfoil-realtime",
    settings: { cloudTranscriptionModel: "m", cloudTranscriptionMode: "byok" },
    language: "en",
    keyterms: [],
    voiceAgentRequested: true,
  });
  assert.equal(options.preview, undefined);
});

test("options: corti carries environment and tenant; auto language is omitted", async () => {
  const { buildStreamingSessionOptions } = await loadRouting();
  const options = buildStreamingSessionOptions({
    providerName: "corti",
    settings: settingsWith({
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionModel: "corti-stt",
      cortiEnvironment: "eu",
      cortiTenant: "acme",
    }),
    language: "auto",
    keyterms: ["hba1c"],
  });
  assert.equal(options.provider, "corti");
  assert.equal(options.mode, "byok");
  assert.equal(options.environment, "eu");
  assert.equal(options.tenant, "acme");
  assert.equal(options.language, undefined);
});

test("options: provider is stamped for every renderer channel binding", async () => {
  const { buildStreamingSessionOptions } = await loadRouting();
  for (const providerName of RENDERER_STREAMING_PROVIDERS) {
    const options = buildStreamingSessionOptions({
      providerName,
      settings: settingsWith({}),
      language: "en",
      keyterms: [],
    });
    assert.equal(options.provider, providerName);
  }
});

test("closure: shared-channel dictation providers have token entries under their own names", async () => {
  const { REALTIME_TOKEN_PROVIDERS } = await loadTokens();
  for (const provider of SHARED_CHANNEL_PROVIDERS) {
    assert.equal(
      typeof REALTIME_TOKEN_PROVIDERS[provider],
      "function",
      `${provider} reaches fetchRealtimeToken but has no token entry`
    );
  }
});

test("closure: every allowed meeting provider has a token entry", async () => {
  const { REALTIME_TOKEN_PROVIDERS } = await loadTokens();
  const { ALLOWED_MEETING_PROVIDERS } = await loadMeeting();
  for (const provider of ALLOWED_MEETING_PROVIDERS) {
    if (provider === "local") continue;
    assert.equal(
      typeof REALTIME_TOKEN_PROVIDERS[provider],
      "function",
      `${provider} is meeting-allowed but has no token entry`
    );
  }
});
