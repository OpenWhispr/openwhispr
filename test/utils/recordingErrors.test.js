const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/recordingErrors.ts");
const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);

test("a classified provider failure gets the surface title and translated description", async () => {
  const { getRecordingErrorTitle, getRecordingErrorDescription } = await load();
  const report = {
    title: "Transcription Error",
    description: "Mistral rejected your API key.",
    code: "PROVIDER_AUTH_FAILED",
    surface: "transcription",
    messageKey: "providerErrors.authFailed",
    messageParams: { provider: "Mistral" },
  };
  assert.equal(getRecordingErrorTitle(report, t), "providerErrors.titles.transcription");
  assert.equal(getRecordingErrorDescription(report, t), 'providerErrors.authFailed|{"provider":"Mistral"}');
});

test("the rate-limit title is unchanged", async () => {
  const { getRecordingErrorTitle } = await load();
  assert.equal(
    getRecordingErrorTitle({ title: "x", code: "PROVIDER_RATE_LIMITED" }, t),
    "hooks.audioRecording.errorTitles.providerRateLimited"
  );
});

test("unclassified reports keep their own title and description", async () => {
  const { getRecordingErrorTitle, getRecordingErrorDescription } = await load();
  const report = { title: "Transcription Error", description: "Transcription failed: boom" };
  assert.equal(getRecordingErrorTitle(report, t), "Transcription Error");
  assert.equal(getRecordingErrorDescription(report, t), "Transcription failed: boom");
});
