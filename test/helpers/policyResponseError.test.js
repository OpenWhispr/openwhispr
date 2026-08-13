const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPolicyResponseError,
  readPolicyResponseError,
  toPolicyFailure,
} = require("../../src/helpers/policyResponseError");

test("preserves policy denial code, status, details, and minimum version", async () => {
  for (const [status, code] of [
    [403, "POLICY_TRANSCRIPTION_BLOCKED"],
    [426, "UPGRADE_REQUIRED"],
  ]) {
    const response = new Response(
      JSON.stringify({
        error: "Request blocked by workspace policy",
        code,
        data: { minAppVersion: "2.0.0", action: "transcription" },
      }),
      { status }
    );
    const error = await readPolicyResponseError(response, "Request failed");

    assert.deepEqual(toPolicyFailure(error), {
      success: false,
      error: "Request blocked by workspace policy",
      code,
      status,
      minAppVersion: "2.0.0",
      details: { minAppVersion: "2.0.0", action: "transcription" },
    });
  }
});

test("normalizes parsed multipart policy errors without losing legacy statusCode", () => {
  const error = createPolicyResponseError(
    426,
    { error: { message: "Update OpenWhispr" }, code: "UPGRADE_REQUIRED", minAppVersion: "2.1.0" },
    "Transcription failed"
  );

  assert.equal(error.message, "Update OpenWhispr");
  assert.equal(error.code, "UPGRADE_REQUIRED");
  assert.equal(error.status, 426);
  assert.equal(error.statusCode, 426);
  assert.equal(error.minAppVersion, "2.1.0");
});
