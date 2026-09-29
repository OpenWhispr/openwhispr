const test = require("node:test");
const assert = require("node:assert/strict");

const { checkVoiceConversationReadiness } = require("../../src/helpers/voiceConversationReadiness");

const READY = {
  modelStatus: { ready: true, missing: [], missingBytes: 0 },
  speechModelDownloaded: true,
  language: "en",
  brain: { mode: "local", model: "qwen3.5-4b-q4_k_m", downloaded: true },
};

test("ready when models, speech model and a downloaded local brain are all present", () => {
  assert.deepEqual(checkVoiceConversationReadiness(READY), { ready: true });
});

test("auto language is accepted as English", () => {
  assert.deepEqual(checkVoiceConversationReadiness({ ...READY, language: "auto" }), {
    ready: true,
  });
});

test("a non-English language is refused before anything else is checked", () => {
  const result = checkVoiceConversationReadiness({
    ...READY,
    language: "de",
    modelStatus: { ready: false, missing: ["vad"], missingBytes: 650_000 },
  });
  assert.deepEqual(result, { ready: false, reason: "language-unsupported" });
});

test("missing voice models report which ones and how much to download", () => {
  const result = checkVoiceConversationReadiness({
    ...READY,
    modelStatus: { ready: false, missing: ["supertonic-tts"], missingBytes: 128_800_000 },
  });
  assert.deepEqual(result, {
    ready: false,
    reason: "voice-models-missing",
    missing: ["supertonic-tts"],
    missingBytes: 128_800_000,
  });
});

test("a missing Parakeet model is reported", () => {
  assert.deepEqual(checkVoiceConversationReadiness({ ...READY, speechModelDownloaded: false }), {
    ready: false,
    reason: "speech-model-missing",
  });
});

test("a local brain that is not downloaded is reported; cloud brains need no download", () => {
  const localMissing = {
    ...READY,
    brain: { mode: "local", model: "qwen3.5-4b-q4_k_m", downloaded: false },
  };
  assert.deepEqual(checkVoiceConversationReadiness(localMissing), {
    ready: false,
    reason: "brain-not-downloaded",
  });
  const cloud = {
    ...READY,
    brain: { mode: "openwhispr", model: "", downloaded: false, signedIn: true },
  };
  assert.deepEqual(checkVoiceConversationReadiness(cloud), { ready: true });
});

test("an OpenWhispr Cloud brain needs the user signed in", () => {
  const cloud = { mode: "openwhispr", model: "", downloaded: false };
  assert.deepEqual(
    checkVoiceConversationReadiness({ ...READY, brain: { ...cloud, signedIn: false } }),
    { ready: false, reason: "brain-sign-in-required" }
  );
  assert.deepEqual(
    checkVoiceConversationReadiness({ ...READY, brain: { ...cloud, signedIn: true } }),
    { ready: true }
  );
});

test("a voice conversation won't start over a meeting recording", () => {
  assert.deepEqual(checkVoiceConversationReadiness({ ...READY, meetingRecording: true }), {
    ready: false,
    reason: "meeting-recording",
  });
});

test("a BYOK brain whose API key is missing is refused before the session starts", () => {
  const byok = { mode: "providers", model: "gpt-5-mini", downloaded: false };
  assert.deepEqual(
    checkVoiceConversationReadiness({ ...READY, brain: { ...byok, keyMissing: true } }),
    { ready: false, reason: "brain-key-missing" }
  );
  assert.deepEqual(
    checkVoiceConversationReadiness({ ...READY, brain: { ...byok, keyMissing: false } }),
    { ready: true }
  );
});
