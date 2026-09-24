const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPolicyResponseError,
  toPolicyFailure,
} = require("../../src/helpers/policyResponseError");

const load = () => import("../../src/helpers/transcriptionFallback.js");

test("signed-in OpenWhispr Cloud falls back to cloud", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: true,
    }),
    "cloud"
  );
});

test("signed-out OpenWhispr Cloud skips rather than diverting to a leftover BYOK provider", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: false,
    }),
    "skip"
  );
});

test("BYOK mode falls back to the user's own provider", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      isSignedIn: false,
    }),
    "byok"
  );
});

// A managed Orukeet session that the backend cannot or will not issue must
// start a batch recording instead of failing the dictation; denials the user
// has to act on keep surfacing.
const orukeetStart = (result) =>
  import("../../src/helpers/transcriptionFallback.js").then(({ resolveStreamingStartFallback }) =>
    resolveStreamingStartFallback({
      providerName: "orukeet",
      cloudTranscriptionMode: "openwhispr",
      result,
    })
  );

test("a disabled Orukeet rollout falls back to batch as feature_disabled", async () => {
  assert.equal(
    await orukeetStart({ success: false, code: "FEATURE_NOT_ENABLED", status: 403 }),
    "feature_disabled"
  );
});

test("a language exclusion keeps the feature_disabled batch fallback", async () => {
  // The start result the session route's 403 body becomes over IPC.
  const result = toPolicyFailure(
    createPolicyResponseError(
      403,
      {
        error: "Orukeet dictation is not enabled for this account",
        code: "FEATURE_NOT_ENABLED",
        reason: "language_unsupported",
      },
      "Orukeet session unavailable (403)"
    )
  );
  assert.equal(await orukeetStart(result), "feature_disabled");
});

test("an exhausted session mint window falls back to batch as rate_limited", async () => {
  assert.equal(
    await orukeetStart({ success: false, code: "RATE_LIMITED", status: 429 }),
    "rate_limited"
  );
});

test("an unavailable session service falls back to batch as session_unavailable", async () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(await orukeetStart({ success: false, status }), "session_unavailable", status);
  }
});

test("a start that fails without a denial to act on falls back instead of losing the dictation", async () => {
  const failures = [
    // Network error or the 10 s session request timeout.
    { success: false, code: "NETWORK_ERROR" },
    { success: false, error: "The operation was aborted due to timeout" },
    // WebSocket handshake failure or a rejected session body.
    { success: false, error: "Orukeet connection closed before completion" },
    { success: false, error: "Invalid Orukeet cloud session" },
    // A cookie-only session with no bearer for the managed route.
    { success: false, code: "AUTH_CONTEXT_UNVALIDATED", status: 0 },
    { success: false, status: 429 },
    { success: false },
  ];
  for (const result of failures) {
    assert.equal(await orukeetStart(result), "session_unavailable", JSON.stringify(result));
  }
});

test("denials the user must act on do not fall back", async () => {
  const denials = [
    { success: false, code: "AUTH_EXPIRED", status: 401 },
    { success: false, code: "AUTH_REQUIRED" },
    { success: false, code: "AUTH_CONTEXT_CHANGED", status: 0 },
    { success: false, code: "POLICY_MODE_BLOCKED", status: 403 },
    { success: false, code: "POLICY_UNRESOLVABLE", status: 403 },
    { success: false, code: "ACCOUNT_REQUIRED", status: 403 },
    { success: false, code: "UPGRADE_REQUIRED", status: 426, minAppVersion: "2.0.0" },
    { success: false, code: "LIMIT_REACHED", status: 429 },
  ];
  for (const result of denials) {
    assert.equal(await orukeetStart(result), null, JSON.stringify(result));
  }
});

test("only the managed Orukeet route falls back on session failures", async () => {
  const { resolveStreamingStartFallback } =
    await import("../../src/helpers/transcriptionFallback.js");
  const result = { success: false, status: 503 };
  assert.equal(
    resolveStreamingStartFallback({
      providerName: "orukeet",
      cloudTranscriptionMode: "byok",
      result,
    }),
    null
  );
  assert.equal(
    resolveStreamingStartFallback({
      providerName: "deepgram",
      cloudTranscriptionMode: "openwhispr",
      result,
    }),
    null
  );
});
