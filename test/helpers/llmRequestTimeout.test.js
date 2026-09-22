const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/llmRequestTimeout.js");

test("non-streaming LLM requests use the fixed 30-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds(), 30);
  assert.equal(getLlmRequestTimeoutSeconds({ scope: "dictationCleanup" }), 30);
});

test("streaming LLM requests keep their fixed 60-second timeout", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(typeof getLlmRequestTimeoutSeconds, "function");
  assert.equal(getLlmRequestTimeoutSeconds({ streaming: true }), 60);
  // Streaming keeps its idle deadline whatever the scope: bytes are expected to flow.
  assert.equal(getLlmRequestTimeoutSeconds({ streaming: true, scope: "noteFormatting" }), 60);
});

test("note formatting gets a long deadline, since a whole transcript can take minutes to reason over", async () => {
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.equal(getLlmRequestTimeoutSeconds({ scope: "noteFormatting" }), 600);
});

test("a deadline error carries the timeout code and the seconds it waited", async () => {
  const { llmRequestTimeoutError, LLM_REQUEST_TIMEOUT_CODE } = await load();

  const error = llmRequestTimeoutError(30);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "Request timed out after 30s");
  assert.equal(error.code, LLM_REQUEST_TIMEOUT_CODE);
});

// Every scope has to say whether someone is sitting there waiting for the
// answer. The 1.10.1 note timeout came from a background task silently
// inheriting the deadline of the one interactive task the constant was written
// for; a scope added here without a verdict fails the test.
const DEADLINE_CLASS_BY_SCOPE = {
  dictationCleanup: "interactive", // user is waiting to paste
  dictationAgent: "interactive",
  dictationAgentVision: "interactive",
  dictationTranslation: "interactive",
  chatIntelligence: "interactive", // typed chat; streaming carries its own idle deadline
  noteFormatting: "background", // whole transcript, runs off-screen with a cancel button
};
const INTERACTIVE_MAX_SECONDS = 60;
const BACKGROUND_MIN_SECONDS = 300;

test("every inference scope is classified as interactive or background, and its deadline matches", async () => {
  const { INFERENCE_SCOPES } = await import("../../src/config/inferenceScopes.ts");
  const { getLlmRequestTimeoutSeconds } = await load();

  assert.deepEqual(
    Object.keys(INFERENCE_SCOPES).sort(),
    Object.keys(DEADLINE_CLASS_BY_SCOPE).sort(),
    "a new inference scope must be classified in DEADLINE_CLASS_BY_SCOPE: does a user wait on it?"
  );

  for (const [scope, kind] of Object.entries(DEADLINE_CLASS_BY_SCOPE)) {
    const seconds = getLlmRequestTimeoutSeconds({ scope });
    if (kind === "interactive") {
      assert.ok(
        seconds <= INTERACTIVE_MAX_SECONDS,
        `${scope}: someone is waiting, so its deadline must be at most ${INTERACTIVE_MAX_SECONDS}s (got ${seconds}s)`
      );
    } else {
      assert.ok(
        seconds >= BACKGROUND_MIN_SECONDS,
        `${scope}: a whole document goes through the model, so its deadline must be at least ${BACKGROUND_MIN_SECONDS}s (got ${seconds}s)`
      );
    }
  }
});
