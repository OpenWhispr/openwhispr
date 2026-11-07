const test = require("node:test");
const assert = require("node:assert/strict");

const { checkVoiceConversationReadiness } = require("../../src/helpers/voiceConversationReadiness");

const READY = {
  modelStatus: { ready: true, missing: [], missingBytes: 0 },
  recognizer: { engine: "parakeet", model: "parakeet-tdt-0.6b-v3" },
  language: "en",
  brain: { mode: "local", model: "qwen3.5-4b-q4_k_m", downloaded: true },
};

test("ready when models, speech model and a downloaded local brain are all present", () => {
  assert.deepEqual(checkVoiceConversationReadiness(READY), { ready: true });
});

test("every call language is accepted with a model that hears it", () => {
  for (const language of ["auto", "en", "hi", "es", "fr", "de"]) {
    assert.deepEqual(checkVoiceConversationReadiness({ ...READY, language }), { ready: true });
  }
});

test("a language the call doesn't offer is refused before anything else is checked", () => {
  const result = checkVoiceConversationReadiness({
    ...READY,
    language: "ja",
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

test("no speech model for the language is reported, naming whether any would do", () => {
  const without = (language) =>
    checkVoiceConversationReadiness({ ...READY, language, recognizer: null }).reason;
  assert.equal(without("en"), "speech-model-missing");
  assert.equal(without("auto"), "speech-model-missing");
  assert.equal(without("hi"), "language-model-missing");
  assert.equal(without("de"), "language-model-missing");
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
