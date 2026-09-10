const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/helpers/meetingTranscriptionRouting.js");

// Sentinels this module throws, paired with the MEETING_ERROR_KEYS entry that
// MeetingRecordingMount looks up. A healed legacy profile can reach any of them,
// so an untranslated one would show a bare sentinel in the failure toast.
const SENTINEL_KEYS = {
  unsupportedSelfHosted: "unsupportedSelfHosted",
  unsupportedProvider: "unsupportedProvider",
  noProviderSelected: "noProviderSelected",
};

const byokProviders = [
  {
    id: "openai",
    models: [{ id: "gpt-4o-mini-transcribe" }, { id: "gpt-4o-transcribe" }],
  },
  { id: "corti", models: [{ id: "corti-transcribe" }] },
  { id: "tinfoil", models: [{ id: "voxtral-mini-4b-realtime" }] },
];

const baseOptions = {
  transcriptionMode: "providers",
  language: "en",
  localProvider: "whisper",
  whisperModel: "small",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  selectedProvider: "tinfoil",
  selectedModel: "voxtral-mini-4b-realtime",
  byokProviders,
  managedProviders: [
    {
      id: "assemblyai",
      models: [{ id: "universal-streaming", default: true }],
    },
  ],
  cortiEnvironment: "us",
  cortiTenant: "tenant",
  keyterms: ["OpenWhispr"],
};

test("providers mode routes Tinfoil through its realtime client", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(resolveMeetingTranscriptionOptions(baseOptions), {
    provider: "tinfoil-realtime",
    model: "voxtral-mini-4b-realtime",
    mode: "byok",
    language: "en",
  });
});

test("BYOK OpenAI never downgrades to managed cloud when its key is unavailable", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "openai",
      selectedModel: "gpt-4o-mini-transcribe",
    }),
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      mode: "byok",
      language: "en",
    }
  );
});

test("self-hosted mode never follows a stale Tinfoil provider", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.throws(
    () =>
      resolveMeetingTranscriptionOptions({
        ...baseOptions,
        transcriptionMode: "self-hosted",
      }),
    { message: "unsupportedSelfHosted" }
  );
});

test("local mode wins over stale cloud provider state", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "local",
      localProvider: "nvidia",
      parakeetModel: "nemotron-speech-streaming-en-0.6b",
    }),
    {
      provider: "local",
      localProvider: "nvidia",
      localModel: "nemotron-speech-streaming-en-0.6b",
      language: "en",
    }
  );
});

test("managed mode ignores stale BYOK state", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "openwhispr",
    }),
    {
      provider: "assemblyai-realtime",
      model: "universal-streaming",
      mode: "openwhispr",
      language: "en",
    }
  );
});

test("managed mode keeps its established OpenAI default before the catalog loads", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "openwhispr",
      managedProviders: null,
    }),
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      mode: "openwhispr",
      language: "en",
    }
  );
});

test("Corti keeps the meeting-specific connection settings", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "corti",
      selectedModel: "corti-transcribe",
    }),
    {
      provider: "corti-realtime",
      model: "corti-transcribe",
      mode: "byok",
      language: "en",
      environment: "us",
      tenant: "tenant",
      keyterms: ["OpenWhispr"],
    }
  );
});

test("unknown and custom providers fail closed", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  // Sentinels, translated at display time by MeetingRecordingMount. The named
  // provider rides after the colon so the toast can say which one failed.
  for (const [selectedProvider, message] of [
    ["custom", "unsupportedProvider:custom"],
    ["groq", "unsupportedProvider:groq"],
    ["", "noProviderSelected"],
    [undefined, "noProviderSelected"],
  ]) {
    assert.throws(
      () =>
        resolveMeetingTranscriptionOptions({
          ...baseOptions,
          selectedProvider,
        }),
      { message },
      `provider ${JSON.stringify(selectedProvider)}`
    );
  }
});

test("every thrown sentinel is translated and rendered by the mount", () => {
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  const mount = fs.readFileSync(
    path.join(__dirname, "../../src/components/MeetingRecordingMount.tsx"),
    "utf8"
  );

  for (const [sentinel, key] of Object.entries(SENTINEL_KEYS)) {
    assert.equal(
      typeof translation.notes.meeting[key],
      "string",
      `notes.meeting.${key} missing from en/translation.json`
    );
    assert.ok(
      mount.includes(`${sentinel}: "notes.meeting.${key}"`),
      `MEETING_ERROR_KEYS is missing ${sentinel}`
    );
  }

  // The provider sentinel carries its argument after a colon, so its copy has to
  // have somewhere to put it.
  assert.match(translation.notes.meeting.unsupportedProvider, /\{\{provider\}\}/);
});
