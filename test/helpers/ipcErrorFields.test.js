const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/ipcErrorFields.js");

test("ipcErrorFields keeps every classified field and drops undefined ones", async () => {
  const { ipcErrorFields } = await load();
  const error = Object.assign(new Error("Mistral rejected your API key."), {
    code: "PROVIDER_AUTH_FAILED",
    messageKey: "providerErrors.authFailed",
    messageParams: { provider: "Mistral" },
    settingsTarget: "speechToText",
    technicalDetails: { provider: "Mistral", status: 401 },
    status: 401,
    surface: "transcription",
  });
  assert.deepEqual(ipcErrorFields(error), {
    error: "Mistral rejected your API key.",
    code: "PROVIDER_AUTH_FAILED",
    messageKey: "providerErrors.authFailed",
    messageParams: { provider: "Mistral" },
    settingsTarget: "speechToText",
    technicalDetails: { provider: "Mistral", status: 401 },
    status: 401,
    surface: "transcription",
  });
  assert.deepEqual(ipcErrorFields(new Error("plain")), { error: "plain" });
});

test("errorFromIpcResult rebuilds an Error with the same fields", async () => {
  const { ipcErrorFields, errorFromIpcResult } = await load();
  const original = Object.assign(new Error("x"), {
    code: "PROVIDER_UNAVAILABLE",
    messageKey: "providerErrors.unavailable",
    messageParams: { provider: "xAI" },
    technicalDetails: { status: 503 },
    status: 503,
    surface: "transcription",
  });
  const rebuilt = errorFromIpcResult(ipcErrorFields(original));
  assert.ok(rebuilt instanceof Error);
  assert.equal(rebuilt.message, "x");
  for (const key of ["code", "messageKey", "status", "surface"]) {
    assert.equal(rebuilt[key], original[key]);
  }
  assert.deepEqual(rebuilt.messageParams, original.messageParams);
  assert.deepEqual(rebuilt.technicalDetails, original.technicalDetails);
});
