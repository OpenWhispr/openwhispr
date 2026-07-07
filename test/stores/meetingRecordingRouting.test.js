const test = require("node:test");
const assert = require("node:assert/strict");

test("local meeting mode chooses local provider and model", async () => {
  const { resolveMeetingTranscriptionRoute } = await import(
    "../../src/stores/meetingRecordingRouting.ts"
  );

  const route = resolveMeetingTranscriptionRoute({
    isSignedIn: false,
    mode: "local",
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    whisperModel: "base",
    language: "en",
  });

  assert.equal(route.usable, true);
  assert.deepEqual(route.options, {
    provider: "local",
    localProvider: "nvidia",
    localModel: "parakeet-tdt-0.6b-v3",
    language: "en",
  });
});

test("BYOK Corti meeting mode uses Corti realtime when credentials exist", async () => {
  const { resolveMeetingTranscriptionRoute } = await import(
    "../../src/stores/meetingRecordingRouting.ts"
  );

  const route = resolveMeetingTranscriptionRoute({
    isSignedIn: false,
    mode: "providers",
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    selectedProviderId: "corti",
    cloudTranscriptionModel: "corti-transcribe",
    language: "en",
    cortiClientId: "client",
    cortiClientSecret: "secret",
    cortiEnvironment: "us",
    cortiTenant: "base",
    keyterms: ["OpenWhispr"],
  });

  assert.equal(route.usable, true);
  assert.equal(route.options.provider, "corti-realtime");
  assert.equal(route.options.mode, "byok");
  assert.equal(route.options.environment, "us");
  assert.deepEqual(route.options.keyterms, ["OpenWhispr"]);
});

test("OpenWhispr meeting mode signed out returns account required", async () => {
  const { resolveMeetingTranscriptionRoute } = await import(
    "../../src/stores/meetingRecordingRouting.ts"
  );

  const route = resolveMeetingTranscriptionRoute({
    isSignedIn: false,
    mode: "openwhispr",
    useLocalWhisper: false,
    cloudTranscriptionMode: "openwhispr",
    selectedProviderId: "openai",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    language: "en",
  });

  assert.equal(route.usable, false);
  assert.equal(route.reason, "account_required");
});

test("speaker diarization availability does not require hosted subscription", async () => {
  const { getMeetingDiarizationAvailability } = await import(
    "../../src/stores/meetingRecordingRouting.ts"
  );

  assert.deepEqual(
    getMeetingDiarizationAvailability({
      enabled: true,
      isSubscribed: false,
      isTrial: false,
    }),
    { available: true, reason: "local_available" }
  );
});
