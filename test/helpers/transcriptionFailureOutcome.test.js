const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionFailureOutcome.js");

test("a classified provider failure keeps its fields", async () => {
  const { transcriptionFailureOutcome } = await load();
  const error = Object.assign(new Error("Mistral rejected your API key."), {
    code: "PROVIDER_AUTH_FAILED",
    messageKey: "providerErrors.authFailed",
    messageParams: { provider: "Mistral" },
    settingsTarget: "speechToText",
    technicalDetails: { status: 401 },
    surface: "transcription",
  });
  const { report, keepAudio } = transcriptionFailureOutcome(error);
  assert.equal(keepAudio, true);
  assert.equal(report.code, "PROVIDER_AUTH_FAILED");
  assert.deepEqual(report.messageParams, { provider: "Mistral" });
  assert.equal(report.settingsTarget, "speechToText");
  assert.deepEqual(report.technicalDetails, { status: 401 });
  assert.equal(report.surface, "transcription");
});

test("an unclassified failure keeps today's description", async () => {
  const { transcriptionFailureOutcome } = await load();
  const { report } = transcriptionFailureOutcome(new Error("boom"));
  assert.equal(report.description, "Transcription failed: boom");
  assert.equal(report.title, "Transcription Error");
});
