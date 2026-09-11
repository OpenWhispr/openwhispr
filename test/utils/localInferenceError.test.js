const test = require("node:test");
const assert = require("node:assert/strict");

let errors;

test.before(async () => {
  errors = await import("../../src/utils/localInferenceError.ts");
});

// The local path is the only one that can fail because the machine is too
// small for the request. Before #2142 that surfaced as a raw llama.cpp JSON
// body in a toast; this is where it becomes something a person can act on.

test("a context overflow becomes a translatable message naming the model and the numbers", () => {
  const error = errors.buildLocalInferenceError({
    error: "This content needs about 21538 tokens of context, but Qwen3.5 9B can only use 16384.",
    code: "CONTEXT_TOO_LARGE",
    details: {
      modelName: "Qwen3.5 9B",
      neededTokens: 21538,
      maxContextTokens: 16384,
    },
  });

  assert.equal(error.code, "CONTEXT_TOO_LARGE");
  assert.equal(error.messageKey, "models.errors.contextTooLarge");
  assert.deepEqual(error.messageParams, { model: "Qwen3.5 9B", needed: 21538, max: 16384 });
});

test("a context overflow without numbers still gets a translatable message", () => {
  // The reactive path: llama-server rejected the prompt and we only know which
  // model it was.
  const error = errors.buildLocalInferenceError({
    error: "The request is longer than the context this model is running with.",
    code: "CONTEXT_TOO_LARGE",
    details: { modelName: "Gemma 3 4B" },
  });

  assert.equal(error.messageKey, "models.errors.contextTooLargeGeneric");
  assert.deepEqual(error.messageParams, { model: "Gemma 3 4B" });
});

test("unrelated failures keep their message and gain no translation", () => {
  const error = errors.buildLocalInferenceError({
    error: "Model qwen3-8b is not downloaded or is corrupted",
    code: "MODEL_NOT_DOWNLOADED",
  });

  assert.equal(error.message, "Model qwen3-8b is not downloaded or is corrupted");
  assert.equal(error.messageKey, undefined);
  assert.equal(error.code, "MODEL_NOT_DOWNLOADED");
});

test("a failure with no information at all still produces a usable Error", () => {
  const error = errors.buildLocalInferenceError({});

  assert.ok(error instanceof Error);
  assert.ok(error.message.length > 0);
});

test("no llama.cpp JSON can reach the message", () => {
  // The literal regression: a JSON body used to be concatenated into the
  // message and shown to the customer.
  const error = errors.buildLocalInferenceError({
    error: 'llama-server returned status 400: {"error":{"code":400,"n_ctx":16384}}',
    code: "CONTEXT_TOO_LARGE",
    details: { modelName: "Llama 3.2 3B", neededTokens: 20000, maxContextTokens: 16384 },
  });

  // The raw text is kept for logs, but the UI renders the key, which has no
  // JSON in it.
  assert.equal(error.messageKey, "models.errors.contextTooLarge");
});

test("a server that will not start becomes a translatable message, not llama.cpp output", () => {
  const error = errors.buildLocalInferenceError({
    error: "Qwen3.5 9B could not be started on this computer.",
    code: "LOCAL_SERVER_UNAVAILABLE",
    details: {
      modelName: "Qwen3.5 9B",
      error: "llama-server process died during startup\nProcess output: ggml_metal: failed",
    },
  });

  assert.equal(error.messageKey, "models.errors.localServerUnavailable");
  assert.deepEqual(error.messageParams, { model: "Qwen3.5 9B" });
  assert.ok(!error.message.includes("Process output"));
});
